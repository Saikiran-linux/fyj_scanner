# Ops Console — Product & Implementation Plan (PRD)

**Status:** planning · **Owner branch:** `claude/dreamy-knuth-4m3wlz` · **Created:** 2026-06-17

A multi-tenant, user-facing dashboard built on top of the existing fyj_scanner job index
(~169k active jobs in Supabase). This is **Product A** (AI-first staffing firm) given a real
SaaS front end: staffing organizations sign up, their operators manage job-seeker clients,
and a continuously-running matching campaign surfaces jobs from the shared index for each
client profile. Clients get a read-only transparency portal with a per-application feedback
channel that feeds back into process tuning.

> This document is the source of truth for the ops-console workstream. Feature-level tracking
> lives in [`feature_list.json`](../feature_list.json) under phase `ops-console` (f-130…).

---

## 1. Decisions locked (this is settled — do not relitigate)

| # | Decision | Rationale |
|---|---|---|
| D1 | **Monorepo** — new app lives in `fyj_scanner` as `ops-console/`, beside `status-page/`. | Tight backend↔frontend co-development; atomic cross-cutting commits; `status-page` already proves a Next app can co-exist with the scanner + `schema.sql`. Split out later (Product B, separate team) is cheap; merging diverged repos is not. |
| D2 | **Supabase Auth + org-scoped RLS** — NOT Clerk. | Backend already uses Supabase Auth + RLS (`user_profiles`, `resumes`). Internal/early product doesn't need Clerk's paid B2B Orgs add-on (~$100/mo). Open source, $0, one identity source aligned with existing RLS. Revisit Clerk/WorkOS only if Product B needs external SSO/SCIM. |
| D3 | **Backend owns the database.** `supabase/schema.sql` (idempotent) stays the single source of truth; the front end is a pure PostgREST/RPC consumer. | Avoids two-writers-one-DB. Hard rule #3 already mandates schema changes go through `schema.sql`. |
| D4 | **Roles: admin / operator / viewer.** | admin = org + member management; operator = full client workflow (assigned clients only); viewer = org-wide read. |
| D5 | **One campaign per profile** (`unique(profile_id)`). | Profile = persona/resume; campaign = its matching lifecycle. Kept as separate tables so "campaign" stays first-class and 1:many is a non-breaking relaxation later. |
| D6 | **Continuous / scheduled matching.** | A campaign is a living inbox: it re-matches incrementally as new jobs are scanned. |
| D7 | **Operator visibility restricted to assigned clients** (admin/viewer see all org). | Centralized in a `can_access_client(client_id)` RLS helper. |
| D8 | **Client portal = read-only + feedback only.** Operator can toggle access. | Goal = transparency into the application process + structured per-application feedback that informs what we change. |

---

## 2. Entity hierarchy

```
organization                       ← tenant root (a staffing firm)
  └─ memberships (users w/ role)     admin / operator / viewer
       └─ operator handles…
            └─ clients               ← represented job-seekers (assigned to an operator)
                 └─ client_profiles  ← targeting personas: resume + criteria + embedding
                      └─ campaign    ← 1:1 with profile; continuous matching run
                           └─ campaign_matches → reports, placements
                                └─ feedback     ← client's per-application signal
```

---

## 3. Two-principal auth model

Two kinds of authenticated user hit the same tables:

```
auth.users
  ├── org staff   → row in memberships (org_id, role: admin|operator|viewer)
  └── client user → row in clients     (auth_user_id, portal_enabled)
```

A Supabase **custom access-token hook** stamps the JWT at mint time:
- staff  → `{ principal: 'staff',  org_id, role }`
- client → `{ principal: 'client', org_id, client_id }`

RLS helpers (all `stable`, hook-claim readers):

```sql
auth.org_id()      -- uuid  : (jwt -> app_metadata ->> 'org_id')
auth.principal()   -- text  : 'staff' | 'client'
auth.role_name()   -- text  : admin|operator|viewer (staff only)
auth.client_id()   -- uuid  : the client a client-user is bound to

-- encapsulates D7; security definer so child policies stay one-liners
can_access_client(p_client_id uuid) returns boolean
  -- staff admin/viewer: org match
  -- staff operator    : clients.assigned_operator_id = auth.uid()
```

