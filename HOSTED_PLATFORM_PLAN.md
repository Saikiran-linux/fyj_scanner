# Career-Ops Hosted Platform — Implementation Plan

Auto-scan-first multi-tenant SaaS version of career-ops.

---

## Product Strategy — one DB, two lenses (2026-06-05)

The scanned job index is the **moat**. It powers **two products off the same data**, distinguished only by a *filter lens*, not by separate datasets. This is why we **classify and keep every job (tag, never delete)** rather than pruning blue-collar/service roles.

**Product A — AI-first staffing firm (near-term revenue).**
High-touch, paid placement for tech/IT job seekers (engineers, data/AI, IT, product, design, security, plus senior/exec leadership and students in those fields). Lens = `is_target=true` / tech `job_family`. Operators (and eventually the user) run a client résumé through the matcher, curate a shortlist, and place. High margin, few clients to start.

**Product B — natural-language jobs search for agents & people (platform play).**
Anyone — an AI agent via **MCP**, or a person via API/UI — searches the *whole* index in natural language ("warehouse jobs in Austin", "remote senior Rust roles with equity"). Lens = whatever the caller asks for, including blue-collar. Monetized by API/MCP usage. Agents become a demand + distribution channel that also feeds Product A.

**Architectural commitments that make both work from one asset:**
1. **Tag, don't delete.** The relevance layer (`is_target`, `job_family`, `seniority`, f-113) is the shared backbone. Both products read the same tables; they differ only in the `WHERE` clause.
2. **Don't prune by relevance.** Keep scanning blue-collar/service tenants — Product B wants them. Only disable genuinely dead tenants (404/empty) for hygiene. (Reverses the earlier "prune SR tenants" idea.)
3. **Parameterize relevance in search, never hardcode it.** The search engine takes `target_only` / `family` / structured filters as arguments. Staffing calls it with `target_only=true`; the MCP passes whatever the agent wants. One engine, two lenses. (Supersedes the hardcoded `is_target is not false` currently in `match_resume*`.)
4. **Shared backbone, built once:** (a) full classification (rules + LLM), (b) embeddings across the index — tech slice first to launch Product A, full index later for Product B, (c) a hybrid NL→{structured filters + semantic vector} search RPC both products call.
5. **Interface for Product B = a curated MCP server** (+ thin REST), exposing tools like `search_jobs(query, filters)` / `get_job(id)` backed by the shared RPC — never raw DB access (safe, rate-limitable, monetizable).

**Sequencing:** launch Product A first (classify + embed the tech slice, `target_only=true`), parameterize the search RPC, then embed the full index + ship the MCP for Product B. Same DB, same search engine, two revenue lines. See `feature_list.json` f-114/f-115/f-116.

---

## Phase 0 — De-risking (DO THESE BEFORE WRITING PRODUCT CODE)

Each item below can kill the product. Resolve them in this order. Budget: 2 weeks, ~$200 in infra/API costs.

### 0.1 Scanner viability (5 days, blocking)

**Goal:** Confirm you can sustain a 50k–100k job index across 5 ATS sources without getting blocked.

**Setup:**
- Spin up a $5 Hetzner/DigitalOcean VPS in EU.
- Write a minimal Node script per source. Hit the public JSON endpoints used by their embedded boards:
  - Greenhouse: `https://boards-api.greenhouse.io/v1/boards/{company}/jobs`
  - Ashby: `https://api.ashbyhq.com/posting-api/job-board/{company}`
  - Lever: `https://api.lever.co/v0/postings/{company}?mode=json`
  - Workable: `https://apply.workable.com/api/v3/accounts/{company}/jobs`
  - SmartRecruiters: `https://api.smartrecruiters.com/v1/companies/{company}/postings`
- Pull a seed list of ~500 companies per source (career-ops `portals.yml` is a start).

**Run for 5 days:**
- Rotate User-Agent, respect 1 req/sec/source, log every response.
- Measure: 429s, 403s, IP-block duration, JSON schema drift, jobs/company average.

