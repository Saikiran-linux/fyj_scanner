# Ops Console — Session Handoff (read me first)

**Written:** 2026-06-17 · **For:** a fresh session continuing the ops-console build.
**Status:** planning complete + P1 backend foundation written (not yet pushed to its repo).

This is the single catch-up document. Read it top to bottom, then the two specs it points to.
If anything here conflicts with older notes, **this doc + `docs/ops-console-plan.md` win.**

---

## 0. TL;DR — what to do first

1. The **ops-console P1 foundation code already exists** but is currently parked here in
   `fyj_scanner/docs/ops-console-foundation/` (it was built in a prior session and could not be
   pushed to its own repo from there — see §4). **Your first job: move it into the `fyj` repo and
   push it.** Steps in §5.
2. Then continue the build: **f-132** (search_jobs RPC, in *this* `fyj_scanner` repo) and
   **f-133** (Better Auth + API + repository layer + Next.js UI shell, in the `fyj` repo). See §6.

Canonical references (all in `fyj_scanner`):
- `docs/ops-console-plan.md` — full PRD/architecture (the source of truth).
- `docs/ops-console-ui.md` — Clay-inspired visual design spec.
- `feature_list.json` — phase `ops-console`, features **f-130 … f-138**.
- `docs/ops-console-foundation/` — the **already-written P1 code** to transplant into `fyj`.

---

## 1. The product (one paragraph)

A multi-tenant, user-facing SaaS dashboard ("ops-console") for an AI-first staffing firm —
**Product A** of the fyj platform. Staffing **organizations** sign up; their **operators** manage
job-seeker **clients**; each client has targeting **profiles** (resume + criteria); each profile
has a **1:1 campaign** that *continuously* matches it against the **fyj job index** (~169k jobs).
Operators curate matches, run deep evals, and track placements. **Clients** get a **read-only
transparency portal** + a **per-application feedback** channel that tunes the matching.

## 2. Hierarchy & roles

```
organization → memberships (admin | operator | viewer) → clients (assigned to an operator)
   → client_profiles → campaign (1:1) → campaign_matches → reports / placements → feedback
```
- **admin**: org + member management; everything operator can do, org-wide.
- **operator**: full client workflow, but only for clients **assigned to them**.
- **viewer**: org-wide read only.
- **client** (separate principal): read-only their own pipeline + insert feedback only; operator
  can toggle access (`clients.portal_enabled`).

## 3. Architecture (final — decided across the prior session)

```
fyj_scanner (THIS repo, unchanged)             fyj (NEW repo, Cloudflare)
── JOB INDEX, read-only to ops ──              ── ops-console ──
Supabase Postgres: 169k jobs, pgvector         Cloudflare Pages/Workers → Next.js UI (Clay-style)
search_jobs / get_job RPC  ◀── HTTPS ─────────  Workers → API + cron + queue matcher
scanner writes here                             Neon Postgres (own DB) via Hyperdrive — RLS kept
                                                R2 (resumes) · KV (job cache) · Queues+Cron (matcher)
                                                Better Auth (users/sessions/RBAC)
```

**Decision log (all settled — do not relitigate):**
- **Separate repos**, not a monorepo (different runtime + DB; only coupling is the read-only
  `search_jobs`/`get_job` API). *(Reversed an earlier monorepo lean once the CF/Neon split landed.)*
- **Cloudflare backend + Neon Postgres** for the ops DB — chosen over Cloudflare D1 specifically to
  **keep Postgres RLS** (D1/SQLite has none). "Move everything to Cloudflare" was rejected because
  the job index is Postgres-shaped (pgvector/partitioning/RLS).
- **Better Auth** (users in Neon), NOT Supabase Auth, NOT Clerk (Clerk's B2B Orgs is a paid add-on;
  not needed).
