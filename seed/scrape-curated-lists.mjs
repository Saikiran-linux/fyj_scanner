#!/usr/bin/env node
/**
 * scrape-curated-lists.mjs
 *
 * Fetches known high-yield GitHub raw files (internship trackers, remote-jobs
 * lists, new-grad repos, visa-sponsorship lists) and extracts ATS slugs.
 * Merges results into data/slugs-<ats>.json without overwriting existing slugs.
 *
 * No auth needed — all files are public raw GitHub content.
 */

import { extractSlugs, mergeIntoSlugFile, sleep } from './lib.mjs';

const ATS_LIST = ['greenhouse', 'lever', 'ashby', 'smartrecruiters'];

// High-yield public raw files dense in ATS URLs.
const SOURCES = [
  // Internship / new-grad trackers (hundreds of direct ATS posting links each)
  'https://raw.githubusercontent.com/SimplifyJobs/Summer2026-Internships/dev/README.md',
  'https://raw.githubusercontent.com/SimplifyJobs/New-Grad-Positions/dev/README.md',
  'https://raw.githubusercontent.com/SimplifyJobs/Summer2025-Internships/dev/README.md',
  'https://raw.githubusercontent.com/vanshb03/Summer2027-Internships/main/README.md',
  'https://raw.githubusercontent.com/vanshb03/Summer2027-Internships/main/OFFSEASON_README.md',
  'https://raw.githubusercontent.com/speedyapply/2026-SWE-College-Jobs/main/README.md',
  'https://raw.githubusercontent.com/speedyapply/2026-AI-College-Jobs/main/README.md',
  'https://raw.githubusercontent.com/ReaVNaiL/New-Grad-2024/main/README.md',
  'https://raw.githubusercontent.com/cvrve/New-Grad-Positions/main/README.md',
  'https://raw.githubusercontent.com/jenndryden/Canadian-Tech-Internships-and-New-Grad-2025/main/README.md',
  'https://raw.githubusercontent.com/lucianlavric/CanadaTechInternships-Summer2026/main/README.md',
  'https://raw.githubusercontent.com/zapplyjobs/underclassmen-internships/main/README.md',
  'https://raw.githubusercontent.com/jerrylin-23/2027-North-America-internships/main/companies.json',
  'https://raw.githubusercontent.com/nehanataraj/internship-notifs/main/companies.json',
  'https://raw.githubusercontent.com/EmpiricalCode/interndrop/main/src/shared/companies.json',
  'https://raw.githubusercontent.com/Kanaka-Kan/cloude/main/scripts/companies.json',
  'https://raw.githubusercontent.com/henro25/new-grad-scraper/main/config/companies.json',
  'https://raw.githubusercontent.com/DesirArman007/CareerConnect-Platform/main/job-scraper/config/companies.json',
  // Remote jobs / relocation lists (company-level ATS links, not per-posting)
  'https://raw.githubusercontent.com/remoteintech/remote-jobs/main/README.md',
  'https://raw.githubusercontent.com/remote-es/remotes/main/README.md',
  'https://raw.githubusercontent.com/AndrewStetsenko/tech-jobs-with-relocation/main/README.md',
  'https://raw.githubusercontent.com/alinebastos/remote/main/README.md',
  'https://raw.githubusercontent.com/oinam/remote-teams/main/_data/companies.yml',
  'https://raw.githubusercontent.com/seguri/devmap-ch/main/data/companies.json',
  'https://raw.githubusercontent.com/TrendTweekers/Nordic-Signals/main/companies.json',
  // Hiring-without-whiteboards: ~2000 companies, many with ATS links
  'https://raw.githubusercontent.com/poteto/hiring-without-whiteboards/master/README.md',
  'https://raw.githubusercontent.com/aftongauntlett/no-whiteboard-jobs-dashboard/main/src/data/companies.json',
  // Visa sponsorship lists
  'https://raw.githubusercontent.com/Lamiiine/scrape-jobs/main/visa_sponsorship_jobs_new.md',
  'https://raw.githubusercontent.com/vimode/us-visa-sponsorship-jobs/main/README.md',
  // Job scraper config repos — dense per-company ATS slug lists
  'https://raw.githubusercontent.com/crypto-jobs-fyi/crawler/main/companies.json',
  'https://raw.githubusercontent.com/crypto-jobs-fyi/crawler/main/ai_companies.json',
  'https://raw.githubusercontent.com/crypto-jobs-fyi/crawler/main/fin_companies.json',
  'https://raw.githubusercontent.com/crypto-jobs-fyi/crawler/main/tech_companies.json',
  'https://raw.githubusercontent.com/crypto-jobs-fyi/crawler/main/crypto_companies.json',
  'https://raw.githubusercontent.com/mshen1019/Argus/main/config/profiles/default/companies.yaml',
  'https://raw.githubusercontent.com/Rajsai1609/scraper-2.0-agent/main/config/companies.yaml',
  'https://raw.githubusercontent.com/gkettani/bobber-jobs/main/config/companies.yaml',
  'https://raw.githubusercontent.com/hmilena/jobradar/main/db/seed/companies.json',
  'https://raw.githubusercontent.com/rodruizronald/tw-data/main/companies.yaml',
  'https://raw.githubusercontent.com/athifer/biodsjobs/main/backend/companies.yaml',
  'https://raw.githubusercontent.com/linxscc/ds_findingjob_agent/main/config/companies.yaml',
  'https://raw.githubusercontent.com/A-rehman03/job-notification/main/companies.json',
  'https://raw.githubusercontent.com/DhruvkrSharma/kareerly/main/companies.json',
  'https://raw.githubusercontent.com/Frost-04/JobNudge/main/config/companies.yaml',
  'https://raw.githubusercontent.com/Liam-Frost/AutoApply/main/config/companies.yaml.example',
  'https://raw.githubusercontent.com/chiraanth/jobradar/main/config/companies.yaml.example',
  'https://raw.githubusercontent.com/rohit-b27/Job-Search-Automator/main/config/companies.yaml',
  'https://raw.githubusercontent.com/kayden-vs/jobradar/main/companies.yaml',
  'https://raw.githubusercontent.com/vAbdullh/job-hunter-bot/main/config/companies.yaml',
  'https://raw.githubusercontent.com/jdziergwa/job-radar/main/profiles/demo/companies.yaml',
  'https://raw.githubusercontent.com/jdziergwa/job-radar/main/profiles/example/companies.yaml',
  'https://raw.githubusercontent.com/SebastianBurke/job-radar/main/config/companies.yml',
  'https://raw.githubusercontent.com/HarkunwarS/jobs-tracker/main/companies.yaml',
  'https://raw.githubusercontent.com/Morayya-Jain/Web-Scraper/main/companies.yaml',
  'https://raw.githubusercontent.com/kaushikc44/kaushikjob/main/companies.yaml',
  'https://raw.githubusercontent.com/jigark712/jobsearch/main/config/companies.yaml',
  'https://raw.githubusercontent.com/oolongjiawei/job-radar/main/backend/data/target_companies.yaml',
  'https://raw.githubusercontent.com/renzorico/ds-radar/main/profile/target-companies.yaml',
  'https://raw.githubusercontent.com/cyberthreatgurl/GmailJobTracker/main/json/companies.json',
  'https://raw.githubusercontent.com/Zylex-Dev/vc-portfolio-crawler/main/data/sequoia/companies.json',
  // Other curated lists
  'https://raw.githubusercontent.com/j-delaney/easy-application/master/README.md',
];

