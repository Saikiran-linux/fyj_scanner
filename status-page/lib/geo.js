/**
 * Smarter location matching for the résumé matcher's location filter.
 *
 * The job `location` field is free text from many ATSes — "Dallas, TX",
 * "San Francisco, California, United States", "Remote (US)", "London, UK".
 * A naïve substring match ("Texas" ⊄ "Dallas, TX") misses most of these.
 *
 * locationMatches(jobLocation, query) normalises the query into a set of
 * "needles" and tests them against the job text:
 *   - Country query (e.g. "United States" / "US" / "USA") matches jobs that
 *     name the country OR any of its states/abbreviations OR "Remote (US)".
 *   - US-state query (e.g. "Texas" / "TX") matches the full name OR abbrev.
 *   - Anything else (a city, region, or unknown) falls back to substring.
 *
 * Short tokens (state abbreviations, "us", "uk") match on word boundaries so
 * "in" (Indiana) doesn't hit the word "in" and "us" doesn't hit "campus".
 * Full names match as substrings.
 */

// Full state name → USPS abbreviation.
const US_STATES = {
  alabama: 'al', alaska: 'ak', arizona: 'az', arkansas: 'ar', california: 'ca',
  colorado: 'co', connecticut: 'ct', delaware: 'de', florida: 'fl', georgia: 'ga',
  hawaii: 'hi', idaho: 'id', illinois: 'il', indiana: 'in', iowa: 'ia',
  kansas: 'ks', kentucky: 'ky', louisiana: 'la', maine: 'me', maryland: 'md',
  massachusetts: 'ma', michigan: 'mi', minnesota: 'mn', mississippi: 'ms',
  missouri: 'mo', montana: 'mt', nebraska: 'ne', nevada: 'nv',
  'new hampshire': 'nh', 'new jersey': 'nj', 'new mexico': 'nm', 'new york': 'ny',
  'north carolina': 'nc', 'north dakota': 'nd', ohio: 'oh', oklahoma: 'ok',
  oregon: 'or', pennsylvania: 'pa', 'rhode island': 'ri', 'south carolina': 'sc',
  'south dakota': 'sd', tennessee: 'tn', texas: 'tx', utah: 'ut', vermont: 'vt',
  virginia: 'va', washington: 'wa', 'west virginia': 'wv', wisconsin: 'wi',
  wyoming: 'wy', 'district of columbia': 'dc', 'washington dc': 'dc',
};
const ABBR_TO_STATE = Object.fromEntries(Object.entries(US_STATES).map(([n, a]) => [a, n]));

// Canonical country → synonyms a job's location text might use.
const COUNTRY_SYNONYMS = {
  'united states': ['united states', 'united states of america', 'usa', 'u.s.a.', 'u.s.', 'us', 'america', 'stateside'],
  'united kingdom': ['united kingdom', 'uk', 'u.k.', 'great britain', 'britain', 'england', 'scotland', 'wales', 'northern ireland'],
  canada: ['canada'],
  germany: ['germany', 'deutschland'],
  india: ['india'],
  ireland: ['ireland'],
  france: ['france'],
  spain: ['spain'],
  portugal: ['portugal'],
  netherlands: ['netherlands', 'the netherlands', 'holland'],
  australia: ['australia'],
};
// Any synonym (or canonical) → canonical key, for query classification.
const SYNONYM_TO_COUNTRY = {};
for (const [canon, syns] of Object.entries(COUNTRY_SYNONYMS)) {
  for (const s of syns) SYNONYM_TO_COUNTRY[s] = canon;
}

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// Short / acronym-like needles match on word boundaries; longer phrases as
// plain substrings (cheaper and avoids over-eager boundary edge cases).
function makeNeedle(text) {
  const t = text.toLowerCase();
  const wordBound = t.length <= 3 || /[.]/.test(t); // "tx", "us", "u.s."
  return wordBound ? { re: new RegExp(`(^|[^a-z])${esc(t)}([^a-z]|$)`, 'i') } : { sub: t };
}

function needlesFor(query) {
  const q = query.trim().toLowerCase();
  const needles = new Set();
  const add = (s) => s && needles.add(s);

  // 1. Country (incl. synonyms) → country names + all its states/abbrevs.
  const country = SYNONYM_TO_COUNTRY[q];
  if (country) {
    COUNTRY_SYNONYMS[country].forEach(add);
    if (country === 'united states') {
      for (const [name, abbr] of Object.entries(US_STATES)) { add(name); add(abbr); }
    }
    return [...needles];
  }

  // 2. US state by full name or abbreviation.
  if (US_STATES[q]) { add(q); add(US_STATES[q]); return [...needles]; }
  if (ABBR_TO_STATE[q]) { add(ABBR_TO_STATE[q]); add(q); return [...needles]; }

  // 3. Fallback: the raw query as a substring (city / region / unknown).
  add(q);
  return [...needles];
}

/**
 * @param {string} jobLocation  Job's free-text location.
 * @param {string} query        User's location filter.
 * @returns {boolean}
 */
export function locationMatches(jobLocation, query) {
  if (!query || !query.trim()) return true;
  const jl = (jobLocation || '').toLowerCase();
  if (!jl) return false;
  for (const needle of needlesFor(query)) {
    const n = makeNeedle(needle);
    if (n.sub ? jl.includes(n.sub) : n.re.test(jl)) return true;
  }
  return false;
}