- **Two-principal RLS preserved on Neon.** Claim source = per-request `SET LOCAL app.*` GUCs set by
  the Worker (not Supabase's `auth.jwt()` hook). Request role `ops_app` has **no BYPASSRLS** (fails
  closed); the trusted matcher uses `ops_system` (BYPASSRLS), never on the request path.
- **1:1 profile→campaign**; **continuous/scheduled matching** (Cloudflare Cron + Queues);
  **operators restricted to assigned clients**; **client portal read-only + feedback-insert-only**.
- **UI takes visual inspiration from Clay** (app.clay.com): light/airy, slim icon rail, hero
  command bar, quick-action cards, clean data tables. Tokens in `docs/ops-console-ui.md`.
- **Models:** Haiku 4.5 triage; Opus 4.8 (or Sonnet 4.6) for A–G deep eval, prompt-cached.

## 4. Current state — what's where (IMPORTANT)

| Artifact | Location | Pushed? |
|---|---|---|
| Plan, UI spec, feature_list, progress | `fyj_scanner` branch `claude/dreamy-knuth-4m3wlz`, **PR #56** | ✅ pushed |
| **Ops-console P1 foundation code** | `fyj_scanner/docs/ops-console-foundation/` (transport copy) | ✅ pushed (here) |
| Same foundation as a real repo | was committed locally as `fyj` commit `8ae45de` | ❌ **never pushed** — lost with that container |
| The `fyj` GitHub repo | `https://github.com/Saikiran-linux/fyj.git` | **empty on remote** |

**Why the foundation is parked here:** the prior session was scoped to `fyj_scanner` only; its git
proxy returned `repository not authorized` for `Saikiran-linux/fyj`, so the code could not be
pushed to its own repo. It was copied into `docs/ops-console-foundation/` so it would survive in a
pushable repo. **This session presumably has `fyj` access — so transplant it now (§5).**

## 5. FIRST TASK — transplant the foundation into `fyj` and push

From a checkout that has **write access to `Saikiran-linux/fyj`**:

```bash
# clone the (empty) target
git clone https://github.com/Saikiran-linux/fyj.git
# copy the foundation in (from fyj_scanner/docs/ops-console-foundation/)
cp -r fyj_scanner/docs/ops-console-foundation/. fyj/
cd fyj
# branch + commit + push (open a DRAFT PR)
git checkout -b claude/ops-console-foundation
git add -A && git commit -m "feat: ops-console P1 foundation (Workers + Neon + RLS)"
git push -u origin claude/ops-console-foundation
```
Then open a **draft PR** into `fyj` `main`. (If `main` doesn't exist yet because the repo is empty,
push the branch and set it as the base, or push the initial commit to `main` to bootstrap.)

Verify after copying: `npm install`, `npm run cf-typegen`, `npm run typecheck` should pass
(modulo the placeholder binding ids in `wrangler.jsonc`).

## 6. Foundation file inventory (what's already built — f-131)

In `docs/ops-console-foundation/` (becomes the root of `fyj`):

| File | Purpose |
|---|---|
| `src/db/schema.ts` | Drizzle tenancy schema: organizations, memberships, clients, client_profiles, campaigns (1:1, `unique(profile_id)`), campaign_matches (`unique(campaign_id,job_id)`, `job_id`+`company_id` plain refs — **no FK to the index**), reports, placements, feedback (signal enum), audit_log. pgvector embedding on profiles. User refs are `text` (Better Auth ids). |
| `db/policies.sql` | **Security core.** `app.*` GUC reader helpers; `can_access_client` / `can_view_as_client` (SECURITY DEFINER); RLS enable + two-principal policies on all 10 tables; `ops_app` (no BYPASSRLS) + `ops_system` (BYPASSRLS, matcher only) roles. Apply **after** `drizzle-kit migrate`, every deploy. Idempotent. |
| `src/db/client.ts` | Hyperdrive/postgres.js + Drizzle; **`withTenant(db, principal, fn)`** sets per-request claims via `set_config(...,true)` inside a tx (fails closed). The only sanctioned way to touch tenant data. |
| `src/index-client.ts` | Read-only `searchJobs()` / `getJob()` — the contract to the fyj index (KV-cached). |
| `src/matcher.ts` | Continuous matcher: `listActiveCampaignIds` (cross-tenant, needs `ops_system`) + `runCampaignMatch` (incremental search since `last_run_at`, dedup upsert). |
| `src/index.ts` | Worker entry: `fetch` (Hono) + `scheduled` (enqueue active campaigns) + `queue` (run match). |
| `wrangler.jsonc` | Bindings: HYPERDRIVE, RESUMES (R2), JOB_CACHE (KV), MATCH_QUEUE (Queues), hourly cron, `nodejs_compat`, observability. **Placeholder ids to fill.** |
| `drizzle.config.ts`, `tsconfig.json`, `package.json`, `worker-configuration.d.ts`, `.dev.vars.example`, `.gitignore`, `README.md`, `docs/PLAN.md`, `docs/UI.md` | Project skeleton + copied specs. |