const found = Object.fromEntries(ATS_LIST.map((a) => [a, new Map()]));

function record(ats, slug) {
  const prev = found[ats].get(slug) || { hits: 0, latestYear: new Date().getUTCFullYear() };
  prev.hits += 1;
  found[ats].set(slug, prev);
}

console.log(`Fetching ${SOURCES.length} curated source files…\n`);

for (const url of SOURCES) {
  let text;
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'fyj-scanner-seed/0.2' },
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) {
      console.warn(`  SKIP ${url.split('/').slice(3, 6).join('/')}: HTTP ${res.status}`);
      continue;
    }
    text = await res.text();
  } catch (e) {
    console.warn(`  SKIP ${url.split('/').slice(3, 6).join('/')}: ${e.message}`);
    continue;
  }

  const counts = {};
  let total = 0;
  for (const ats of ATS_LIST) {
    const slugs = extractSlugs(ats, text);
    for (const slug of slugs) record(ats, slug);
    counts[ats] = slugs.length;
    total += slugs.length;
  }
  const label = url.split('/').slice(3, 6).join('/');
  const detail = ATS_LIST.filter((a) => counts[a] > 0).map((a) => `${a}:${counts[a]}`).join(' ');
  console.log(`  ${label}: ${total} slug-refs (${detail || 'none'})`);
  await sleep(200);
}

console.log('\nMerging into slug files…');
for (const ats of ATS_LIST) {
  if (found[ats].size === 0) { console.log(`  ${ats}: 0 discovered`); continue; }
  const { before, after, added, path } = mergeIntoSlugFile(ats, found[ats]);
  console.log(`  ${ats}: discovered ${found[ats].size} → merged ${before}→${after} (+${added}) in ${path}`);
}
