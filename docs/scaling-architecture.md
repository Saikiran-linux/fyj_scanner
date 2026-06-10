# Scaling fyj_scanner to millions of jobs — architecture research

> **Status:** research / decision reference (not yet implemented). Captured 2026-06-10.
> **Question:** how to grow from a single Supabase Postgres (~117k active jobs, pgvector
> HNSW matching, daily scans, LLM summaries + embeddings) to **millions** of jobs while
> also storing the **raw ATS JSONB** responses for (1) replay/re-parse, (2) audit/compliance
> archive, (3) periodic analytics.
>
> **Scope decisions that shaped this** (from the requester): raw JSONB is for replay + audit +
> analytics (NOT hot ad-hoc queries); open to adding object storage, a dedicated vector DB,
> and a warehouse/OLAP; budget "optimize later — show best design, note cost."
>
> **Sourcing caveat:** several multipliers below come from vendor blogs (Tiger Data,
> ClickHouse, Turbopuffer/Morph). Pricing is verified against primary sources (Cloudflare R2
> docs, Turbopuffer). Treat headline multipliers ("28×", "95% cheaper", "3–5×/$") as
> directional, not gospel.

---

## TL;DR

The single highest-leverage move: **stop storing raw ATS JSONB in Postgres.** Write it to
object storage as compressed, batched **Parquet**, keep only a pointer (`raw_key` +
`content_hash`) and your extracted columns in Postgres, and let DuckDB/ClickHouse read that
same Parquet for analytics. Because the raw payload is for replay + audit + analytics (not hot
queries), this one decision solves blob storage, audit, **and** the warehouse at once — and it
defuses the silent cost bomb (backup/PITR explosion from TOASTed JSONB).

**Recommended stack**
- **Transactional core:** Supabase Postgres for structured `jobs` only — partitioned hot
  (active) / cold (closed). No raw blobs.
- **Raw blobs:** Cloudflare R2 (zero egress) as zstd Parquet, partitioned by date/company.
- **Vectors:** pgvector → **pgvectorscale (StreamingDiskANN)** to ~5–10M → **Turbopuffer**
  (object-storage-backed) when cold-heavy / RAM-bound.
- **Analytics:** **DuckDB** over the Parquet lake → **ClickHouse** (via PeerDB/ClickPipes CDC)
  when analytics gets heavy/real-time.

---

## Core principle: split storage by access pattern

One store doing four jobs with different access patterns is what breaks at millions of rows.

| Data | Access pattern | Belongs in |
|---|---|---|
| Structured job fields (title, comp, status, `last_seen_at`…) | Hot, transactional | **Postgres** (partitioned) |
| Embeddings | Hot-ish ANN search | **pgvector → pgvectorscale → Turbopuffer** |
| Raw ATS JSONB | Write-once, read-rarely | **Object storage (R2) as Parquet** |
| Aggregations / trends | Periodic, scan-heavy | **DuckDB / ClickHouse over that Parquet** |

---

## 1. Raw JSONB → object storage, not Postgres

**Why not Postgres.** JSONB > ~2 KB is TOASTed (out-of-line, compressed). Taxes that compound:
- **Update amplification:** changing any field rewrites the *entire* TOASTed value + full WAL —
  every re-scan of a barely-changed posting pays a full-payload rewrite.
- **Backup/PITR explosion (the silent killer):** a TB of TOASTed payloads inflates WAL, base
  backups, and PITR retention — a direct Supabase line-item.
- **Vacuum/bloat:** TOAST tables need their own autovacuum; millions of dead large values stall it.

**The move.** Keep raw out of PG. Store only `raw_key` (object path) + `content_hash` + extracted
columns. Write raw bytes to object storage.