**Pass criteria:**
- < 1% sustained block rate per source.
- ≥ 50k unique active jobs across all sources.
- Re-scan cycle for a full company list completes in < 6h per source.

**If it fails:** Pivot to user-token model (your users authenticate to LinkedIn/Indeed via browser extension, you scan on their behalf). Slower, smaller TAM, but legally bulletproof.

### 0.2 Legal/ToS audit (1 day, do in parallel with 0.1)

Read the ToS for each source. Document:
- Does it explicitly forbid automated access to public job boards?
- Is there an "aggregator" carve-out or partner program?
- Has the platform sued or C&D'd anyone for this? (Search court records, HN, GitHub issues on scrapers like `JobSpy`.)

Write a one-page legal posture doc. If a source forbids it outright, drop it.

### 0.3 LLM cost reality check (1 day)

Run 100 real evaluations through the Anthropic API:
- 50 with Haiku as a triage pass (cheap SQL filter → Haiku 1-line yes/no with score).
- 50 with full Sonnet A–G deep report.
- Use prompt caching on the system prompt (`modes/_shared.md` + `modes/oferta.md`).

Measure:
- Triage cost: target ≤ $0.005/eval.
- Deep report cost: target ≤ $0.20/eval with caching.
- p95 latency for both.

**Pass criteria:** Triage < $0.01, deep < $0.25. If not, margin at $20/mo doesn't work.

### 0.4 Match quality baseline (2 days)

Take your own profile + 1k random jobs from the test index. Run:
1. SQL filter (title regex, location, comp band) → expect 50–150 survivors.
2. Haiku triage on survivors → expect 10–30 "interesting."
3. You manually rate the 10–30 as good/bad fit.

**Pass criteria:** ≥ 60% of Haiku-passes are honestly worth looking at. If precision is < 40%, the matching prompt needs work or the SQL filter is too loose — fix before building UI.

### 0.5 Competitive landscape (½ day)

Quick scan of: Otta/Welcome to the Jungle, Wellfound, Simplify, JobRight.ai, LazyApply, JobScan, Teal, Huntr, Sonara.ai, Jobs by Apollo.

For each note: pricing, scan sources, what they do better/worse than you would. Goal isn't to copy — it's to confirm your wedge (LLM-graded reports + CV tailoring + Claude-quality matching) is actually differentiated.

### 0.6 Storage feasibility (½ day)

Spin up a Supabase free tier or local Postgres. Insert 100k synthetic job rows with full descriptions. Measure:
- Insert throughput (target: 1k/sec batch).
- Filter query latency for a typical user (title + location + comp + recency): target < 200ms.
- Index size on disk.

If Postgres struggles, you'll need Elasticsearch/Meilisearch sooner — better to know now.

---

## System Architecture

### Top-level

```
                          ┌──────────────────────────┐
                          │   ATS Public JSON APIs   │
                          │  GH · Ashby · Lever ·    │
                          │  Workable · SR · Recruitee│
                          └────────────┬─────────────┘
                                       │ HTTP (rate-limited, rotating UA)
                                       ▼
┌──────────────────────────────────────────────────────────────────────────┐
│                        SHARED SCAN LAYER (one for all users)              │
│                                                                            │
│   ┌──────────────┐    ┌──────────────┐    ┌──────────────────────────┐   │
│   │ Scan workers │───▶│  Normalizer  │───▶│  jobs table (Postgres)   │   │
│   │  (Inngest)   │    │  + dedup     │    │  + jobs_fts (full-text)  │   │
│   └──────────────┘    └──────────────┘    └──────────────────────────┘   │
│          │                                          │                     │
│          ▼                                          ▼                     │
│   ┌──────────────┐                          ┌──────────────────┐         │
│   │  Liveness    │                          │  companies table │         │
│   │   sweeper    │                          │  (source-of-truth│         │
│   └──────────────┘                          │   per ATS)       │         │
│                                              └──────────────────┘         │
└────────────────────────────────────┬──────────────────────────────────────┘
                                     │
                                     ▼
┌──────────────────────────────────────────────────────────────────────────┐
│                       PER-USER MATCHING LAYER                             │
│                                                                            │
│   Daily cron per user:                                                     │
│                                                                            │
│   jobs ──▶ SQL filter ──▶ Haiku triage ──▶ matches table                  │
│           (cheap)         (~$0.005 ea)                                    │
│                                                                            │
│   User clicks "deep evaluate" ──▶ Sonnet A–G report ──▶ reports table     │
│                                   (~$0.15 ea, prompt-cached)              │
└────────────────────────────────────┬──────────────────────────────────────┘
                                     │
                                     ▼
┌──────────────────────────────────────────────────────────────────────────┐
│                          APPLICATION LAYER                                │
│                                                                            │
│   Next.js app  ◀──▶  Auth (Clerk)  ◀──▶  Stripe                          │
│        │                                                                   │
│        ├─▶ Inbox (matches feed)                                           │
│        ├─▶ Report viewer + CV PDF (Browserless render)                    │
│        ├─▶ Tracker (applications kanban)                                  │
│        ├─▶ Profile editor + feedback loop (thumbs up/down on matches)     │
│        └─▶ Daily digest email (Resend)                                    │
└──────────────────────────────────────────────────────────────────────────┘
```

