# Ops Console — Product & Implementation Plan (PRD)

**Status:** planning · **Owner branch:** `claude/dreamy-knuth-4m3wlz` · **Created:** 2026-06-17

A multi-tenant, user-facing dashboard built on top of the existing fyj_scanner job index
(~169k active jobs in Supabase Postgres). This is **Product A** (AI-first staffing firm) given a
real SaaS front end: staffing organizations sign up, their operators manage job-seeker clients,
and a continuously-running matching campaign surfaces jobs from the shared index for each
client profile. Clients get a read-only transparency portal with a per-application feedback
channel that feeds back into process tuning.

**The ops-console is a standalone product with its own backend on Cloudflare, separate from the
job index.** It owns its own database (Neon Postgres) and only *reads* the shared job index over
HTTPS. The job index (Supabase Postgres) is unchanged and remains owned by `fyj_scanner`.

> This document is the source of truth for the ops-console workstream. It lives in `fyj_scanner`
> for now (planning), but the ops-console itself ships in a **separate repo** (Cloudflare Workers +
> Neon, a different runtime/DB than the scanner). Feature-level tracking lives in
> [`feature_list.json`](../feature_list.json) under phase `ops-console` (f-130…).

---

## 1. Decisions locked (this is settled — do not relitigate)

| # | Decision | Rationale |
|---|---|---|
| D1 | **Separate repo** — ops-console is its own repo, NOT in `fyj_scanner`. | It's a different runtime (Cloudflare Workers) and a different DB (Neon), and it touches the job index only via a read-only HTTP API — so the monorepo argument (atomic `schema.sql` edits) no longer applies. Only shared contract is the `search_jobs`/`get_job` API shape. |
| D2 | **Backend on Cloudflare; ops DB on Neon Postgres (via Hyperdrive).** Auth = Better Auth (users in our Neon DB). NOT Supabase Auth, NOT Clerk. | Keeps the app self-contained on Cloudflare (Workers/Pages/R2/Queues) **while preserving Postgres + RLS** — the two-principal isolation model survives almost verbatim. D1/SQLite was rejected because it has no RLS (tenant isolation would move into app code — unacceptable downgrade for client PII + a client portal). |
| D3 | **Two systems of record, clean ownership.** Job index (Supabase Postgres) = `fyj_scanner`'s, read-only to ops-console. Ops data (Neon Postgres) = ops-console's. | ops-console NEVER writes the job index; it reads via `search_jobs`/`get_job` over HTTPS. No two-writers-one-DB. No cross-store joins — match rows store `job_id`+`company_id` and hydrate job detail via API (cache in KV). |
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
users (Better Auth, in our Neon DB)
  ├── org staff   → row in memberships (org_id, role: admin|operator|viewer)
  └── client user → row in clients     (auth_user_id, portal_enabled)
```

**RLS is preserved on Neon — only the claim source changes** (we no longer have Supabase's
GoTrue access-token hook). The Cloudflare Worker authenticates the request via Better Auth,
resolves the principal, and stamps the connection per request inside the transaction:

```sql
-- set by the Worker on every request (Hyperdrive → Neon), then queries run under RLS
set local app.user_id   = '<uuid>';
set local app.principal = 'staff' | 'client';
set local app.org_id    = '<uuid>';
set local app.role      = 'admin' | 'operator' | 'viewer';   -- staff
set local app.client_id = '<uuid>';                          -- client
```

RLS helpers (all `stable`) read those GUCs instead of `auth.jwt()`:

```sql
app.current_user_id()   -- uuid  : current_setting('app.user_id', true)
app.current_org_id()    -- uuid  : current_setting('app.org_id', true)
app.current_principal() -- text  : 'staff' | 'client'
app.current_role()      -- text  : admin|operator|viewer (staff only)
app.current_client_id() -- uuid  : the client a client-user is bound to

-- encapsulates D7; security definer so child policies stay one-liners
can_access_client(p_client_id uuid) returns boolean
  -- staff admin/viewer: org match
  -- staff operator    : clients.assigned_operator_id = app.current_user_id()
