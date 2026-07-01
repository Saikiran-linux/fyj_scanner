/**
 * ATS provider adapters.
 *
 * Each provider exports:
 *   - probeUrl(slug)  → string
 *   - careersUrl(slug) → string
 *   - parse(json) → [{ external_id, title, location, url, department,
 *                      employment_type, description,
 *                      comp_min, comp_max, comp_currency, comp_interval, comp_text,
 *                      remote, source_updated_at, source_published_at }]
 *     The comp_*, remote, and source_* fields are best-effort — providers vary
 *     in what they expose. Always include the keys; set to null when missing
 *     so the scanner's upsert clears stale data on row reappearance.
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

import { htmlToText, normaliseWhitespace } from './html-to-text.mjs';

// ── shared helpers for the optional comp/remote/timestamp fields ───────
//
// These keep each provider's parse() free of normalisation boilerplate.

const REMOTE_VALUES = new Set(['remote', 'hybrid', 'onsite']);

/**
 * Normalise a provider's "where can this be done" signal to one of
 * 'remote' | 'hybrid' | 'onsite' | null. Pass any combination of:
 *   - explicit: provider's structured flag (lever workplaceType, ashby isRemote, …)
 *   - locationStr: the free-text location, used as a fallback heuristic.
 *
 * The heuristic is intentionally narrow ("remote" / "hybrid" tokens in the
 * location string) — we'd rather return null than mislabel.
 */
function normaliseRemote({ explicit, locationStr } = {}) {
  if (explicit) {
    const s = String(explicit).toLowerCase().replace(/[-_\s]+/g, '');
    if (REMOTE_VALUES.has(s)) return s;
    if (s === 'onsite' || s === 'inoffice' || s === 'inperson') return 'onsite';
    if (s === 'true') return 'remote';
    if (s === 'false') return null;
  }
  if (locationStr) {
    const l = String(locationStr).toLowerCase();
    if (/\bremote\b/.test(l)) return 'remote';
    if (/\bhybrid\b/.test(l)) return 'hybrid';
  }
  return null;
}

/**
 * Normalise an interval string from any of {Lever "per-year-salary",
 * Ashby "1 YEAR", "1 HOUR", "MONTHLY"} to {'year','month','week','day','hour'}.
 */
function normaliseInterval(raw) {
  if (!raw) return null;
  const s = String(raw).toLowerCase();
  if (s.includes('year') || s.includes('annual')) return 'year';
  if (s.includes('month')) return 'month';
  if (s.includes('week')) return 'week';
  if (s.includes('day') || s.includes('daily')) return 'day';
  if (s.includes('hour') || s.includes('hourly')) return 'hour';
  return null;
}

/**
 * Parse a free-text salary range like "$120K - $180K", "$50/hour", "€90K – €120K"
 * into { min, max, currency, interval, text }. Anything we can't parse goes
 * into `text` only — the structured fields stay null.
 *
 * Used by WaaS (whose salaryRange ships as a string). Greenhouse/SR custom
 * metadata fields could route through here too if we ever wire them up.
 */
