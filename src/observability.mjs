/**
 * Observability seams (Sentry · LangSmith · Cloudflare AI Gateway) — all
 * OPTIONAL and env-gated, matching the repo's existing feature gates
 * (embeddings/summaries isEnabled()): with no key in .env / Actions secrets
 * every helper is a no-op and the scanner behaves exactly as before.
 *
 *   • Sentry   — crashes + Cron monitors for the sharded scheduled scan, so a
 *                shard that stops firing ALERTS instead of failing silently.
 *                SENTRY_DSN enables it.
 *   • LangSmith— traces of the tailor actor-critic loop (generator/evaluator
 *                calls with token usage). LANGSMITH_API_KEY enables it.
 *   • AI Gateway — transport-level logging/cost/caching for the OpenAI +
 *                Anthropic calls via a base-URL swap. AI_GATEWAY_URL enables it
 *                (https://gateway.ai.cloudflare.com/v1/<account_id>/<gateway>).
 *                Voyage isn't a gateway-supported provider — those calls stay
 *                direct.
 *
 * Telemetry must never break a scan: every helper catches and warns.
 */

// ── Sentry (errors + cron monitors) ─────────────────────────────────────

let Sentry = null;

/** Call once at process start. Returns true when Sentry is active. */
export async function initErrorTracking(context = {}) {
  if (!process.env.SENTRY_DSN) return false;
  try {
    Sentry = await import('@sentry/node');
    Sentry.init({
      dsn: process.env.SENTRY_DSN,
      environment: process.env.SENTRY_ENVIRONMENT ?? 'production',
      release: process.env.GITHUB_SHA ?? undefined,
      sendDefaultPii: false,
      // Errors only — no perf tracing for a batch job.
      tracesSampleRate: 0,
    });
    Sentry.setContext('scan', context);
    return true;
  } catch (e) {
    console.warn(`sentry init failed (non-fatal): ${e.message}`);
    Sentry = null;
    return false;
  }
}

export function captureException(err, data = {}) {
  try {
    Sentry?.captureException(err, { data });
  } catch { /* telemetry never breaks the scan */ }
}

/**
 * Sentry Cron check-in for the scheduled scan. One monitor PER SHARD
 * (scan-shard-<i>) — shards are independent jobs, and a single dead shard
 * should alert on its own. The monitor config is upserted on every check-in;
 * keep `value` in lockstep with .github/workflows/scan.yml's cron.
 */
export function scanCheckIn(status, checkInId) {
  if (!Sentry) return undefined;
  try {
    const shard = process.env.SHARD_INDEX ?? '0';
    return Sentry.captureCheckIn(
      {
        ...(checkInId ? { checkInId } : {}),
        monitorSlug: `scan-shard-${shard}`,
        status, // 'in_progress' | 'ok' | 'error'
      },
      {
        schedule: { type: 'crontab', value: '17 0,6,12,18 * * *' },
        checkinMargin: 30, // GH Actions' schedule queue can lag; don't false-alarm
        maxRuntime: 35,    // hard-killed at 30 min by the workflow
        timezone: 'Etc/UTC',
      },
    );
  } catch (e) {
    console.warn(`sentry check-in failed (non-fatal): ${e.message}`);
    return undefined;
  }
}

/** Drain pending Sentry events before process exit (bounded). */
export async function flushTelemetry(timeoutMs = 2000) {
  try {
    await Sentry?.flush(timeoutMs);
  } catch { /* best-effort */ }
}

// ── LangSmith (LLM traces) ───────────────────────────────────────────────

/**
 * Wrap a function as a LangSmith run when LANGSMITH_API_KEY is set; otherwise
 * return it untouched (zero overhead). Nesting propagates automatically on
 * Node via AsyncLocalStorage, so wrapping tailor() and chat() yields a parent
 * run with generator/evaluator children.
 *
 * `tracingEnabled: true` is forced — traceable's default gates on the
 * LANGSMITH_TRACING env flag and silently records nothing without it (verified
 * live); for us the key's presence IS the intent to trace. One shared Client so
 * flushTraces() can drain the batch before a short-lived CLI process exits.
 */
let _lsClient = null;

export async function maybeTraceable(fn, opts) {
  if (!process.env.LANGSMITH_API_KEY) return fn;
  try {
    const { traceable } = await import('langsmith/traceable');
    if (!_lsClient) {
      const { Client } = await import('langsmith');
      _lsClient = new Client({ apiKey: process.env.LANGSMITH_API_KEY });
    }
    return traceable(fn, {
      client: _lsClient,
      tracingEnabled: true,
      project_name: process.env.LANGSMITH_PROJECT ?? 'fyj-scanner',
      ...opts,
    });
  } catch (e) {
    console.warn(`langsmith init failed (non-fatal): ${e.message}`);
    return fn;
  }
}

/** Drain pending LangSmith batches — call before a CLI process exits. */
export async function flushTraces() {
  try {
    await _lsClient?.awaitPendingTraceBatches();
  } catch { /* best-effort */ }
}

// ── Cloudflare AI Gateway (LLM transport) ────────────────────────────────

const gw = () => (process.env.AI_GATEWAY_URL ?? '').replace(/\/+$/, '');

export function openaiChatUrl() {
  return gw() ? `${gw()}/openai/chat/completions` : 'https://api.openai.com/v1/chat/completions';
}

export function anthropicMessagesUrl() {
  return gw() ? `${gw()}/anthropic/v1/messages` : 'https://api.anthropic.com/v1/messages';
}

/** Extra headers for authenticated gateways ({} when not configured). */
export function aiGatewayHeaders() {
  return gw() && process.env.AI_GATEWAY_TOKEN
    ? { 'cf-aig-authorization': `Bearer ${process.env.AI_GATEWAY_TOKEN}` }
    : {};
}
