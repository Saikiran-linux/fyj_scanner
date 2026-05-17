/**
 * ATS provider adapters.
 *
 * Each provider exports:
 *   - probeUrl(slug)  → string
 *   - careersUrl(slug) → string
 *   - parse(json) → [{ external_id, title, location, url, department, employment_type, description }]
 *   - fallbackUrl(slug) → string | null   (used on a 404 from probeUrl)
 *
 * Optional:
 *   - accept   → Accept header (default 'application/json')
 *   - extract(text) → unknown   (default JSON.parse(text); pulled JSON is then
 *                                fed into parse() unchanged)
 *   - fetchDescription(slug, externalId, opts) → Promise<{ description, http_status, latency_ms, error }>
 *     Per-job description fetch, used by the scanner's description pass for
 *     providers whose listing endpoint doesn't carry descriptions
 *     (SmartRecruiters). Providers that include descriptions inline in the
 *     listing don't need this — `parse()` populates `description` directly.
 *
 * `description` is plain text (HTML stripped via html-to-text.mjs). null
 * means "not available from this provider's listing" — the description
 * pass may try fetchDescription() if the provider has one.
 *
 * Returning [] from parse() is "valid response, zero jobs" — distinct from a
 * thrown error, and useful viability signal (inactive tenant).
 */

import { htmlToText } from './html-to-text.mjs';

// Per-job description fetches need a real-looking UA for the same reason
// the listing fetches do (Ashby/SmartRecruiters block blank/curl UAs).
const DESCRIPTION_FETCH_HEADERS = {
  Accept: 'application/json',
  'User-Agent': 'Mozilla/5.0 (compatible; fyj-scanner/0.2; +https://github.com/Saikiran-linux/fyj_scanner)',
  'Accept-Encoding': 'gzip, deflate, br',
};

async function fetchJson(url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const startedAt = Date.now();
  try {
    const res = await fetch(url, { signal: controller.signal, headers: DESCRIPTION_FETCH_HEADERS });
    const latency_ms = Date.now() - startedAt;
    if (!res.ok) return { ok: false, http_status: res.status, latency_ms, error: `HTTP ${res.status}` };
    const text = await res.text();
    try {
      return { ok: true, http_status: res.status, latency_ms, json: JSON.parse(text) };
    } catch {
      return { ok: false, http_status: res.status, latency_ms, error: 'invalid_json' };
    }
  } catch (e) {
    return {
      ok: false,
      http_status: null,
      latency_ms: Date.now() - startedAt,
      error: e.name === 'AbortError' ? 'timeout' : e.message,
    };
  } finally {
    clearTimeout(timer);
  }
}