function parseSalaryString(raw) {
  if (!raw || typeof raw !== 'string') return null;
  const text = raw.trim();
  if (!text) return null;

  // Currency: explicit symbol wins, fallback to 3-letter code, else null.
  const symbolMap = { '$': 'USD', '€': 'EUR', '£': 'GBP', '¥': 'JPY' };
  let currency = null;
  for (const sym of Object.keys(symbolMap)) {
    if (text.includes(sym)) { currency = symbolMap[sym]; break; }
  }
  if (!currency) {
    const code = text.match(/\b(USD|EUR|GBP|CAD|AUD|JPY|INR|SGD|CHF|SEK|NOK|DKK)\b/i);
    if (code) currency = code[1].toUpperCase();
  }

  // Interval hints embedded in the string ("/hr", "per hour", "annual").
  let interval = null;
  if (/\/\s*hr|\bper\s+hour|\bhourly\b/i.test(text)) interval = 'hour';
  else if (/\bper\s+year|\bannual|\b\/\s*yr/i.test(text)) interval = 'year';

  // Pull all "$120K" / "120,000" / "1.2M" numbers out and use the first
  // two as min/max. Range separators we accept: -, –, —, to.
  const tokenRe = /(\d[\d,.]*)\s*([KkMm])?/g;
  const numbers = [];
  let m;
  while ((m = tokenRe.exec(text)) !== null) {
    const base = Number(m[1].replace(/,/g, ''));
    if (!Number.isFinite(base)) continue;
    const mult = m[2] ? (m[2].toLowerCase() === 'k' ? 1_000 : 1_000_000) : 1;
    numbers.push(base * mult);
  }
  // Heuristic for hourly: if values are tiny (< 1000) and we have no K/M
  // suffix, treat as hourly even without an explicit hint.
  if (!interval && numbers.length && numbers.every((n) => n < 1000)) {
    interval = 'hour';
  }

  const min = numbers[0] ?? null;
  const max = numbers[1] ?? numbers[0] ?? null;
  // Guard against junk like "10+ years experience" being read as comp.
  if (min !== null && max !== null && min > max * 2) return { min: null, max: null, currency, interval, text };

  return { min, max, currency, interval, text };
}

/**
 * Coerce a timestamp value (ISO string, epoch ms, epoch s, or null) to an
 * ISO string. Providers are inconsistent: Greenhouse uses ISO, WaaS sometimes
 * ships epoch seconds.
 */
function toIso(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'number') {
    // Heuristic: 10-digit = seconds, 13-digit = ms.
    const ms = v < 1e12 ? v * 1000 : v;
    const d = new Date(ms);
    return Number.isFinite(d.getTime()) ? d.toISOString() : null;
  }
  const d = new Date(v);
  return Number.isFinite(d.getTime()) ? d.toISOString() : null;
}

