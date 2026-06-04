/**
 * Turn a raw uploaded résumé into the SAME labelled "JD-style" text that
 * scripts/embed-resume.mjs hand-writes — so an arbitrary resume lands in the
 * same 1536-dim vector neighbourhood as jobs.embedding and cosine search is
 * symmetric.
 *
 * One gpt-4o-mini call extracts a Title + structured signal block + the 14
 * summary fields (the exact schema src/summarize.mjs produces for jobs). We
 * then assemble them in buildJobText()'s layout: title, then the signal lines,
 * then the 14-field precis. Keeping the resume and the job in one format is the
 * whole reason matching works.
 *
 * Cost: ~$0.0003 per resume (gpt-4o-mini, ~1.5k in / ~250 out tokens).
 */

const MODEL = process.env.RESUME_JD_MODEL || 'gpt-4o-mini';
const MAX_ATTEMPTS = 4;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Same field order as summarize.mjs, with a Title + signal fields up top.
const SYSTEM_PROMPT = `You convert a candidate's résumé into a structured, search-friendly profile describing the kind of role they are a strong fit for, so it can be matched against job postings.
Reply with EXACTLY these labelled lines, in this order, no preamble, no markdown, no blank lines:

Title: <concise target role title, e.g. "Senior Data Engineer (GenAI · Healthcare)">
Seniority: <intern / junior / mid / senior / staff / principal / lead / manager / director / vp>
Workplace: <remote / hybrid / onsite / unknown>
Employment type: <full-time / contract / unknown>
Department: <e.g. Data / AI Engineering>
Role: <one sentence on the candidate's actual day-to-day work>
Level: <same scale as Seniority; note IC vs manager track if clear>
Experience: <years of experience, e.g. "4+ years"; "unknown" if unclear>
Required skills: <12-20 comma-separated CORE technologies, languages, frameworks, tools the candidate clearly has>
Preferred skills: <comma-separated secondary / nice-to-have skills; "unknown" if none>
Team: <engineering / data / product / design / etc., plus function focus>
Industry: <domains the candidate has worked in — e.g. healthcare, fintech, AI/ML>
Company stage: <preference if stated, else "any">
Location: <city, region, country if present; else "unknown">
Remote policy: <remote / hybrid / onsite preference; "unknown" if unclear>
Compensation: <"unknown" unless the resume states a target>
Benefits: <"unknown">
Visa: <work authorization if stated, else "unknown">
Schedule: <full-time / part-time / unknown>`;

// The five signal lines buildJobText() puts above the summary (Compensation is
// derived from columns for jobs, omitted here). Location also appears in the
// 14-field summary, mirroring scripts/embed-resume.mjs.
const SIGNAL_FIELDS = ['Seniority', 'Workplace', 'Employment type', 'Department', 'Location'];
// The 14 summary fields, in summarize.mjs order.
const SUMMARY_FIELDS = ['Role', 'Level', 'Experience', 'Required skills', 'Preferred skills', 'Team', 'Industry', 'Company stage', 'Location', 'Remote policy', 'Compensation', 'Benefits', 'Visa', 'Schedule'];

function parseLabelled(text) {
  const map = new Map();
  for (const line of text.split('\n')) {
    const m = line.match(/^\s*([A-Za-z][A-Za-z /]+?):\s*(.*)$/);
    if (m) map.set(m[1].trim(), m[2].trim());
  }
  return map;
}

async function callModel(resumeRaw) {
  const body = {
    model: MODEL,
    temperature: 0,
    max_tokens: 600,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: `RÉSUMÉ:\n${resumeRaw.slice(0, 12000)}\n\nStructured profile:` },
    ],
  };
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let res;
    try {
      res = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    } catch (e) {
      if (attempt === MAX_ATTEMPTS) throw e;
      await sleep(800 * 2 ** (attempt - 1) * Math.random());
      continue;
    }
    if (res.status === 429 || res.status >= 500) {
      if (attempt === MAX_ATTEMPTS) throw new Error(`resume-to-jd ${res.status}`);
      await sleep(800 * 2 ** (attempt - 1) * Math.random());
      continue;
    }
    if (!res.ok) throw new Error(`resume-to-jd ${res.status}: ${(await res.text()).slice(0, 200)}`);
    return (await res.json()).choices?.[0]?.message?.content || '';
  }
  throw new Error('resume-to-jd: exhausted retries');
}

/**
 * @param {string} resumeRaw  Plain-text résumé.
 * @returns {Promise<{ jdText: string, title: string, fields: Object }>}
 *   jdText is ready to embed with text-embedding-3-small.
 */
export async function resumeToJd(resumeRaw) {
  if (!resumeRaw || resumeRaw.trim().length < 30) {
    throw new Error('Résumé text is empty or too short to match.');
  }
  const raw = await callModel(resumeRaw);
  const map = parseLabelled(raw);

  const title = map.get('Title') || 'Candidate';
  const keep = (label) => {
    const v = map.get(label);
    return v && !/^unknown$/i.test(v) ? v : null;
  };
  const signals = SIGNAL_FIELDS.map((f) => (keep(f) ? `${f}: ${map.get(f)}` : null)).filter(Boolean).join('\n');
  const summary = SUMMARY_FIELDS.map((f) => `${f}: ${map.get(f) || 'unknown'}`).join('\n');

  const jdText = [title, signals, summary].filter(Boolean).join('\n\n');
  return { jdText, title, fields: Object.fromEntries(map) };
}