export const PROVIDERS = {
  greenhouse: {
    // ?content=true ships full job descriptions in the listing response,
    // saving us N per-job fetches per company. Responses are bigger (5-50KB
    // per company instead of ~5KB) but still well under any limit, and the
    // round-trip count stays at 1 per scan.
    probeUrl: (slug) => `https://boards-api.greenhouse.io/v1/boards/${slug}/jobs?content=true`,
    careersUrl: (slug) => `https://job-boards.greenhouse.io/${slug}`,
    // Some tenants only resolve on the alternate hostname. If the primary
    // returns 404, the scanner retries with this URL once.
    fallbackUrl: (slug) => `https://boards-api.greenhouse.io/v1/boards/${slug}/jobs?content=true`,
    parse(json) {
      return (json?.jobs || []).map((j) => ({
        external_id: String(j.id),
        title: j.title || '',
        location: j.location?.name || '',
        url: j.absolute_url || '',
        department: (j.departments?.[0]?.name) || null,
        employment_type: null,
        description: j.content ? htmlToText(j.content) : null,
      }));
    },
  },

  ashby: {
    probeUrl: (slug) => `https://api.ashbyhq.com/posting-api/job-board/${slug}?includeCompensation=true`,
    careersUrl: (slug) => `https://jobs.ashbyhq.com/${slug}`,
    fallbackUrl: () => null,
    parse(json) {
      return (json?.jobs || []).map((j) => ({
        external_id: String(j.id),
        title: j.title || '',
        location: j.location || '',
        url: j.jobUrl || '',
        department: j.department || null,
        employment_type: j.employmentType || null,
        // Ashby includes descriptionPlain in the public posting API. Fall
        // back to stripping HTML if only the HTML form is present.
        description: j.descriptionPlain || (j.descriptionHtml ? htmlToText(j.descriptionHtml) : null),
      }));
    },
  },

  lever: {
    probeUrl: (slug) => `https://api.lever.co/v0/postings/${slug}?mode=json`,
    careersUrl: (slug) => `https://jobs.lever.co/${slug}`,
    fallbackUrl: () => null,
    parse(json) {
      if (!Array.isArray(json)) return [];
      return json.map((j) => {
        // Lever's posting has descriptionPlain (already stripped) plus a
        // `lists` array (responsibilities, requirements, …). Concatenate
        // them for a more complete embedding input.
        const desc = [j.descriptionPlain || (j.description ? htmlToText(j.description) : '')];
        if (Array.isArray(j.lists)) {
          for (const list of j.lists) {
            if (list?.text) desc.push(htmlToText(list.text));
            if (list?.content) desc.push(htmlToText(list.content));
          }
        }
        const description = desc.filter(Boolean).join('\n\n') || null;
        return {
          external_id: String(j.id || j.lever_id || ''),
          title: j.text || '',
          location: j.categories?.location || '',
          url: j.hostedUrl || j.applyUrl || '',
          department: j.categories?.department || null,
          employment_type: j.categories?.commitment || null,
          description,
        };
      });
    },
  },

  smartrecruiters: {
    probeUrl: (slug) => `https://api.smartrecruiters.com/v1/companies/${slug}/postings`,
    careersUrl: (slug) => `https://careers.smartrecruiters.com/${slug}`,
    fallbackUrl: () => null,
    parse(json) {
      return (json?.content || []).map((j) => ({
        external_id: String(j.id || j.uuid || ''),
        title: j.name || '',
        location: [j.location?.city, j.location?.country].filter(Boolean).join(', '),
        url: j.ref || `https://careers.smartrecruiters.com/${j.companyName}/${j.id}`,
        department: j.department?.label || null,
        employment_type: j.typeOfEmployment?.label || null,
        // The listing endpoint has summaries only; the description pass
        // calls fetchDescription() below for each row.
        description: null,
      }));
    },
    // Per-job fetch: hits /v1/companies/{slug}/postings/{id} and pulls the
    // jobAd.sections.* blocks (jobDescription, qualifications, responsibilities,
    // additionalInformation). Each section has a `text` field with HTML.
    async fetchDescription(slug, externalId, { timeoutMs = 15_000 } = {}) {
      const url = `https://api.smartrecruiters.com/v1/companies/${slug}/postings/${externalId}`;
      const res = await fetchJson(url, timeoutMs);
      if (!res.ok) return res;
      const sections = res.json?.jobAd?.sections || {};
      const parts = [];
      for (const key of ['jobDescription', 'responsibilities', 'qualifications', 'additionalInformation']) {
        const text = sections[key]?.text;
        if (text) parts.push(htmlToText(text));
      }
      return {
        ok: true,
        http_status: res.http_status,
        latency_ms: res.latency_ms,
        description: parts.join('\n\n') || null,
      };
    },
  },

  // YC's Work at a Startup has no public JSON API (confirmed via the YC HN
  // thread asking exactly that). The company page is server-rendered with
  // Inertia.js, which embeds the full props payload — including jobs[] — on a
  // <div data-page="..."> attribute. We fetch the HTML, pull that one
  // attribute, decode it, and parse() the inner JSON like any other provider.
  // Slug accepts either the human form ("dots-2") or the numeric YC ID
  // ("13519") — the URL `/companies/{slug}` resolves both.
  workatastartup: {
    probeUrl: (slug) => `https://www.workatastartup.com/companies/${slug}`,
    careersUrl: (slug) => `https://www.workatastartup.com/companies/${slug}`,
    fallbackUrl: () => null,
    accept: 'text/html',
    extract(text) {
      const m = text.match(/data-page="([^"]+)"/);
      if (!m) throw new Error('no data-page attribute');
      // Decode the five entities Rails' html_safe escaper emits. Order matters:
      // &amp; must come last so a literal `&amp;quot;` in the source doesn't
      // get re-decoded into `"`.
      const decoded = m[1]
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&amp;/g, '&');
      return JSON.parse(decoded);
    },
    parse(json) {
      const jobs = json?.props?.company?.jobs;
      if (!Array.isArray(jobs)) return [];
      // The company page bundles each job with its full description (markdown
      // or HTML depending on how the founder wrote it). Field names vary —
      // `description`, `description_html`, `details` — so we try the common
      // ones in order. htmlToText() is safe to call on plain markdown too.
      return jobs.map((j) => {
        const raw = j.description_html || j.descriptionHtml || j.description || j.details || j.body || null;
        return {
          external_id: String(j.id),
          title: j.title || '',
          location: j.location || '',
          url: j.id ? `https://www.workatastartup.com/jobs/${j.id}` : '',
          department: null,
          employment_type: j.jobType || null,
          description: raw ? htmlToText(raw) : null,
        };
      });
    },
  },
};

export const PROVIDER_NAMES = Object.keys(PROVIDERS);

// Classify HTTP outcomes for the rate-limiter's adaptive policy.
// "block" = the source actively refused us (will keep refusing without backoff).
// "error" = transport/server issue (retry later, but not a blocking signal).
function classify(httpStatus, errorString) {
  if (httpStatus >= 200 && httpStatus < 300) return 'ok';
  if (httpStatus === 403 || httpStatus === 429) return 'block';
  return 'error';
}

