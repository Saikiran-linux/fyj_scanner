/**
 * Provider-flexible LLM client for the tailor pipeline.
 *
 * Today: OpenAI (gpt-5.4-mini for the generator, gpt-5-mini for the
 * evaluator) because that's the key we have on this machine.
 *
 * Tomorrow: swap to Anthropic by setting ANTHROPIC_API_KEY and changing
 * PROVIDER below to 'anthropic'. The call shapes are identical from the
 * caller's POV — input = system + user messages, output = text + usage.
 *
 * Plan reference: docs/architecture.excalidraw § D (generator = Sonnet,
 * evaluator = Haiku). The OpenAI mapping is gpt-5.4-mini ≈ Sonnet quality
 * and gpt-5-mini ≈ Haiku price.
 */

const PROVIDER = process.env.TAILOR_PROVIDER
  || (process.env.ANTHROPIC_API_KEY ? 'anthropic' : 'openai');

// Model handles per role. Sized so the generator gets the smart writer
// and the evaluator gets the cheap critic — the whole point of the
// actor-critic split.
const MODELS = {
  openai: {
    generator: 'gpt-5.4-mini',   // $0.75/M in · $4.50/M out
    evaluator: 'gpt-5-mini',     // $0.25/M in · $2.00/M out
  },
  anthropic: {
    generator: 'claude-sonnet-4-6',
    evaluator: 'claude-haiku-4-5',
  },
};

// Per-million-token USD prices for cost estimation. Numbers below are
// the public list rates as of mid-2026; bump when models change.
const PRICES = {
  'gpt-5.4-mini':        { in: 0.75, out:  4.50 },
  'gpt-5-mini':          { in: 0.25, out:  2.00 },
  'claude-sonnet-4-6':   { in: 3.00, out: 15.00 },
  'claude-haiku-4-5':    { in: 1.00, out:  5.00 },
};

export function getModel(role) {
  const m = MODELS[PROVIDER]?.[role];
  if (!m) throw new Error(`no model configured for provider=${PROVIDER} role=${role}`);
  return m;
}

export function estimateCostUSD(model, inputTokens, outputTokens) {
  const p = PRICES[model];
  if (!p) return null;
  return (inputTokens / 1e6) * p.in + (outputTokens / 1e6) * p.out;
}

/**
 * One LLM call. Returns { text, inputTokens, outputTokens, costUSD, model }.
 * Throws on any error — the loop catches and decides whether to retry.
 *
 * Why no built-in retry: the loop above us already retries by re-running
 * the generator with the evaluator's critique. Adding an inner retry layer
 * would double-spend on rate-limited calls. Single attempt; the loop is
 * the resilience boundary.
 */
export async function chat({ role, system, user, maxTokens = 2000, responseFormat }) {
  const model = getModel(role);

  if (PROVIDER === 'openai') {
    const key = process.env.OPENAI_API_KEY;
    if (!key) throw new Error('OPENAI_API_KEY missing');

    const body = {
      model,
      max_completion_tokens: maxTokens,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
    };
    if (responseFormat === 'json') body.response_format = { type: 'json_object' };

    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`openai ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const data = await res.json();
    const text = data?.choices?.[0]?.message?.content?.trim() ?? '';
    const inputTokens = data?.usage?.prompt_tokens ?? 0;
    const outputTokens = data?.usage?.completion_tokens ?? 0;
    return { text, inputTokens, outputTokens, costUSD: estimateCostUSD(model, inputTokens, outputTokens), model };
  }

  if (PROVIDER === 'anthropic') {
    const key = process.env.ANTHROPIC_API_KEY;
    if (!key) throw new Error('ANTHROPIC_API_KEY missing');

    const body = {
      model,
      max_tokens: maxTokens,
      temperature: role === 'generator' ? 0.3 : 0,
      system,
      messages: [{ role: 'user', content: user }],
    };
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`anthropic ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const data = await res.json();
    const text = data?.content?.[0]?.text?.trim() ?? '';
    const inputTokens = data?.usage?.input_tokens ?? 0;
    const outputTokens = data?.usage?.output_tokens ?? 0;
    return { text, inputTokens, outputTokens, costUSD: estimateCostUSD(model, inputTokens, outputTokens), model };
  }

  throw new Error(`unknown TAILOR_PROVIDER=${PROVIDER}`);
}

export { PROVIDER };