### Scan pipeline (zoomed)

```
                    ┌─────────────────────────────────────────┐
                    │  scan_sources table                     │
                    │  (source, company_slug, last_scanned)   │
                    └────────────────┬────────────────────────┘
                                     │ cron picks oldest
                                     ▼
              ┌──────────────────────────────────────────────┐
              │  Scan worker (Inngest function, one per src) │
              │                                              │
              │  1. Pick N oldest companies for this source  │
              │  2. Hit ATS API (rate-limited per source)    │
              │  3. Parse → canonical Job schema             │
              │  4. UPSERT into jobs table                   │
              │  5. Mark missing-this-pass jobs as inactive  │
              │  6. Update scan_sources.last_scanned         │
              └──────────────────┬───────────────────────────┘
                                 │
                                 ▼
              ┌──────────────────────────────────────────────┐
              │  Post-write triggers:                        │
              │  • full-text index update (pg tsvector)      │
              │  • new-job event → per-user match queue      │
              │    (only fires if job is < 24h old)          │
              └──────────────────────────────────────────────┘
```

### Matching pipeline (zoomed)

```
   User profile (targets, comp, location, deal-breakers, archetypes)
                            │
                            ▼
   ┌────────────────────────────────────────────────────────────┐
   │  Stage 1 — SQL filter (free, sub-second)                   │
   │                                                            │
   │  WHERE active = true                                       │
   │    AND posted_at > now() - interval '30 days'              │
   │    AND title ~* user.title_patterns                        │
   │    AND location IN user.location_set OR remote_ok          │
   │    AND (comp_max IS NULL OR comp_max >= user.comp_floor)   │
   │    AND company NOT IN user.blocklist                       │
   │                                                            │
   │  Expected output: 50–200 candidates per user per day       │
   └────────────────────────┬───────────────────────────────────┘
                            ▼
   ┌────────────────────────────────────────────────────────────┐
   │  Stage 2 — Haiku triage (~$0.005 per candidate)            │
   │                                                            │
   │  Cached system prompt: user profile + scoring rubric       │
   │  Variable input: job title + first 800 chars of JD         │
   │  Output: { score: 1–5, reason: "one line" }                │
   │                                                            │
   │  Expected output: 10–30 "score ≥ 3.5" per user per day     │
   └────────────────────────┬───────────────────────────────────┘
                            ▼
   ┌────────────────────────────────────────────────────────────┐
   │  Stage 3 — Land in user inbox                              │
   │                                                            │
   │  Insert into matches table.                                │
   │  Daily digest email at user-configured time.               │
   └────────────────────────┬───────────────────────────────────┘
                            ▼
   ┌────────────────────────────────────────────────────────────┐
   │  Stage 4 — User clicks "deep evaluate" (Sonnet, on-demand) │
   │                                                            │
   │  Full A–G report + tailored CV draft.                      │
   │  ~$0.15, naturally rate-limited by user clicks.            │
   └────────────────────────────────────────────────────────────┘
```