**Storage target: Cloudflare R2** (verified, [R2 pricing](https://developers.cloudflare.com/r2/pricing/)):
- **$0.015/GB-month** standard ($0.01 infrequent-access), **egress free**, Class A (writes)
  $4.50/M, Class B (reads) $0.36/M.
- Zero egress is decisive for *replay/re-parse*: reading the whole archive back on S3 would cost
  $0.09/GB egress; on R2 a full re-parse is essentially free.
- S3 only wins back if you need Object Lock / Athena-Glue-native integration.

**File layout — batch into Parquet, NOT one object per response.** Millions of tiny objects =
brutal request costs + unusable for analytics. Write **partitioned, zstd-compressed Parquet**,
e.g. `s3://raw/dt=2026-06-10/company=foo/part-*.parquet`. Object count drops from millions to
thousands; zstd ~2.5× compression; the same files are directly queryable by
DuckDB/ClickHouse/Athena. Use NDJSON.gz instead if byte-exact audit fidelity matters more than
analytics ergonomics.

**Cost is a rounding error:** 50M payloads at ~10 KB compressed ≈ 500 GB ≈ **~$7.50/month**.

---

## 2. Keeping Postgres healthy at millions of rows

With blobs gone, the structured table is small (hundreds of bytes/row) and scales far. In order:

- **Declarative partitioning** (PG 17/18 is mature here). Natural split = **hot/cold by status**:
  active (`closed_at IS NULL`) in hot partitions, closed range-partitioned by month (trivial
  archival/drop). Matching + close-sweep only touch active. Optionally pin hot partitions to NVMe
  tablespaces, push cold to cheaper media.
- **Indexing:** keep partial indexes `WHERE closed_at IS NULL` (e.g. `jobs_active_idx`); they
  shrink once cold rows partition out.
- **Pooling:** **Supavisor** transaction-mode pooling for the scanner's worker fan-out.
- **When one Postgres isn't enough:** you'll hit storage/vector limits long before *transactional*
  limits (the scan is batch upsert, not high-QPS OLTP), so **Citus sharding is likely never
  needed.** If it ever is: Citus (scale-out), AlloyDB/Aurora (beefy managed single-node), or Neon
  (serverless). Far-future branch.

---

## 3. Vector search at millions

The real scaling pressure. Progression:

- **pgvector + HNSW** — great to **~1–5M** (sub-20ms @ 95%+ recall at 1M), but the graph is
  **entirely in RAM**, so it slows above 5–10M (~150 GB+ RAM at 50M×768d).
- **pgvectorscale (StreamingDiskANN)** — Timescale OSS extension on top of pgvector; index on
  **disk** with prefetching → bounded memory as you grow. **Cheapest robust default** (one fewer
  system; filtered/hybrid search stays in SQL). Vendor claim: 28× lower p95 / 16× throughput vs
  Pinecone @ 99% recall on 50M, ~75% less cost. Verify it installs on Supabase (it's OSS).
- **Turbopuffer** — object-storage-backed serverless; **best when vectors are cold-heavy**, which
  a job index is (most postings rarely matched). Verified: vectors on S3/GCS **~$0.02/GB**, hot
  data auto-cached to NVMe/RAM, **$64/mo min**, native BM25+vector **hybrid** + metadata filtering.
  "10–100× cheaper if mostly cold"; Cursor migrated and cut ~95%.
- **Pinecone/Qdrant** reference: Pinecone ~$170–370/mo @ 10M (1536d), Qdrant ~$120–180/mo; both
  RAM-priced → scale worse than object-backed options.

**Dimension note (ties to the Voyage decision):** 1024-dim (Voyage) = 4 KB/vector vs 1536-dim
(OpenAI) = 6 KB/vector — **33% less** storage + HNSW RAM + faster distance math. At 50M that's
200 GB vs 300 GB of index. The Voyage-embedding migration is also a **scaling** win.

**Recommendation:** ride **pgvectorscale** in Postgres until cost/RAM/recall bites (~5–10M), then
**offload to Turbopuffer** (cold-heavy, hybrid, multi-tenant via namespaces — exactly its sweet spot).

---

## 4. Analytics without hammering the transactional DB

The Parquet lake from §1 *is* the analytics substrate.

- **Start with DuckDB** — MIT, in-process, queries Parquet/Iceberg directly from object storage;
  run periodic analytics in a cron/Lambda/CI for ~$0. Single-node, not a shared warehouse — fine
  for "periodic."
- **Graduate to ClickHouse** when analytics gets heavy/real-time/multi-user. Killer feature:
  **first-class Postgres CDC** via **PeerDB** (OSS, now part of ClickHouse) or **ClickPipes**
  (managed) — sub-second lag, no batch-export plumbing. Reads Iceberg/70+ formats on the same lake.
- **BigQuery/Snowflake** — valid for zero-ops managed; pricier (Snowflake $1–3k/mo burns easily).
- **Table format:** when the lake matures, put **Iceberg** (or **DuckLake**) over the Parquet for
  ACID, schema evolution, and time-travel — directly useful for replay/re-parse.

---

## 5. Reference architecture + phased migration

```
                 ┌─────────────────────────────────────────┐
   daily scan ──▶│ 1. write raw payload → R2 (content-hash  │
                 │    key), batched into zstd Parquet        │
                 │ 2. upsert structured row → Postgres,      │
                 │    storing raw_key + content_hash         │
                 │ 3. embed → pgvectorscale (→ Turbopuffer)  │
                 └─────────────────────────────────────────┘
   Postgres (Supabase): partitioned jobs (hot active / cold closed) + vectors
   R2 (Parquet lake):   raw archive — replay, audit, analytics source
   DuckDB → ClickHouse: query the lake; ClickHouse via PeerDB CDC when needed
```

**Phases** (each independently valuable; do Phase 1 *before* hitting millions):

- **Phase 1 — de-risk Postgres (do now).** Raw JSONB → R2 Parquet; add `raw_key` pointer;
  partition `jobs` hot/cold. Highest leverage; shrinks the backup bill immediately.
- **Phase 2 (~1–5M).** Add `pgvectorscale`; Supavisor pooling; DuckDB-over-Parquet analytics.
- **Phase 3 (~10M+).** Offload vectors → Turbopuffer if cold-heavy; ClickHouse via PeerDB/ClickPipes
  CDC; adopt Iceberg/DuckLake over the lake.
- **Phase 4 (50M+).** Only if the *transactional* layer strains (unlikely): Citus/AlloyDB.

**Rough monthly cost bands** (order-of-magnitude; biased to the robust default):

| Scale | Postgres (structured+vectors) | Raw lake (R2) | Vectors if offloaded | Analytics | ~Total |
|---|---|---|---|---|---|
| **1M** | $25–100 (pgvector in-PG) | ~$1 | — | DuckDB ~$0 | **~$50–150** |
| **10M** | $150–400 (pgvectorscale) | ~$2–5 | *or* Turbopuffer ~$64–150 | DuckDB/ClickHouse ~$0–200 | **~$250–700** |
| **50M** | $400–800 (vectors offloaded) | ~$8–15 | Turbopuffer ~$150–400 | ClickHouse ~$200–500 | **~$800–1700** |

Cheapest-robust default = **R2 Parquet + pgvectorscale + DuckDB**.
Lowest-ops default = **R2 + Turbopuffer + ClickHouse Cloud**.

---

## Gotchas to design for now

- **Backup/PITR is the real cost bomb**, not storage — keeping big JSONB out of PG defuses it.
- **Idempotent scan across split storage:** make the R2 write **content-addressed**
  (`company/external_id/<content_hash>.json`) so a retried scan overwrites identically and never
  dupes; write blob first, then upsert the PG row pointing at it. Postgres stays source of truth;
  the close-sweep is unchanged (pure PG). No two-phase commit needed — the object write is idempotent.
- **TOAST update amplification** disappears once raw payloads are write-once in R2.
- **Multi-tenant isolation:** partition PG by `company_id`, RLS as today; Turbopuffer **namespace
  per tenant**.
- **Embedding storage compounds** — 1024-dim (Voyage) cuts vector storage/RAM 33% vs 1536-dim.
- **Don't one-object-per-response** — batch to Parquet, or request costs and analytics both suffer.

---

## Sources

- [Cloudflare R2 pricing](https://developers.cloudflare.com/r2/pricing/)
- [R2 vs S3 cost 2026](https://r2drop.com/blog/cloudflare-r2-vs-aws-s3-cost-comparison) · [egresscost.com](https://egresscost.com/cloudflare/)
- [pganalyze: JSONB/TOAST](https://pganalyze.com/blog/5mins-postgres-jsonb-toast) · [Snowflake: Postgres JSONB & TOAST](https://www.snowflake.com/en/blog/engineering/postgres-jsonb-columns-and-toast/)
- [credativ: JSONB compression tests](https://www.credativ.de/en/blog/postgresql-en/toasted-jsonb-data-in-postgresql-performance-tests-of-different-compression-algorithms/)
- [Supabase partitioning docs](https://supabase.com/docs/guides/database/partitions) · [Postgres partitioning 2026](https://medium.com/@fklezin/when-to-consider-postgres-partitioning-in-2026-71189ac88728)
- [Supavisor: 1M connections](https://supabase.com/blog/supavisor-1-million)
- [pgvectorscale GitHub](https://github.com/timescale/pgvectorscale) · [Tiger Data: pgvector vs Pinecone](https://www.tigerdata.com/blog/pgvector-is-now-as-fast-as-pinecone-at-75-less-cost) · [Instaclustr pgvector benchmark](https://www.instaclustr.com/education/vector-database/pgvector-performance-benchmark-results-and-5-ways-to-boost-performance/)
- [Turbopuffer vs Pinecone (Morph)](https://www.morphllm.com/comparisons/turbopuffer-vs-pinecone) · [pgvector/Pinecone/Turbopuffer/Qdrant 2026](https://app.daily.dev/posts/pgvector-vs-pinecone-vs-turbopuffer-vs-qdrant-2026--m1dot7ras) · [Vector DB pricing 2026](https://ranksquire.com/2026/03/04/vector-database-pricing-comparison-2026/)
- [ClickHouse vs DuckDB vs Snowflake](https://sfotex.com/blog/clickhouse-vs-duckdb-vs-snowflake/) · [ClickHouse real-time analytics 2026](https://clickhouse.com/resources/engineering/how-to-choose-a-database-for-real-time-analytics-in-2026) · [DuckDB/DuckLake](https://www.definite.app/blog/duckdb-ducklake-business-case) · [Top 10 warehouses 2026](https://motherduck.com/learn/top-10-data-warehouse-platforms-2026/)
