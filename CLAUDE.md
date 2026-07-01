# CLAUDE.md — agent entry point

You are working in **fyj_scanner**, a daily multi-tenant ATS scanner that produces a ~70k-job index in Supabase. This file is intentionally short — it points you at the right map and tells you the gotchas that the codebase can't enforce.

> **Read order for first session:**
> 1. This file (you're here)
> 2. [`claude-progress.md`](claude-progress.md) — what's verified-deployed right now and what changed last session
> 3. [`feature_list.json`](feature_list.json) — the canonical work tracker; never edit `TODO.md` directly anymore
> 4. [`README.md`](README.md) — runbook, SLA targets, dashboard queries
> 5. [`HOSTED_PLATFORM_PLAN.md`](HOSTED_PLATFORM_PLAN.md) — long-form vision (Phase 1 shipped; 2–6 planned)
> 6. [`docs/architecture.excalidraw`](docs/architecture.excalidraw) — full system diagram (sections A–G)

## Before you touch anything

Run `./init.sh` (Git Bash on Windows, or bash on Linux/macOS). It checks:
- Node ≥ 20.6
- `.env` present with `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` (and optionally `OPENAI_API_KEY` for LLM passes)
- `.env` is **not** tracked by git
- Supabase reachable, latest scan green
- (Windows) `NODE_EXTRA_CA_CERTS` points to a CA bundle that includes Norton's MITM root — otherwise every `fetch()` to OpenAI / Supabase fails with `UNABLE_TO_VERIFY_LEAF_SIGNATURE`. The file on this machine is `~/.career-ops/norton-root.pem`.

If init fails, **fix the cause before doing anything else**. Don't paper over it with `--insecure` or by disabling the check.

## Commands (only what you need most days)

| Task | Command |
|---|---|
| Verify the harness | `./init.sh` |
| Run scan locally | `npm run scan` |
| Backfill summaries / embeddings | `npm run backfill-summaries` · `npm run embed-backfill` |
| Match a resume against the index | `node scripts/embed-resume.mjs > scripts/_resume.vec` then `node scripts/call-match.mjs` |
| Tailor a resume to a job (f-402) | `npm run tailor -- --resume <md/txt> --job-id <uuid>` (or `--job-description <md/txt> --job-title "…"`) |
| Render resume markdown to printable HTML (f-406) | `npm run render -- <input.md> --open` (or `--compare <left.md> <right.md> --open`). Print → Save as PDF from the browser. |
| End-of-session checklist | [`docs/clean-state-checklist.md`](docs/clean-state-checklist.md) |

Full script list: [`package.json`](package.json).

## Hard rules

1. **Never commit `.env`.** It's gitignored. If you regenerate the SR key, rotate in GitHub Actions secrets too.
2. **Never run two scans in parallel.** The close-sweep would double-close jobs. The `concurrency: scan` group on `.github/workflows/scan.yml` enforces this — don't remove it.
3. **Schema changes go through `supabase/schema.sql` (idempotent), not the Studio UI.** Re-running schema.sql must be safe on every existing prod row.
4. **Don't bump `FINGERPRINT_VERSION` casually.** It silently breaks dedup across the version boundary. If you change the fingerprint algorithm, plan a backfill.
5. **`description_summary` and `embedding` cost real money.** The scheduled scan has `SKIP_LLM_PASSES=1` set. Local backfills are how those columns grow. Don't quietly flip the flag in CI.
6. **`pgrst_watch_ddl` trigger reloads PostgREST on schema changes.** If you add an RPC and the first call returns `PGRST002`, wait 2–3 s and retry — don't paper over it.

## Working agreement

- Treat [`feature_list.json`](feature_list.json) as the source of truth for "what's next." Update `status` and `evidence` as you finish things.
- At the end of every session, write a one-screen entry to the top of [`claude-progress.md`](claude-progress.md) and tick through [`docs/clean-state-checklist.md`](docs/clean-state-checklist.md). If you can't pass the checklist, say so explicitly in the progress entry instead of hiding it.
- For multi-session work, use [`docs/session-handoff.md`](docs/session-handoff.md) as the template.
- When reviewing your own output before claiming "done," score against [`docs/evaluator-rubric.md`](docs/evaluator-rubric.md). Premature victory declarations are the most common failure mode here (lecture 09).

## Where to look when something breaks

| Symptom | First place to look |
|---|---|
| Active-jobs total drops > 25% | Dashboard query 9 → query 6 (likely a provider-wide hiccup) |
| Block-rate red on one source | `src/rate-limiter.mjs`; check `scans.notes` for the snapshot |
| Company auto-disabled | `companies.last_error`; if 404, slug drifted (see TODO.md item P1) |
| Scan run timing out | Pooler saturation — lower `SCAN_WORKER_POOL`, not per-provider conc |
| `PGRST002` on a new RPC | PostgREST schema cache; wait 3 s and retry |
| OpenAI `UNABLE_TO_VERIFY_LEAF_SIGNATURE` | Norton TLS intercept; set `NODE_EXTRA_CA_CERTS` |

Codebase health snapshot per layer: [`docs/quality-document.md`](docs/quality-document.md).
