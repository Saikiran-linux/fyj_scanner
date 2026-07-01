/**
 * Per-source rate limiter with adaptive throttling.
 *
 * Target: sustained <1% block rate (403/429) per provider.
 *
 * Each provider has its own bucket:
 *   - concurrency: max in-flight requests
 *   - minIntervalMs: minimum gap between any two requests starting
 *   - throttleState: a tiny rolling-window counter of recent outcomes
 *
 * Adaptive policy:
 *   - If block-rate over last N requests > 5% → halve concurrency, double interval
 *   - If block-rate over last N requests < 1% AND we previously throttled → step
 *     back toward the defaults (one step per scan)
 *
 * Why per-provider, not global? Greenhouse returned 0 blocks at 20-way
 * concurrency; Ashby returned 14% at the same rate. A single global setting
 * either hammers Ashby or under-utilizes Greenhouse. The fix is independent
 * budgets per source.
 */

const WINDOW = 20; // recent-outcome rolling window
const BLOCK_THRESHOLD = 0.05; // 5% in the window triggers throttle
const RECOVER_THRESHOLD = 0.01; // 1% in the window allows recovery

// Tuned from the viability run (Greenhouse 0% blocks fast, Ashby 14% at speed).
// Conservative defaults; the limiter adapts up or down as it learns.
const DEFAULTS = {
  greenhouse: { concurrency: 10, minIntervalMs: 0 },
  ashby: { concurrency: 3, minIntervalMs: 200 },
  lever: { concurrency: 5, minIntervalMs: 100 },
  smartrecruiters: { concurrency: 3, minIntervalMs: 100 },
  // Workday paginates (many sequential POSTs per tenant) and is quick to
  // rate-limit; keep it conservative. Listed here (vs. the auto-created default
  // bucket) so it also auto-recovers after a throttle, like the others.
  workday: { concurrency: 3, minIntervalMs: 200 },
};

const FLOOR = { concurrency: 1, minIntervalMs: 50 };
const CEILING = { concurrency: 20, minIntervalMs: 0 };

export class RateLimiter {
  constructor(overrides = {}) {
    this.buckets = {};
    for (const [ats, defaults] of Object.entries(DEFAULTS)) {
      const cfg = { ...defaults, ...(overrides[ats] || {}) };
      this.buckets[ats] = {
        ats,
        concurrency: cfg.concurrency,
        minIntervalMs: cfg.minIntervalMs,
        inFlight: 0,
        nextSlotAt: 0,
        outcomes: [], // ring of 'ok' | 'block' | 'error'
        queue: [], // pending resolvers
        adapted: false, // true once we've throttled this run
        counters: { ok: 0, block: 0, error: 0, throttled: 0 },
      };
    }
  }

  bucket(ats) {
    if (!this.buckets[ats]) {
      this.buckets[ats] = {
        ats,
        concurrency: 3,
        minIntervalMs: 100,
        inFlight: 0,
        nextSlotAt: 0,
        outcomes: [],
        queue: [],
        adapted: false,
        counters: { ok: 0, block: 0, error: 0, throttled: 0 },
      };
    }
    return this.buckets[ats];
  }

  /**
   * Acquire a slot. Returns a `release` function that the caller must invoke
   * exactly once with the outcome ('ok' | 'block' | 'error') so the limiter
   * can adapt. Outcomes:
   *   - 'ok'   : 2xx response (including zero-job tenants)
   *   - 'block': 403, 429
   *   - 'error': everything else (4xx other, 5xx, timeout, network)
   */
  async acquire(ats) {
    const b = this.bucket(ats);

    // Wait until in-flight < concurrency AND now >= nextSlotAt.
    while (true) {
      const now = Date.now();
      if (b.inFlight < b.concurrency && now >= b.nextSlotAt) {
        b.inFlight++;
        b.nextSlotAt = now + b.minIntervalMs;
        return (outcome) => this.release(b, outcome);
      }
      const waitMs = Math.max(
        b.inFlight >= b.concurrency ? 50 : b.nextSlotAt - now,
        10,
      );
      await new Promise((r) => setTimeout(r, waitMs));
    }
  }

  release(b, outcome) {
    b.inFlight--;
    b.counters[outcome] = (b.counters[outcome] || 0) + 1;
    b.outcomes.push(outcome);
    if (b.outcomes.length > WINDOW) b.outcomes.shift();
    this.adapt(b);
  }

  adapt(b) {
    if (b.outcomes.length < WINDOW) return;
    const blocks = b.outcomes.filter((o) => o === 'block').length;
    const blockRate = blocks / b.outcomes.length;

    if (blockRate > BLOCK_THRESHOLD) {
      const newConc = Math.max(FLOOR.concurrency, Math.floor(b.concurrency / 2));
      const newInterval = Math.max(b.minIntervalMs * 2, 200);
      if (newConc !== b.concurrency || newInterval !== b.minIntervalMs) {
        console.error(
          `[ratelimit] ${b.ats}: block-rate ${(blockRate * 100).toFixed(1)}% over last ${WINDOW} → ` +
            `concurrency ${b.concurrency}→${newConc}, interval ${b.minIntervalMs}→${newInterval}ms`,
        );
        b.concurrency = newConc;
        b.minIntervalMs = newInterval;
        b.adapted = true;
        b.counters.throttled++;
      }
    } else if (blockRate < RECOVER_THRESHOLD && b.adapted) {
      // Gentle recovery: only one step per WINDOW outcomes to avoid oscillation.
      const def = DEFAULTS[b.ats];
      if (def) {
        const newConc = Math.min(def.concurrency, b.concurrency + 1);
        const newInterval = Math.max(def.minIntervalMs, Math.floor(b.minIntervalMs / 2));
        if (newConc !== b.concurrency || newInterval !== b.minIntervalMs) {
          console.error(
            `[ratelimit] ${b.ats}: block-rate ${(blockRate * 100).toFixed(1)}% → ` +
              `recover concurrency ${b.concurrency}→${newConc}, interval ${b.minIntervalMs}→${newInterval}ms`,
          );
          b.concurrency = newConc;
          b.minIntervalMs = newInterval;
        }
      }
    }
  }

  /** Snapshot for end-of-scan logging / persistence. */
  snapshot() {
    const out = {};
    for (const [ats, b] of Object.entries(this.buckets)) {
      const total = b.counters.ok + b.counters.block + b.counters.error;
      out[ats] = {
        concurrency: b.concurrency,
        min_interval_ms: b.minIntervalMs,
        ok: b.counters.ok,
        block: b.counters.block,
        error: b.counters.error,
        block_rate_pct: total ? Number(((b.counters.block / total) * 100).toFixed(2)) : 0,
        throttled_steps: b.counters.throttled,
      };
    }
    return out;
  }
}