Policy shape on every business table — a row is visible if **staff path OR client path** matches,
and `org_id = auth.org_id()` always. The **client principal gets only `SELECT` + a single
`INSERT` allow-list into `feedback`** for its own `client_id`; all other client writes are denied
at the database.

---

## 4. RBAC matrix

| Action | viewer | operator | admin | client |
|---|:--:|:--:|:--:|:--:|
| Browse jobs index / `search_jobs` | ✅ | ✅ | ✅ | — |
| View clients/profiles/campaigns/matches | ✅ (org) | ✅ (assigned) | ✅ (org) | own only |
| Create/edit clients & profiles, upload resume | — | ✅ | ✅ | — |
| Create/run campaign, curate matches | — | ✅ | ✅ | — |
| Deep-eval / generate CV | — | ✅ | ✅ | — |
| View own application pipeline (transparency) | — | — | — | ✅ (if `portal_enabled`) |
| Leave per-application feedback | — | — | — | ✅ |
| Toggle client portal access / permissions | — | ✅ | ✅ | — |
| Reassign client to operator | — | — | ✅ | — |
| Invite members, change roles, org settings, delete clients, audit log | — | — | ✅ | — |

All enforced in Postgres RLS — the UI mirrors guarantees the DB already makes.

---

## 5. Data model (additions; org-scoped, RLS-gated)

`org_id` is denormalized onto **every** table so RLS is a cheap claim check, not a tree join.

| Table | Key columns |
|---|---|
| `organizations` | id, name, slug, plan, created_at |
| `memberships` | org_id, user_id→`auth.users`, role(admin\|operator\|viewer), status, created_at |
| `clients` | org_id, **assigned_operator_id**→`auth.users`, **auth_user_id**→`auth.users` (nullable, set on portal invite), full_name, contact, status(active\|paused\|placed\|archived), **portal_enabled** bool default false, **portal_permissions** jsonb, notes |
| `client_profiles` | org_id, client_id, label, resume_storage_path, resume_text, **parsed_profile** jsonb, **embedding** vector(1536), embedded_at, **target_filters** jsonb (titles[], locations, remote, comp_floor, seniority, families, target_only) |
| `campaigns` | org_id, client_id, **profile_id UNIQUE**, name, status(draft\|active\|paused\|completed), config jsonb, last_run_at, next_run_at, created_by |
| `campaign_matches` | org_id, campaign_id, job_id→`jobs`, score, rank, surfaced_at, **action**(new\|saved\|shortlisted\|dismissed\|evaluated\|applied), action_by, action_at, notes · **UNIQUE(campaign_id, job_id)** |
| `reports` | org_id, campaign_match_id, model, scores jsonb (A–G), full_markdown, cv_pdf_url, generated_by, generated_at |
| `placements` | org_id, client_id, campaign_id, job_id, status (kanban), applied_at, follow_ups jsonb, notes |
| `feedback` | org_id, client_id, campaign_id, job_id, placement_id (nullable), **signal** enum, rating smallint (1–5, opt), note text, created_by (client), created_at |
| `audit_log` | org_id, actor_user_id, action, entity_type, entity_id, metadata jsonb, created_at |

**`feedback.signal` enum:** `interested | not_interested | already_applied | wrong_location | comp_too_low | seniority_off | not_my_field | other`. Structured (not free text) so it rolls up; `note` rides alongside for color.

**Analytics view `v_campaign_feedback_signals`:** per campaign/profile signal counts → e.g. "62% of this profile's matches came back `wrong_location`" → operator adjusts `profile.target_filters` and the continuous campaign self-corrects. This is the concrete realization of the `HOSTED_PLATFORM_PLAN.md` feedback loop.

---

## 6. How it drives the existing backend

```
profile.resume_text ─(OpenAI embed via process-resume edge fn)→ profile.embedding
campaign run ─→ search_jobs(profile.embedding, profile.target_filters)   [f-114]
            ─→ (optional) reranker                                       [f-122]
            ─→ upsert campaign_matches (on conflict campaign_id,job_id do nothing)
operator curates → deep-eval → reports (Anthropic A–G + tailored CV)     [port tailor-resume]
client views pipeline → leaves feedback → v_campaign_feedback_signals → tune target_filters
```