```

The Worker connects as a **non-superuser app role** (NOT the Neon owner) so RLS is actually
enforced; the role must not have `BYPASSRLS`. Forgetting the `SET LOCAL` fails *closed* (GUCs
null → every policy denies), which is the safe direction.

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

All enforced in Neon Postgres RLS (via the per-request GUCs above) — the UI mirrors guarantees the DB already makes.

---

## 5. Data model (additions; org-scoped, RLS-gated)

All tables live in the **ops-console's own Neon DB** (not the job index). `org_id` is denormalized
onto **every** table so RLS is a cheap claim check, not a tree join. There are **no cross-database
FKs to the job index** — `job_id`/`company_id` are stored as plain columns and job detail is
hydrated from the index via API. `users` is the Better Auth users table (our Neon DB).

| Table | Key columns |
|---|---|
| `organizations` | id, name, slug, plan, created_at |
| `memberships` | org_id, user_id→`users`, role(admin\|operator\|viewer), status, created_at |
| `clients` | org_id, **assigned_operator_id**→`users`, **auth_user_id**→`users` (nullable, set on portal invite), full_name, contact, status(active\|paused\|placed\|archived), **portal_enabled** bool default false, **portal_permissions** jsonb, notes |
| `client_profiles` | org_id, client_id, label, resume_storage_path (R2 key), resume_text, **parsed_profile** jsonb, **embedding** vector(1536) (pgvector on Neon; used to query the index — no local ANN index needed), embedded_at, **target_filters** jsonb (titles[], locations, remote, comp_floor, seniority, families, target_only) |
| `campaigns` | org_id, client_id, **profile_id UNIQUE**, name, status(draft\|active\|paused\|completed), config jsonb, last_run_at, next_run_at, created_by |
| `campaign_matches` | org_id, client_id, campaign_id, **job_id + company_id** (refs the index, no FK), score, rank, surfaced_at, **action**(new\|saved\|shortlisted\|dismissed\|evaluated\|applied), action_by, action_at, notes · **UNIQUE(campaign_id, job_id)** |
| `reports` | org_id, client_id, campaign_match_id, model, scores jsonb (A–G), full_markdown, cv_pdf_url, generated_by, generated_at |
| `placements` | org_id, client_id, campaign_id, **job_id + company_id**, status (kanban), applied_at, follow_ups jsonb, notes |
| `feedback` | org_id, client_id, campaign_id, job_id, placement_id (nullable), **signal** enum, rating smallint (1–5, opt), note text, created_by (client), created_at |
| `audit_log` | org_id, actor_user_id, action, entity_type, entity_id, metadata jsonb, created_at |

`client_id` is denormalized onto child tables (campaigns, campaign_matches, reports, placements,
feedback) so every RLS policy is a flat `can_access_client(client_id)` check; reassigning a client
re-gates all descendants because the helper reads the live `clients` row.

**`feedback.signal` enum:** `interested | not_interested | already_applied | wrong_location | comp_too_low | seniority_off | not_my_field | other`. Structured (not free text) so it rolls up; `note` rides alongside for color.

**Analytics view `v_campaign_feedback_signals`:** per campaign/profile signal counts → e.g. "62% of this profile's matches came back `wrong_location`" → operator adjusts `profile.target_filters` and the continuous campaign self-corrects. This is the concrete realization of the `HOSTED_PLATFORM_PLAN.md` feedback loop.

---

## 6. How it talks to the job index (read-only, over HTTPS)

Everything below runs in **Cloudflare Workers**; the job index is reached via the Supabase
`search_jobs`/`get_job` RPC over HTTPS (or a second Hyperdrive binding). The index is never written.

```
Worker: profile.resume_text ─(OpenAI/Voyage embed)→ profile.embedding   (stored in Neon)
campaign run (Worker) ─→ POST search_jobs(profile.embedding, target_filters)  [index RPC, f-114]
                      ─→ (optional) reranker                                  [f-122]
                      ─→ upsert campaign_matches in Neon (job_id+company_id refs)
operator curates → Worker deep-eval → reports (Anthropic A–G + tailored CV)   [port tailor-resume]
client views pipeline → leaves feedback → v_campaign_feedback_signals → tune target_filters
UI shows a match → hydrate job detail via get_job (cache in Workers KV)
```

The index-side `search_jobs` RPC + embedding logic come from `fyj_scanner` (reuses the match RPCs
and `src/embeddings.mjs` patterns). **No scanner changes; no shared DB.**

### Continuous matcher (Cloudflare Cron + Queues)

A scheduled Worker (NOT in-request work), fanning out per active campaign:

```
Cron Trigger (e.g. hourly) → enqueue active campaigns → Queue consumer per campaign:
  delta = search_jobs(profile.embedding, target_filters) filtered to jobs
          first_seen_at > campaign.last_run_at  (index applies the recency/target lens)
  upsert campaign_matches in Neon (on conflict campaign_id,job_id do nothing)
  campaign.last_run_at = now()
