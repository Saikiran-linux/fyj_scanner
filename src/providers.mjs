/**
 * ATS provider adapters.
 *
 * Each provider exports:
 *   - probeUrl(slug)  → string
 *   - careersUrl(slug) → string
 *   - parse(json) → [{ external_id, title, location, url, department, employment_type }]
 *   - fallbackUrl(slug) → string | null   (used on a 404 from probeUrl)
 *
 * Optional, for non-JSON sources (e.g. server-rendered HTML pages):
 *   - accept   → Accept header (default 'application/json')
 *   - extract(text) → unknown   (default JSON.parse(text); pulled JSON is then
 *                                fed into parse() unchanged)
 *
 * Returning [] from parse() is "valid response, zero jobs" — distinct from a
 * thrown error, and useful viability signal (inactive tenant).
 */

export const PROVIDERS = {
  greenhouse: {
    probeUrl: (slug) => `https://boards-api.greenhouse.io/v1/boards/${slug}/jobs`,
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
      }));
    },
  },

  lever: {
    probeUrl: (slug) => `https://api.lever.co/v0/postings/${slug}?mode=json`,
    careersUrl: (slug) => `https://jobs.lever.co/${slug}`,
    fallbackUrl: () => null,
    parse(json) {
      if (!Array.isArray(json)) return [];
      return json.map((j) => ({
        external_id: String(j.id || j.lever_id || ''),
        title: j.text || '',
        location: j.categories?.location || '',
        url: j.hostedUrl || j.applyUrl || '',
        department: j.categories?.department || null,
        employment_type: j.categories?.commitment || null,
      }));
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
      }));
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
      return jobs.map((j) => ({
        external_id: String(j.id),
        title: j.title || '',
        location: j.location || '',
        url: j.id ? `https://www.workatastartup.com/jobs/${j.id}` : '',
        department: null,
        employment_type: j.jobType || null,
      }));
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
