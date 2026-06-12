# Capacity assessment — 3.6k → 50k companies

> **Status:** decision reference. Captured 2026-06-12 from live prod (`mwcpoaefmggapztkxakp`).
> **Question:** a ~50k active-company list is queued for onboarding (~13.7× today). Can the
> current implementation + infra process it? Companion to [`scaling-architecture.md`](scaling-architecture.md)
> (the millions-scale design); this is the near-term, measured 50k gap analysis.

## TL;DR

**The data model is ready; the current server is not.** The hard architectural work is done —
`jobs` is hash-partitioned (f-119), raw payloads are in R2, descriptions are split into
`job_descriptions`, and the scan shards (f-109, N=4 today, up to 60). The gates to 50k are
**operational, not architectural**: (1) a much bigger Supabase compute tier, (2) three
unbounded/bottleneck spots to fix first, (3) an embedding-scope decision. **Storage $ is a
rounding error; DB RAM/compute and the SmartRecruiters per-job fetch are the real gates.**

## Measured now vs projected at 50k (linear, same provider mix)

| | Now (measured) | ×13.7 → 50k |
|---|---|---|
| Active companies | 3,651 | ~50,000 |
| Active jobs | 106,264 | ~1.45M |
| Total jobs | 164,463 | ~2.25M |
| DB size | 987 MB | ~13–15 GB (structured) |
| `jobs` (16 partitions) | 396 MB | ~5.4 GB |
| `job_descriptions` | 506 MB | ~6.9 GB |
| `probe_results` | 62 MB / 321k rows | **unbounded — see gate 2** |
| Embeddings | 9,091 of 164k (71 MB) | **wildcard — see gate 4** |
| **Compute** | **Micro: ~1 GB RAM, ~2 shared vCPU, 60 conns, 256 MB shared_buffers** | needs ~8–16 GB |

The DB (987 MB) already exceeds `effective_cache_size` (768 MB), so cold queries don't fit in
cache — the reason the dashboard needed a materialized view to stop tripping the 8 s authenticator
timeout. At 14× on the same instance this gets much worse.

## The gates (priority order)

**1. Supabase compute — the #1 cost and blocker.** On entry **Micro (~1 GB RAM)** today. For
~1.5M active jobs with pgvector matching, plan **Large–XL (8–16 GB RAM, dedicated vCPU)** so the
working set + HNSW index stay resident; ~$110–210/mo compute. `max_connections` scales with the
tier (60 → 200+), needed for sharded writers. → tracked as **f-120**.

**2. `probe_results` has no retention — silent bomb.** One row per company per scan: 50k × ~4
scans/day = **~200k rows/day ≈ 73M/year**, nothing pruning it. Fix before onboarding (keep 7–30
days, or roll up to daily per-source aggregates then drop). → **f-904** (raise priority).

**3. Scan throughput / SmartRecruiters per-job fetch — tightest limit.** Listing probes
parallelize fine (50k / 20 shards ≈ 2,500/shard ≈ ~10 min). The bottleneck is SR: its listings
carry no descriptions, so the scanner fetches per job (`DESCRIPTION_FETCH_CAP=3000`/run). SR
already dominates new jobs (~5k/day of ~6.5k); at 14× that's **~70k new SR jobs/day**. Sharding
helps (each shard runs its own cap → N×3000), so ~N=20 shards sustains it — but the rate limiter
must hold ~60k SR fetches/run across 20 runner IPs. GitHub Actions caps concurrent matrix jobs
(~20 standard; *minutes* are free — repo is public), so practical N≈20 unless self-hosted runners
are added. → covered by **f-109** (bump matrix) + a description-fetch scaling note.

**4. Embeddings — scope decision drives sizing.** Only 9k embedded today. Embed **all** ~1.45M
active jobs → ~20 GB vectors + HNSW (forces a 32 GB instance). Embed only the **target/tech slice**
(`is_target=true`, ~35%) → a fraction. Decide scope; see
[`matching-embedding-assessment.md`](matching-embedding-assessment.md) (quantization makes either
cheaper). → **f-115 / f-124**.

## Not a problem
- **Storage $:** ~15 GB structured at ~$0.125/GB + R2 raw (~$7.50/mo for 500 GB) = trivial.
  Raw-in-R2 already defused the backup/PITR blowup.
- **LLM embeddings:** ~89k new/day ≈ **$21/mo** (negligible).
- **LLM summaries (gpt-4o-mini):** ~89k/day ≈ **~$270/mo** if summarizing the full inflow, plus a
  ~$145 one-time backfill of 1.45M — the biggest LLM line item, easily throttled/scoped to target.
- **Architecture rework:** none — partitioning, R2, description split, sharding all in place.

**Rough run-rate at 50k:** ~$400–500/mo, dominated by **DB compute (~$110–210)** and **LLM
summaries (~$270 if summarizing everything)**. Storage and embeddings are minor.

## Before flipping on 50k (checklist)
1. Bump Supabase compute to ~8–16 GB; re-baseline query latency. *(f-120)*
2. Add `probe_results` retention/rollup. *(f-904)*
3. Bump shard count and shard/scale the description-fetch pass; load-test SR throughput. *(f-109)*
4. Decide embedding scope (full vs target slice) → sizes the instance + backfill. *(f-115)*
5. **Stage it:** onboard ~5–10k first, watch scan wall-clock, pooler errors, block-rate, DB
   CPU/RAM, then ramp. Do not go 3.6k → 50k in one step.