```

Incremental (only new jobs since last run) → bounded cost. Cloudflare **Cron Triggers + Queues**
handle the fan-out (better than one serial cron job); per-campaign isolation + retries for free.

### Model layer

Haiku 4.5 for cheap triage; Opus 4.8 (or Sonnet 4.6 for cost) for the A–G deep evaluation, with
prompt caching on the operator/rubric system prompt. (Supersedes the older "Haiku/Sonnet"
naming in `HOSTED_PLATFORM_PLAN.md`.)

---

## 7. App architecture (Cloudflare + Neon)

Separate repo. Stack:

| Layer | Choice |
|---|---|
| Frontend | **Next.js (on Cloudflare Pages/Workers)** — TS, App Router. Clay-inspired UI (see below). |
| API + business logic | **Cloudflare Workers** |
| Ops database | **Neon Postgres** (own DB), reached from Workers via **Hyperdrive** (pooled) |
| Auth | **Better Auth** (sessions/users in Neon); two-principal (staff/client) resolved per request |
| ORM / migrations | **Drizzle** (Drizzle Kit migrations against Neon) |
| File storage | **R2** (resume uploads; `client_profiles.resume_storage_path` = R2 key) |
| Matcher | **Workers Cron Triggers + Queues** |
| Job-detail cache | **Workers KV** |
| Job index | **Supabase Postgres** (read-only via `search_jobs`/`get_job` RPC over HTTPS) |
| LLM | Anthropic API (deep-eval, CV) + OpenAI/Voyage (embeddings), called from Workers |

- **Tenant safety:** a mandatory Drizzle repository layer that injects `org_id` scoping + sets the
  per-request `SET LOCAL app.*` GUCs; the Worker DB role is non-superuser (RLS enforced). RLS is
  the backstop, the repository layer is the first line.
- **Visual design:** light/airy, Clay-inspired shell (slim icon rail, hero command bar, quick-action
  cards, clean data tables). Full token set + component spec in [`ops-console-ui.md`](ops-console-ui.md).
- **Contract with the index:** a thin typed client for `search_jobs`/`get_job`; that API shape is the
  only coupling to `fyj_scanner`.
- **Routes:** `/onboarding` · `/` (org dashboard) · `/clients` → `/clients/[id]` (profiles) →
  `/profiles/[id]` (campaign + matches) · `/campaigns/[id]/matches/[id]` (report) · `/tracker` ·
  `/jobs` (index search) · `/settings/members` (admin) · `/portal/*` (client read-only + feedback).

---

## 8. Prerequisites (must land before the matching UI is real)

On the **job index** (`fyj_scanner`, Supabase):
1. **`search_jobs` RPC** (f-114) — parameterized filters + `target_only` lens, exposed for HTTPS calls. *Blocking.*
2. **Target-slice embedding** (f-115) — only ~9k/169k jobs embedded today; matches are thin until done.
3. *(quality, optional)* reranker (f-122).

On the **ops-console** (Cloudflare):
4. **Resume parse+embed Worker** — parse PDF/DOCX → text → embedding (the old `process-resume` edge fn, now a Worker).

---

## 9. Phased delivery

| Phase | Scope | Exit criterion |
|---|---|---|
| **P0** index prereqs | `search_jobs` RPC (fyj) + target-slice embedding; verify HTTPS call from a Worker | A resume vector returns ranked, filtered jobs via one RPC call from Cloudflare |
| **P1** foundation | new repo; Neon DB + Drizzle migrations (org/membership/two-principal schema + RLS + GUC helpers); Workers + Better Auth + Hyperdrive; org bootstrap + members screen | A user signs up, creates an org, invites an operator; RLS isolates tenants |
| **P2** clients & profiles | CRUD (assignment-scoped) + resume upload → parse → embed | Operator adds a client, a profile, sees it embedded |
| **P3** campaigns & matching | 1:1 campaign per profile, continuous matcher, matches feed, curation | New jobs auto-surface into a campaign; operator curates |
| **P4** deep eval + CV + tracker | on-demand A–G report, tailored CV PDF, placements kanban | match → report → CV → tracker entry |
| **P5** client portal | client invite/link, `portal_enabled` gating, read-only pipeline timeline, per-application feedback, `v_campaign_feedback_signals` | client logs in, sees their pipeline, leaves feedback; operator can revoke access |
| **P6** billing/digests/polish | Stripe, daily digest email, growth instrumentation | first paying org |

---

## 10. Constraints (do not break)

- **The job index is read-only to ops-console.** All writes stay in `fyj_scanner`. ops-console
  touches it only through `search_jobs`/`get_job`.
- Hard rule #2 (fyj): scanner's `concurrency: scan` / "no two scans in parallel" unchanged. The
  ops-console matcher is a **separate** Cloudflare job; it only *reads* the index, so it can't
  interfere with the close-sweep.
- Hard rule #5 (fyj): LLM passes cost real money; the matcher matches incrementally (new jobs
  only); deep-eval is on-demand (click-gated).
- **RLS is the security boundary, not app code** — even though a Drizzle repository layer scopes
  every query, every Neon table ships with RLS policies + the per-request GUCs in the same
  migration, and the Worker connects as a non-`BYPASSRLS` role.
- Any change to the index's `search_jobs` contract is **additive/backward-compatible** so the two
  repos deploy independently.