### Data model (essential tables)

```
companies              jobs                          users
──────────             ────────                      ─────────
id                     id                            id
source (gh/ashby/...)  company_id ──► companies      email
slug                   external_id                   stripe_customer_id
display_name           title                         plan (free/pro)
careers_url            location_raw                  created_at
last_scanned_at        location_normalized
status                 remote_policy                 profiles
                       comp_min, comp_max, currency  ─────────
scan_sources           seniority                     user_id ──► users
─────────────          description (text)            cv_markdown
id                     description_tsv (tsvector)    archetypes (jsonb)
company_id             posted_at                     target_titles (text[])
priority               last_seen_at                  target_locations (jsonb)
last_scanned_at        active                        comp_floor
last_status            apply_url                     deal_breakers (jsonb)
                       raw_json (jsonb)              feedback_signals (jsonb)

matches                reports                       applications
─────────              ────────                      ─────────────
id                     id                            id
user_id ──► users      user_id ──► users             user_id ──► users
job_id ──► jobs        job_id ──► jobs               job_id ──► jobs
triage_score           score_a … score_g             status (canonical)
triage_reason          full_markdown                 applied_at
created_at             cv_pdf_url                    follow_ups (jsonb)
user_action            generated_at                  notes
  (saved/dismissed/                                  source (match/manual)
   evaluated)
                       feedback                      scans_log
                       ────────                      ─────────
                       id                            id
                       user_id                       source
                       match_id ──► matches          companies_scanned
                       signal (thumbs_up/down/        jobs_added
                                wrong_seniority/      jobs_updated
                                wrong_industry/...)   errors (jsonb)
                       note                          duration_ms
                                                     ran_at
```

### Onboarding flow

```
  Landing page
        │
        ▼
  Sign in (Clerk, Google one-tap)
        │
        ▼
  ┌─────────────────────────────────────┐
  │ Step 1: Upload CV                   │
  │   - PDF / paste / LinkedIn URL      │
  │   - LLM extracts to structured form │
  │   - User confirms / edits           │
  └────────────────┬────────────────────┘
                   ▼
  ┌─────────────────────────────────────┐
  │ Step 2: Targets (2 questions)       │
  │   - "What roles?"  → LLM expands    │
  │     to title patterns               │
  │   - "Where?"  → remote / cities     │
  └────────────────┬────────────────────┘
                   ▼
  ┌─────────────────────────────────────┐
  │ Step 3: Sliders (optional)          │
  │   - Min comp, seniority, co. size   │
  └────────────────┬────────────────────┘
                   ▼
  ┌─────────────────────────────────────┐
  │ Step 4: Aha moment                  │
  │   - Run SQL filter against existing │
  │     jobs index                      │
  │   - Show 10 real matches in < 5s    │
  │   - User saves 1+ → first daily     │
  │     digest scheduled                │
  └─────────────────────────────────────┘
```

The Step 4 aha moment is what makes auto-scan-first viable. Without it, users sign up, see an empty inbox, and bounce.

---

## Tech Stack (and why)

| Layer | Choice | Why |
|-------|--------|-----|
| Web app | Next.js 15 on Vercel | Fastest auth + RSC + edge; deploy on push |
| Auth | Clerk | Google one-tap, no DB schema work, $0 to 10k MAU |
| DB | Postgres on Neon or Supabase | jsonb, full-text search, branch-per-PR |
| Queue / cron | Inngest | Durable, cron + event-driven in one, generous free tier |
| LLM | Anthropic API direct | Prompt caching, Haiku + Sonnet tiering |
| PDF rendering | Browserless.io | Don't run Playwright in your own infra at scale |
| Email | Resend | Cheapest transactional, React Email templates |
| Storage | Cloudflare R2 | Zero egress, S3-compatible |
| Billing | Stripe | Standard; use Checkout + Customer Portal, don't build it |
| Observability | Axiom + Sentry | Cheap log + error stack |