export async function fetchJobs(ats, slug, { timeoutMs = 15_000, limiter = null } = {}) {
  const provider = PROVIDERS[ats];
  if (!provider) throw new Error(`Unknown ATS: ${ats}`);

  const release = limiter ? await limiter.acquire(ats) : () => {};

  let firstResult;
  try {
    firstResult = await doFetch(provider.probeUrl(slug), timeoutMs, provider);
  } catch (e) {
    release('error');
    throw e;
  }

  // Honour Retry-After on 429 by sleeping (the limiter will also adapt).
  if (firstResult.http_status === 429 && firstResult.retry_after_s) {
    const ms = Math.min(firstResult.retry_after_s * 1000, 30_000);
    await new Promise((r) => setTimeout(r, ms));
  }

  if (firstResult.ok) {
    const parsed = safeParse(firstResult.json, provider);
    release('ok');
    return { ...firstResult, jobs: parsed, schema_ok: parsed !== null };
  }

  // 404 → try fallback URL once if the provider offers one. Re-acquire so we
  // don't blow past the rate budget.
  if (firstResult.http_status === 404) {
    const fallback = provider.fallbackUrl(slug);
    if (fallback) {
      release(classify(firstResult.http_status));
      const release2 = limiter ? await limiter.acquire(ats) : () => {};
      let second;
      try {
        second = await doFetch(fallback, timeoutMs, provider);
      } catch (e) {
        release2('error');
        throw e;
      }
      if (second.ok) {
        const parsed = safeParse(second.json, provider);
        release2('ok');
        return { ...second, jobs: parsed, schema_ok: parsed !== null, used_fallback: true };
      }
      release2(classify(second.http_status));
      return { ...second, used_fallback: true };
    }
  }

  release(classify(firstResult.http_status, firstResult.error));
  return firstResult;
}

function safeParse(json, provider) {
  try {
    return provider.parse(json);
  } catch {
    return null;
  }
}

// Whether a provider can fetch a per-job description (vs. only what's in the
// listing). Used by the scanner's description pass to skip providers whose
// listings already cover descriptions.
export function hasDescriptionFetcher(ats) {
  return typeof PROVIDERS[ats]?.fetchDescription === 'function';
}

/**
 * Fetch a single job's description, going through the rate limiter so we
 * don't blow past the per-provider budget. Returns the same shape as the
 * provider's fetchDescription() plus a `classified` outcome label.
 *
 * Callers should treat any non-ok result as "skip this row for now" — the
 * row will be retried on the next scan / backfill pass.
 */
export async function fetchJobDescription(ats, slug, externalId, { timeoutMs = 15_000, limiter = null } = {}) {
  const provider = PROVIDERS[ats];
  if (!provider) throw new Error(`Unknown ATS: ${ats}`);
  if (!provider.fetchDescription) {
    return { ok: false, error: 'no_per_job_fetcher', http_status: null, latency_ms: 0 };
  }
  const release = limiter ? await limiter.acquire(ats) : () => {};
  try {
    const res = await provider.fetchDescription(slug, externalId, { timeoutMs });
    if (res.http_status === 429 && res.retry_after_s) {
      const ms = Math.min(res.retry_after_s * 1000, 30_000);
      await new Promise((r) => setTimeout(r, ms));
    }
    release(classify(res.http_status, res.error));
    return res;
  } catch (e) {
    release('error');
    throw e;
  }
}

async function doFetch(url, timeoutMs, provider) {
  const accept = provider?.accept || 'application/json';
  const extract = provider?.extract || ((text) => JSON.parse(text));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const startedAt = Date.now();
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        Accept: accept,
        // Polite UA with contact path. Some providers (Ashby) treat blank/curl
        // UAs as bots → 403. A real-looking UA + project URL dropped Ashby's
        // 403 rate sharply in tests.
        'User-Agent': 'Mozilla/5.0 (compatible; fyj-scanner/0.2; +https://github.com/Saikiran-linux/fyj_scanner)',
        'Accept-Encoding': 'gzip, deflate, br',
      },
    });
    const latency_ms = Date.now() - startedAt;
    const retry_after_s = (() => {
      const ra = res.headers.get('retry-after');
      if (!ra) return null;
      const n = Number(ra);
      return Number.isFinite(n) ? n : null;
    })();
    if (!res.ok) {
      return {
        ok: false,
        http_status: res.status,
        latency_ms,
        error: `HTTP ${res.status}`,
        url,
        retry_after_s,
      };
    }
    const text = await res.text();
    let json;
    try {
      json = extract(text);
    } catch {
      return { ok: false, http_status: res.status, latency_ms, error: 'invalid_json', url };
    }
    return { ok: true, http_status: res.status, latency_ms, json, url };
  } catch (e) {
    return {
      ok: false,
      http_status: null,
      latency_ms: Date.now() - startedAt,
      error: e.name === 'AbortError' ? 'timeout' : e.message,
      url,
    };
  } finally {
    clearTimeout(timer);
  }
}