Reuses `src/embeddings.mjs`, the match RPCs, `summarize`/`tailor`, HNSW index. **No scanner changes.**

### Continuous matcher (new backend component)

Mirrors the scanner's scheduled-job pattern (not in-request work):

```
after each scan (or own cron):
  for each campaign where status='active':
     delta = jobs where first_seen_at > campaign.last_run_at
             AND embedded AND passes target lens
     search_jobs(profile.embedding, profile.target_filters) over delta
     upsert into campaign_matches
     campaign.last_run_at = now()
```

Incremental (only new jobs since last run) → bounded cost. **Open decision (P3):** run as a
GitHub Actions cron (like the scanner) vs `pg_cron` + RPC inside Postgres.

### Model layer

Haiku 4.5 for cheap triage; Opus 4.8 (or Sonnet 4.6 for cost) for the A–G deep evaluation, with
prompt caching on the operator/rubric system prompt. (Supersedes the older "Haiku/Sonnet"
naming in `HOSTED_PLATFORM_PLAN.md`.)

---

## 7. App architecture

- **`ops-console/`** in the monorepo, Next.js 15 + TypeScript + App Router/RSC, its own
  `package.json`, deployed independently on Vercel (root directory = `ops-console`).
- **Auth:** Supabase Auth (magic-link + Google, already enabled) → org bootstrap on first signup → invites.
- **Data access:** RLS-scoped `@supabase/ssr` client for tenant reads/writes; **service-role client
  (server-only)** for embed/match/eval. Service role never reaches the browser.
- **Contract:** generated `lib/database.types.ts` (`supabase gen types typescript`), committed; CI
  regenerates + diffs to catch schema drift.
- **Routes:** `/onboarding` · `/` (org dashboard) · `/clients` → `/clients/[id]` (profiles) →
  `/profiles/[id]` (campaign + matches) · `/campaigns/[id]/matches/[id]` (report) · `/tracker` ·
  `/jobs` (index search) · `/settings/members` (admin) · `/portal/*` (client read-only + feedback).

---

## 8. Backend prerequisites (must land before the matching UI is real)

1. **`search_jobs` RPC** (f-114) — parameterized filters + `target_only` lens. *Blocking.*
2. **`process-resume` edge function** — parse PDF/DOCX → text → embedding (README Phase 3).
3. **Target-slice embedding** (f-115) — only ~9k/169k jobs embedded today; matches are thin until done.
4. *(quality, optional)* reranker (f-122).

---

## 9. Phased delivery

| Phase | Scope | Exit criterion |
|---|---|---|
| **P0** backend | `search_jobs` RPC + `process-resume` edge fn + target-slice embedding | A resume vector returns ranked, filtered jobs via one RPC call |
| **P1** foundation | org/membership/two-principal schema + RLS + access-token hook; Next scaffold + auth + org bootstrap + members screen | A user signs up, creates an org, invites an operator; RLS isolates tenants |
| **P2** clients & profiles | CRUD (assignment-scoped) + resume upload → parse → embed | Operator adds a client, a profile, sees it embedded |
| **P3** campaigns & matching | 1:1 campaign per profile, continuous matcher, matches feed, curation | New jobs auto-surface into a campaign; operator curates |
| **P4** deep eval + CV + tracker | on-demand A–G report, tailored CV PDF, placements kanban | match → report → CV → tracker entry |
| **P5** client portal | client invite/link, `portal_enabled` gating, read-only pipeline timeline, per-application feedback, `v_campaign_feedback_signals` | client logs in, sees their pipeline, leaves feedback; operator can revoke access |
| **P6** billing/digests/polish | Stripe, daily digest email, growth instrumentation | first paying org |

---

## 10. Constraints carried from the backend (do not break)

- Hard rule #2: scanner's `concurrency: scan` and "no two scans in parallel" unchanged. The
  continuous matcher is a **separate** job from the scan; it must not interfere with the close-sweep.
- Hard rule #3: all schema changes idempotent in `supabase/schema.sql`.
- Hard rule #5: LLM passes cost real money; the matcher embeds only the target slice and matches
  incrementally; deep-eval is on-demand (click-gated).
- RLS is the security boundary, not app code. Every new table ships with policies in the same migration.
