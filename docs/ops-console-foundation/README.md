# fyj — Ops Console

Multi-tenant staffing dashboard (Product A as a SaaS). Staffing orgs sign up; their
**operators** manage job-seeker **clients**; each client has targeting **profiles**, and a
1:1 **campaign** continuously matches that profile against the **fyj job index**. Clients get a
read-only transparency portal with a per-application feedback loop.

Full product/architecture spec: [`docs/PLAN.md`](docs/PLAN.md) · visual design:
[`docs/UI.md`](docs/UI.md).

## Architecture

```
This repo (Cloudflare)                          fyj_scanner (separate repo)
──────────────────────                          ───────────────────────────
Pages/Workers  →  Next.js UI (Clay-style)        Supabase Postgres = JOB INDEX
Workers        →  API + cron + queue matcher  ──▶ search_jobs / get_job  (read-only, HTTPS)
Neon Postgres  →  own data (orgs…feedback), RLS  scanner writes here
R2             →  resume files
KV             →  hydrated job-detail cache
Queues + Cron  →  continuous matcher (f-135)
Better Auth    →  users / sessions / RBAC
```

The job index is **read-only** to this app — the only coupling is the `search_jobs`/`get_job`
contract (`src/index-client.ts`). No cross-database foreign keys.

## Tenant isolation (read this before touching data code)

Enforced by **Postgres RLS on Neon**, not app code:

- The Worker authenticates a request (Better Auth), resolves the `Principal`, and every
  tenant-scoped query runs inside `withTenant()` (`src/db/client.ts`), which sets per-request
  GUCs (`app.org_id`, `app.role`, `app.principal`, `app.client_id`) via `set_config(..., true)`.
- Policies + helpers live in [`db/policies.sql`](db/policies.sql). Two principals: **staff**
  (admin/operator/viewer) and **client** (read-only + feedback-insert-only).
- The request Worker connects as **`ops_app`** (no `BYPASSRLS`) → forgetting a claim fails
  *closed*. The trusted background matcher connects as **`ops_system`** (`BYPASSRLS`), never on
  the request path.

## Setup

1. **Neon** — create a project; run `create extension if not exists vector; create extension if not exists pgcrypto;`. Grab the **direct** (migrations) and **pooled** (Hyperdrive) URLs.
2. **Install** — `npm install`.
3. **Schema** — `DATABASE_URL=<direct> npm run db:generate && DATABASE_URL=<direct> npm run db:migrate`.
4. **RLS + roles** — `DATABASE_URL=<direct> npm run db:policies` (creates `ops_app`/`ops_system`, RLS, helpers). Set their passwords in Neon.
5. **Hyperdrive** — `wrangler hyperdrive create fyj-ops --connection-string="<pooled, as ops_app>"`; paste the id into `wrangler.jsonc`.
6. **R2 / KV / Queue** — create `fyj-resumes`, a KV namespace, and the `fyj-match` queue; fill the ids in `wrangler.jsonc`.
7. **Secrets** — `wrangler secret put BETTER_AUTH_SECRET` (and `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `FYJ_INDEX_URL`, `FYJ_INDEX_KEY`). Local dev: copy `.dev.vars.example` → `.dev.vars`.
8. **Types** — `npm run cf-typegen` (regenerates `worker-configuration.d.ts` from bindings).
9. **Run** — `npm run dev`; **deploy** — `npm run deploy`.

## Status (P1 foundation)

Scaffolded: tenancy schema (`src/db/schema.ts`), RLS/GUC/roles (`db/policies.sql`), tenant DB
client (`src/db/client.ts`), read-only index client (`src/index-client.ts`), the matcher
(`src/matcher.ts`), and the Worker entry (`src/index.ts`).

TODO next: Better Auth wiring + the tenant-scoped API routes + repository layer (f-133), then
the Next.js UI shell. The fyj-side `search_jobs`/`get_job` RPCs (f-132) ship in `fyj_scanner`.