## 7. NEXT build steps (after the transplant)

- **f-132 — `search_jobs` / `get_job` RPC** in **`fyj_scanner`** (Supabase). Parameterized
  (`target_only` + family/seniority/remote/comp/recency + `since` for incremental), exposed for
  HTTPS calls, additive/backward-compatible. This is the read contract `src/index-client.ts`
  expects (`POST /rest/v1/rpc/search_jobs` → rows `{job_id, company_id, score}`). **Note the jobs PK
  is composite `(id, company_id)`, hash-partitioned.** Overlaps existing **f-114**.
- **f-133 — `fyj` app**: Better Auth wiring (two principals → resolve `Principal`), the
  **mandatory org-scoped Drizzle repository layer** (every call goes through `withTenant`), the
  tenant-scoped Hono API routes, org-create-on-signup + members/invite screen, then the **Next.js
  UI shell** per `docs/ops-console-ui.md`.
- Then f-134 (clients/profiles + resume→R2→embed), f-135 (wire the matcher live), f-136 (deep
  eval + CV + tracker), f-137 (client portal + feedback loop), f-138 (billing/digests).

## 8. Setup the human still needs to do (from `fyj/README.md`)

Neon project (+ `create extension vector, pgcrypto`; direct + pooled URLs) · `npm run db:generate`
+ `db:migrate` + `db:policies` (sets passwords for `ops_app`/`ops_system` in Neon) · Hyperdrive
config (pooled URL as `ops_app`) → id into `wrangler.jsonc` · R2 bucket `fyj-resumes` · KV
namespace · Queue `fyj-match` · secrets via `wrangler secret put` (BETTER_AUTH_SECRET,
OPENAI_API_KEY, ANTHROPIC_API_KEY, FYJ_INDEX_URL, FYJ_INDEX_KEY).

## 9. Gotchas / open items

- 🔴 **Rotate the Supabase service-role key** — a `sb_secret_...` value was pasted into the prior
  chat transcript. It was never used or committed, but it's exposed. Roll it (Supabase → Settings →
  API) and update the `SUPABASE_SERVICE_ROLE_KEY` GitHub Actions secret.
- **Cloudflare skills** are installed (workers-best-practices, wrangler, durable-objects, etc.) via
  `npx skills add https://github.com/cloudflare/skills`. The Workers skill says **retrieve latest CF
  docs over pre-trained knowledge** before writing/ reviewing Worker code.
- **RLS is the boundary, not app code** — but the repository layer is the first line. Worker DB role
  must stay non-`BYPASSRLS`. Forgetting a `SET LOCAL` denies all rows (safe).
- **No cross-DB joins** — match rows store `job_id`+`company_id`; hydrate detail via `getJob` + KV.
- Hard rules of `fyj_scanner` still hold (no parallel scans; idempotent `schema.sql`; LLM cost
  control). The matcher only *reads* the index, so it can't disturb the scan close-sweep.