/** Shape returned by every parse(). Use to default missing keys to null. */
const EMPTY_OPTIONAL_FIELDS = {
  comp_min: null,
  comp_max: null,
  comp_currency: null,
  comp_interval: null,
  comp_text: null,
  remote: null,
  source_updated_at: null,
  source_published_at: null,
};

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
      return (json?.jobs || []).map((j) => {
        const location = j.location?.name || '';
        return {
          ...EMPTY_OPTIONAL_FIELDS,
          external_id: String(j.id),
          title: j.title || '',
          location,
          url: j.absolute_url || '',
          department: (j.departments?.[0]?.name) || null,
          employment_type: null,
          description: j.content ? htmlToText(j.content) : null,
          // No structured comp in the Greenhouse listing — pay ranges live
          // inside the tenant-specific `metadata` array and aren't worth
          // guessing at. Remote is a location-string heuristic only.
          remote: normaliseRemote({ locationStr: location }),
          source_updated_at: toIso(j.updated_at),
          source_published_at: toIso(j.first_published),
        };
      });
    },
  },

  ashby: {
    probeUrl: (slug) => `https://api.ashbyhq.com/posting-api/job-board/${slug}?includeCompensation=true`,
    careersUrl: (slug) => `https://jobs.ashbyhq.com/${slug}`,
    fallbackUrl: () => null,
    parse(json) {
      return (json?.jobs || []).map((j) => {
        // Compensation: prefer the first tier's first Salary-typed component
        // (Ashby tiers cover regions/levels; tier[0] is the canonical one in
        // ~all cases we've seen). Fall back to the human-readable summary.
        // The numeric fields (minValue/maxValue/currencyCode/interval) live
        // directly on the component — there is no `.value` wrapper — so reading
        // salaryComp.value.* silently yielded null comp_min/max on every job
        // even when tierSummary populated comp_text. A tier can also carry a
        // non-salary component first (e.g. EquityPercentage with null values),
        // which is why we filter to the Salary-typed one before reading numbers.
        const tier = j.compensation?.compensationTiers?.[0];
        const salaryComp = tier?.components?.find((c) => /salary/i.test(c?.compensationType || ''));
        const comp_text = j.compensation?.compensationTierSummary
          || tier?.tierSummary
          || salaryComp?.summary
          || null;
        return {
          ...EMPTY_OPTIONAL_FIELDS,
          external_id: String(j.id),
          title: j.title || '',
          location: j.location || '',
          url: j.jobUrl || '',
          department: j.department || null,
          employment_type: j.employmentType || null,
          // Ashby includes descriptionPlain in the public posting API. Fall
          // back to stripping HTML if only the HTML form is present.
          // descriptionPlain skips htmlToText (no HTML to strip) but still
          // needs the whitespace + stray-image-ref tidier.
          description: j.descriptionPlain
            ? normaliseWhitespace(j.descriptionPlain)
            : (j.descriptionHtml ? htmlToText(j.descriptionHtml) : null),
          comp_min: Number.isFinite(salaryComp?.minValue) ? salaryComp.minValue : null,
          comp_max: Number.isFinite(salaryComp?.maxValue) ? salaryComp.maxValue : null,
          comp_currency: salaryComp?.currencyCode || null,
          comp_interval: normaliseInterval(salaryComp?.interval),
          comp_text,
          remote: normaliseRemote({
            explicit: j.isRemote === true ? 'remote' : (j.isRemote === false ? null : undefined),
            locationStr: j.location,
          }),
          source_updated_at: toIso(j.updatedAt),
          source_published_at: toIso(j.publishedAt || j.publishedDate),
        };
      });
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
        // them for a more complete embedding input. descriptionPlain still
        // goes through normaliseWhitespace to drop nbsp/image-refs.
        const desc = [
          j.descriptionPlain
            ? normaliseWhitespace(j.descriptionPlain)
            : (j.description ? htmlToText(j.description) : ''),
        ];
        if (Array.isArray(j.lists)) {
          for (const list of j.lists) {
            if (list?.text) desc.push(htmlToText(list.text));
            if (list?.content) desc.push(htmlToText(list.content));
          }
        }
        const description = desc.filter(Boolean).join('\n\n') || null;
        const salary = j.salaryRange || {};
        const comp_min = Number.isFinite(salary.min) ? salary.min : null;
        const comp_max = Number.isFinite(salary.max) ? salary.max : null;
        const comp_text = comp_min != null || comp_max != null
          ? [comp_min, comp_max].filter((v) => v != null).map((v) => v.toLocaleString()).join(' – ')
          : null;
        return {
          ...EMPTY_OPTIONAL_FIELDS,
          external_id: String(j.id || j.lever_id || ''),
          title: j.text || '',
          location: j.categories?.location || '',
          url: j.hostedUrl || j.applyUrl || '',
          department: j.categories?.department || null,
          employment_type: j.categories?.commitment || null,
          description,
          comp_min,
          comp_max,
          comp_currency: salary.currency || null,
          comp_interval: normaliseInterval(salary.interval),
          comp_text,
          remote: normaliseRemote({
            explicit: j.workplaceType,
            locationStr: j.categories?.location,
          }),
          // Lever exposes createdAt; no public updated stamp.
          source_published_at: toIso(j.createdAt),
        };
      });
    },
  },

  smartrecruiters: {
    probeUrl: (slug) => `https://api.smartrecruiters.com/v1/companies/${slug}/postings`,
    careersUrl: (slug) => `https://careers.smartrecruiters.com/${slug}`,
    fallbackUrl: () => null,
    parse(json) {
      return (json?.content || []).map((j) => {
        const location = [j.location?.city, j.location?.country].filter(Boolean).join(', ');
        // The listing's `ref` is the *API* URL (api.smartrecruiters.com/...),
        // which renders as raw JSON in a browser — not something to hand a job
        // seeker. The listing has no applyUrl/postingUrl field, so build the
        // public posting page ourselves: jobs.smartrecruiters.com/{identifier}/
        // {id} resolves 200 to the real posting (the careers.* host instead
        // 302-redirects the bare id to the company landing page, losing the job).
        const identifier = j.company?.identifier || j.companyName;
        const url = identifier && j.id
          ? `https://jobs.smartrecruiters.com/${identifier}/${j.id}`
          : (identifier ? `https://careers.smartrecruiters.com/${identifier}` : '');
        return {
          ...EMPTY_OPTIONAL_FIELDS,
          external_id: String(j.id || j.uuid || ''),
          title: j.name || '',
          location,
          url,
          department: j.department?.label || null,
          employment_type: j.typeOfEmployment?.label || null,
          // The listing endpoint has summaries only; the description pass
          // calls fetchDescription() below for each row.
          description: null,
          // SR has no structured comp in the public listing (it's in
          // tenant-specific customField[]). Remote comes from location.remote
          // when present, else heuristic on the joined location string.
          remote: normaliseRemote({
            explicit: j.location?.remote === true ? 'remote' : (j.location?.remote === false ? null : undefined),
            locationStr: location,
          }),
          source_published_at: toIso(j.releasedDate),
          // SR-only structured taxonomy (f-121). Present in the listing at zero
          // extra fetch cost; consumed by classifyJob() as a relevance prior
          // (function), a seniority fill (experienceLevel), and metadata
          // (industry). Other providers don't expose these — left undefined.
          sr_function: j.function?.label || null,
          sr_industry: j.industry?.label || null,
          sr_experience_level: j.experienceLevel?.label || null,
        };
      });
    },
    // Per-job fetch: hits /v1/companies/{slug}/postings/{id}. The detail
    // response carries far more than the listing — the jobAd.sections.* text
    // blocks AND structured fields (compensation, location remote/hybrid flags,
    // department, employment type) that the listing omits. fetchDetail returns
    // both; fetchDescription is the thin description-only wrapper the scan's
    // description pass and backfill-descriptions already use.
    async fetchDetail(slug, externalId, { timeoutMs = 15_000 } = {}) {
      const url = `https://api.smartrecruiters.com/v1/companies/${slug}/postings/${externalId}`;
      const res = await fetchJson(url, timeoutMs);
      if (!res.ok) return res;
      const j = res.json || {};
      const sections = j.jobAd?.sections || {};
      const parts = [];
      for (const key of ['jobDescription', 'responsibilities', 'qualifications', 'additionalInformation']) {
        const text = sections[key]?.text;
        if (text) parts.push(htmlToText(text));
      }
      // Compensation: SR ships a flat { min, max, currency, period } object when
      // the tenant publishes pay (≈18% do — mostly US pay-transparency roles).
      const comp = j.compensation || {};
      const comp_min = Number.isFinite(comp.min) ? comp.min : null;
      const comp_max = Number.isFinite(comp.max) ? comp.max : null;
      // Location flags are authoritative here (the listing only had a single
      // `remote` bool); fall back to onsite when a location exists but neither
      // flag is set, rather than leaving it null.
      const loc = j.location || {};
      const remote = loc.remote === true ? 'remote'
        : loc.hybrid === true ? 'hybrid'
        : (loc.city || loc.country || loc.fullLocation) ? 'onsite'
        : null;
      return {
        ok: true,
        http_status: res.http_status,
        latency_ms: res.latency_ms,
        description: parts.join('\n\n') || null,
        fields: {
          comp_min,
          comp_max,
          comp_currency: comp.currency || null,
          comp_interval: normaliseInterval(comp.period),
          comp_text: (comp_min != null || comp_max != null)
            ? [comp_min, comp_max].filter((v) => v != null).map((v) => v.toLocaleString()).join(' – ')
              + (comp.currency ? ` ${comp.currency}` : '')
            : null,
          remote,
          department: j.department?.label || null,
          employment_type: j.typeOfEmployment?.label || null,
          location: loc.fullLocation || [loc.city, loc.country].filter(Boolean).join(', ') || null,
          source_published_at: toIso(j.releasedDate),
          // Structured taxonomy (f-121) — also present on the detail payload.
          sr_function: j.function?.label || null,
          sr_industry: j.industry?.label || null,
          sr_experience_level: j.experienceLevel?.label || null,
        },
      };
    },
    async fetchDescription(slug, externalId, opts = {}) {
      const res = await this.fetchDetail(slug, externalId, opts);
      if (!res.ok) return res;
      return { ok: true, http_status: res.http_status, latency_ms: res.latency_ms, description: res.description };
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
      // The company page lists only summary fields per job (title, location,
      // jobType, salaryRange, etc.) — no description text. The actual
      // description is on the per-job page in `props.job.descriptionHtml`,
      // which fetchDescription() below pulls. Verified empirically across
      // multiple companies via scripts/inspect-waas.mjs.
      return jobs.map((j) => {
        // WaaS ships salaryRange/equityRange as free-text strings like
        // "$120K - $180K" / "0.1% - 1.0%". Parse what we can; always keep
        // the raw text in comp_text so the UI has something to show even
        // when the regex fails on edge formats.
        const salary = parseSalaryString(j.salaryRange);
        return {
          ...EMPTY_OPTIONAL_FIELDS,
          external_id: String(j.id),
          title: j.title || '',
          location: j.location || '',
          url: j.id ? `https://www.workatastartup.com/jobs/${j.id}` : '',
          department: null,
          employment_type: j.jobType || null,
          description: null,
          comp_min: salary?.min ?? null,
          comp_max: salary?.max ?? null,
          comp_currency: salary?.currency ?? null,
          comp_interval: salary?.interval ?? null,
          comp_text: salary?.text || (j.salaryRange || null),
          remote: normaliseRemote({
            explicit: j.remote === true ? 'remote' : (j.remote === false ? null : undefined),
            locationStr: j.location,
          }),
        };
      });
    },
    // Per-job fetch: hit /jobs/{id}, which is another Inertia-rendered page
    // with the same data-page-attribute pattern. The job description lives
    // at props.job.descriptionHtml. We deliberately don't include
    // interviewProcessHtml — it's usually generic boilerplate that dilutes
    // the role-specific signal in the embedding.
    async fetchDescription(slug, externalId, { timeoutMs = 15_000 } = {}) {
      const url = `https://www.workatastartup.com/jobs/${externalId}`;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      const startedAt = Date.now();
      try {
        const res = await fetch(url, {
          signal: controller.signal,
          headers: {
            Accept: 'text/html',
            'User-Agent': 'Mozilla/5.0 (compatible; fyj-scanner/0.2; +https://github.com/Saikiran-linux/fyj_scanner)',
            'Accept-Encoding': 'gzip, deflate, br',
          },
        });
        const latency_ms = Date.now() - startedAt;
        if (!res.ok) return { ok: false, http_status: res.status, latency_ms, error: `HTTP ${res.status}` };
        const text = await res.text();
        let json;
        try {
          json = this.extract(text); // reuse the data-page decoder
        } catch (e) {
          return { ok: false, http_status: res.status, latency_ms, error: `extract: ${e.message}` };
        }
        const html = json?.props?.job?.descriptionHtml;
        return {
          ok: true,
          http_status: res.status,
          latency_ms,
          description: html ? htmlToText(html) : null,
        };
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

// Whether a provider's per-job fetch also yields structured fields (comp,
// remote, department, …) beyond the description. Today only SmartRecruiters,
// whose listing omits them.
export function hasDetailFetcher(ats) {
  return typeof PROVIDERS[ats]?.fetchDetail === 'function';
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

/**
 * Fetch a single job's full detail (description + structured `fields`), through
 * the rate limiter. Same contract as fetchJobDescription but the resolved value
 * also carries a `fields` object (comp_*, remote, department, employment_type,
 * location, source_published_at) on success. Used by the enrichment backfill
 * and the scan's per-job pass to populate columns the listing can't supply.
 */
export async function fetchJobPosting(ats, slug, externalId, { timeoutMs = 15_000, limiter = null } = {}) {
  const provider = PROVIDERS[ats];
  if (!provider) throw new Error(`Unknown ATS: ${ats}`);
  if (!provider.fetchDetail) {
    return { ok: false, error: 'no_detail_fetcher', http_status: null, latency_ms: 0 };
  }
  const release = limiter ? await limiter.acquire(ats) : () => {};
  try {
    const res = await provider.fetchDetail(slug, externalId, { timeoutMs });
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
    // raw_text is the exact response body (pre-parse). The scanner archives it
    // to R2 (src/r2.mjs) for replay/audit; kept separate from `json` so we
    // store the provider's original bytes, not a re-serialized copy.
    return { ok: true, http_status: res.status, latency_ms, json, raw_text: text, url };
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