Avoid: building your own auth, hosting Postgres yourself, running Playwright in containers, writing your own queue.

---

## Implementation Order

Total: ~16 weeks solo to a paid MVP. Each phase is gated by an exit criterion.

### Phase 1 — Shared scan infrastructure (4 weeks)

**Exit criteria:** 50k+ active jobs in the index, daily re-scan cycle < 12h, < 1% sustained block rate.

- Week 1: Single-source (Greenhouse) end-to-end. One Inngest cron, normalize, upsert, full-text index.
- Week 2: Add Ashby, Lever, Workable, SmartRecruiters. Per-source rate limiting.
- Week 3: Liveness sweeps, dedup across sources (company X may exist on 2 ATSes), monitoring dashboard.
- Week 4: Admin tool to add new companies, backfill, retry failed scans.

### Phase 2 — Auth + onboarding + aha moment (3 weeks)

**Exit criteria:** A new user can sign up and see 10 real matches within 60 seconds.

- Clerk integration, user/profile tables.
- CV upload + LLM extraction → structured profile.
- Targets questionnaire (LLM maps free-text roles to title patterns).
- Step 4 aha: live SQL filter against the index.

### Phase 3 — Matching + inbox + digest (2 weeks)

**Exit criteria:** Daily matching runs for all users, < $0.05/user/day LLM cost, email digest sends.

- Per-user matching cron (Inngest fan-out).
- Haiku triage with cached system prompt.
- Inbox UI (saved / dismissed / pending).
- Daily digest email (Resend + React Email).

### Phase 4 — Deep eval + CV gen + tracker (3 weeks)

**Exit criteria:** User can go match → deep report → tailored CV PDF → tracker entry in < 30s.

- On-demand Sonnet A–G evaluation (port from `modes/oferta.md`).
- CV PDF generation (Browserless, port template from `templates/cv-template.html`).
- Applications kanban (statuses from `templates/states.yml`).
- Report viewer.

### Phase 5 — Billing + feedback loop + polish (2 weeks)

**Exit criteria:** First paying customer.

- Stripe Checkout + Customer Portal.
- Plan limits enforced (free: 5 evals/mo, Pro: unlimited).
- Thumbs-down → profile update flow (LLM proposes profile edits the user accepts).
- Pattern analysis port (rejection patterns → targeting suggestions).

### Phase 6 — Growth instrumentation (1 week)

**Exit criteria:** Funnel is measurable end-to-end.

- PostHog or Plausible.
- Funnel: landing → signup → onboarding complete → first save → first evaluation → first paid.
- Weekly cohort retention dashboard.

---

## Risk Register

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| ATS sources block aggregator IPs | High | Fatal | Phase 0.1; rotate egress IPs; user-token fallback |
| C&D / ToS escalation | Med | High | Phase 0.2; respect rate limits; partner program long-term |
| LLM cost overruns | Med | High | Haiku triage; prompt caching; per-user daily cap |
| Cold-start empty inbox | High | Med | Aha moment in onboarding; "broaden criteria" suggester |
| Match precision too low | Med | High | Phase 0.4; feedback loop from day one |
| Postgres can't keep up at 500k jobs | Low | Med | Phase 0.6; Meilisearch as drop-in upgrade |
| Anthropic outage takes down product | Low | High | Cache last 24h of triage results; graceful degradation |
| Competitor launches first | Med | Low | Wedge is depth (A–G + tailored CV), not coverage |

---

## What to do this week

1. **Day 1–2:** Run Phase 0.2 (legal audit) and 0.5 (competitive scan). Cheap, informational.
2. **Day 3–5:** Build the Phase 0.1 scanner. One script per source, dump to SQLite.
3. **Day 6–7:** Let it run, watch the logs, count what you have.
4. **End of week:** Decide go/no-go on the public-JSON approach based on block rate.

If green, start Phase 1. If yellow, narrow to 2 sources and rebuild the plan. If red, pivot to user-token model and rewrite this doc.
