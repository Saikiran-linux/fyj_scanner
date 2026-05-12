/**
 * ATS provider adapters.
 *
 * Each provider exports:
 *   - probeUrl(slug)  → string
 *   - careersUrl(slug) → string
 *   - parse(json) → [{ external_id, title, location, url, department, employment_type }]
 *   - fallbackUrl(slug) → string | null   (used on a 404 from probeUrl)
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
};

export const PROVIDER_NAMES = Object.keys(PROVIDERS);

export function fetchJobs(ats, slug, { timeoutMs = 15_000 } = {}) {
  const provider = PROVIDERS[ats];
  if (!provider) throw new Error(`Unknown ATS: ${ats}`);
  return doFetch(provider.probeUrl(slug), timeoutMs).then(async (firstResult) => {
    if (firstResult.ok) {
      const parsed = safeParse(firstResult.json, provider);
      return {
        ...firstResult,
        jobs: parsed,
        schema_ok: parsed !== null,
      };
    }
    // 404 → try fallback URL once if the provider offers one.
    if (firstResult.http_status === 404) {
      const fallback = provider.fallbackUrl(slug);
      if (fallback) {
        const second = await doFetch(fallback, timeoutMs);
        if (second.ok) {
          const parsed = safeParse(second.json, provider);
          return {
            ...second,
            jobs: parsed,
            schema_ok: parsed !== null,
            used_fallback: true,
          };
        }
        return { ...second, used_fallback: true };
      }
    }
    return firstResult;
  });
}

function safeParse(json, provider) {
  try {
    return provider.parse(json);
  } catch {
    return null;
  }
}

async function doFetch(url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const startedAt = Date.now();
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        Accept: 'application/json',
        'User-Agent': 'fyj-scanner/0.1 (+https://github.com/Saikiran-linux/fyj_scanner)',
      },
    });
    const latency_ms = Date.now() - startedAt;
    if (!res.ok) {
      return { ok: false, http_status: res.status, latency_ms, error: `HTTP ${res.status}`, url };
    }
    const text = await res.text();
    let json;
    try {
      json = JSON.parse(text);
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
