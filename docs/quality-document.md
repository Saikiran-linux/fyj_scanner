# docs/quality-document.md — codebase health snapshot

A blunt grade per layer of the system. Updated when the underlying reality shifts; the date at the top is when these grades were last earned, not when the file was last touched. Lecture 11 in the harness syllabus: observability inside the harness — this is the slow-moving counterpart to dashboards.

> **Snapshot date: 2026-05-23.** Based on live state captured for `claude-progress.md` (4,622 companies / 70,518 active jobs / last scan ok).

## Grade scale

- **A** — solid, idiomatic, well-tested, well-observed; would publish as-is.
- **B** — works reliably; minor sharp edges or coverage gaps, all known.
- **C** — works but fragile, under-observed, or carrying technical debt that will bite within 1–2 quarters.
- **D** — known broken paths or coverage holes; functional only because nobody's hit the gap yet.
- **F** — not shipped; placeholder or stub.

---

## Layer grades

### Scanner core — **B+**

`src/scan.mjs`, `src/providers.mjs`, `src/rate-limiter.mjs`, `src/fingerprint.mjs`, `src/html-to-text.mjs`, `src/supabase-client.mjs`.

**Strong:** 38 successful scans in last 7 days; adaptive rate limiter is real and persists snapshots to `scans.notes`; per-company error tracking + auto-disable threshold; close-sweep semantics correct (failed companies don't close jobs).

**Weak:** Limiter snapshot lives in `notes` string (f-103 will move it to a structured jsonb column once format stabilises); pre-fetch active snapshot is O(active-jobs) every run (~70k rows now — fine, will hurt at 500k); no end-to-end integration test, only manual smoke.

**Promoting to A needs:** structured `source_metrics` column, an integration test that probes a fake provider, and graphing block-rate over time.

---

### Enrichment pipeline (LLM) — **C+**

`src/summarize.mjs` (gpt-4o-mini, 14-field), `src/embeddings.mjs` (text-embedding-3-small).

**Strong:** Both modules retry properly with exponential backoff + Retry-After honour; cost estimates emitted per batch; description-change trigger auto-nulls embeddings; the embed-text builder is deterministic and matches what the resume-side script produces.

**Weak:** Coverage is only **15.0 %** (summary) / **15.9 %** (embedding) of active jobs because the scheduled scan has `SKIP_LLM_PASSES=1`. The backfill commands work but require a human to run them with `OPENAI_API_KEY` set locally. No automated quality eval of the summaries — they look right by inspection only.

**Promoting to B needs:** drain the backlog (f-007 / f-008 — one-shot, ~$14 / 25 min); add a tiny eval set (20 jobs, 5 query types) so we can detect summary-quality regressions when the prompt changes.

---

### Database schema — **A−**

`supabase/schema.sql`, `supabase/dashboard-queries.sql`.

**Strong:** Fully idempotent (re-runs cleanly against prod); all the cross-cutting concerns are first-class (RLS, vector index, triggers, MVs); the `description_summary → embedding null` trigger is exactly the right denormalised state-machine for this problem; dashboard queries are saved and ergonomic.

**Weak:** No migration history file — schema.sql is a "current desired state" doc, which is fine at this size but will hurt if we ever need to roll back a specific change; `applications` and `feedback` tables are planned (phase 4/5) but not in schema.sql yet; HNSW vs IVFFlat choice is documented inline but the trade-off should probably be re-evaluated at 500k rows.

**Promoting to A needs:** lightweight migration tracking (a `_migrations` table noting which named change ran when) once the schema starts evolving multiple times per week.

---

### Resume-matching — **B**

`scripts/embed-resume.mjs`, `scripts/call-match.mjs`, `public.match_resume(vector, int)` RPC.

**Strong:** Symmetric to the JD embedding (same title + signal block + 14-field summary shape, same model); inline cost is ~$0.000009 per resume; RPC is reusable; returned cosine similarities are interpretable (0.74–0.80 range).

**Weak:** The 14-field resume summary is currently hand-authored inside `embed-resume.mjs` — not LLM-extracted from the actual resume PDF. A real user flow needs the process-resume edge function (planned f-201) to turn an uploaded PDF into the same schema automatically. Only 15.9 % of jobs have embeddings (see Enrichment) so matching is over a small slice.

**Promoting to A needs:** PDF → 14-field summary edge function (f-201 in feature_list.json) + drain the embedding backlog.

---

### Status page — **B**

`status-page/` (Next.js admin dashboard).

**Strong:** Auto-fetches recent state; SLA cards on the landing page; per-company / per-scan / per-job drill-downs; deployed read-only with the anon key (no auth wiring needed).

**Weak:** No tests; the `InteractiveChart` component is one of those "looks fine until it doesn't" pieces; not visually polished for end users (intentional — it's admin-only); planned end-user app (phase 2+) will need a different surface entirely.

**Promoting to A needs:** end-user app actually exists (phase 2+); this admin surface stays at B by design.

---

### Ops + harness — **B+** (was C before today)

`README.md`, `HOSTED_PLATFORM_PLAN.md`, `feature_list.json`, `CLAUDE.md`, `init.sh`, `claude-progress.md`, `docs/*`.

**Strong:** Harness layout adopted in full (8 files); `init.sh` smoke-checks the whole setup in <5 s and currently passes 9/9; the system architecture diagram (`docs/architecture.excalidraw`) is comprehensive; `feature_list.json` migrated from `TODO.md` and grounded in real state.

**Weak:** No automated CI that runs `init.sh` on PRs; the evaluator rubric is brand new and the self-scoring habit hasn't been exercised yet; `TODO.md` is still in the repo as a redirect — should be removed after one more session.

**Promoting to A needs:** GitHub Action that runs `init.sh` + lint on every PR; second session that demonstrates the rubric + clean-state-checklist actually get used.

---

### Planned hosted-platform (phase 2+) — **F**

Per `HOSTED_PLATFORM_PLAN.md` and the `docs/architecture.excalidraw` dashed boxes.

**Status:** None of phase 2 / 3 / 4 / 5 / 6 is built. Schema for `user_profiles` and Storage bucket policies are in `supabase/schema.sql`, but no edge functions, no Next.js end-user app, no Clerk, no Stripe, no Inngest, no Browserless, no Resend integration. The CV-tailor pipeline v1 (generator + Haiku evaluator + retry-with-critique loop, § D in the diagram) is designed and unimplemented; the v2 multi-agent shape is explicitly deferred to `feature_list.json#f-405` and won't be built unless v1 quality plateaus.

**Promoting:** This grade only moves once phase-2 code lands.

---

## Trend

Compared to the snapshot you'd have written before today's session:

- Scanner core: unchanged (B+).
- Enrichment: unchanged (C+) — coverage didn't move; only the visibility did.
- Schema: unchanged (A−).
- Resume-matching: **new** — added at B.
- Status page: unchanged (B).
- Ops + harness: **C → B+** — biggest jump of the session; entire harness layout adopted.
- Planned hosted-platform: unchanged (F).

The overall repo isn't *better at running the scanner* than it was yesterday — the scanner already worked. It's better at *being picked up by the next session without losing context*, which is what the harness adoption was for.
