/**
 * Model pricing table — USD per 1M tokens.
 *
 * Mirrors the rates used by the Anthropic/OpenAI provider checkers in the API
 * package, but adds the cache rates an agent loop actually hits: a coding agent
 * re-sends its whole context every turn, so cache reads dominate token volume.
 *
 * `cacheWrite` / `cacheRead` default to Anthropic's multipliers when omitted:
 *   cache write (5m) = input * 1.25,  cache read = input * 0.10
 * Override any of this via ~/.kill-switch/agent-guard/pricing.json (see config.ts).
 */

export interface ModelPricing {
  /** USD per 1M input tokens */
  input: number;
  /** USD per 1M output tokens */
  output: number;
  /** USD per 1M cache-write tokens (defaults to input * 1.25) */
  cacheWrite?: number;
  /** USD per 1M cache-read tokens (defaults to input * 0.10) */
  cacheRead?: number;
}

/**
 * Keys are normalized model ids (see {@link normalizeModel}). We match by
 * longest-prefix so dated variants like `claude-3-5-sonnet-20241022` resolve
 * to the base `claude-3-5-sonnet` entry without enumerating every snapshot.
 */
export const MODEL_PRICING: Record<string, ModelPricing> = {
  // Anthropic — Claude
  "claude-opus-4": { input: 15.0, output: 75.0 },
  "claude-sonnet-4": { input: 3.0, output: 15.0 },
  "claude-haiku-4": { input: 0.8, output: 4.0 },
  "claude-3-7-sonnet": { input: 3.0, output: 15.0 },
  "claude-3-5-sonnet": { input: 3.0, output: 15.0 },
  "claude-3-5-haiku": { input: 0.8, output: 4.0 },
  "claude-3-opus": { input: 15.0, output: 75.0 },
  "claude-3-sonnet": { input: 3.0, output: 15.0 },
  "claude-3-haiku": { input: 0.25, output: 1.25 },

  // OpenAI
  "gpt-4o": { input: 2.5, output: 10.0 },
  "gpt-4o-mini": { input: 0.15, output: 0.6 },
  "gpt-4.1": { input: 2.0, output: 8.0 },
  "gpt-4.1-mini": { input: 0.4, output: 1.6 },
  "o3": { input: 2.0, output: 8.0 },
  "o4-mini": { input: 1.1, output: 4.4 },
};

/** Used when a model id matches nothing in the table — assume premium Sonnet-class rates so we under-estimate spend never. */
export const FALLBACK_PRICING: ModelPricing = { input: 3.0, output: 15.0 };

/**
 * Lowercase and strip provider prefixes (`anthropic/`, `openai/`) so ids from
 * different agents normalize to the same key space.
 */
export function normalizeModel(model: string): string {
  return model.toLowerCase().replace(/^(anthropic|openai)\//, "").trim();
}

/**
 * Resolve pricing for a model id by longest-matching-prefix against the table.
 * Falls back to {@link FALLBACK_PRICING} (premium rates) when nothing matches —
 * a kill switch should over-count an unknown model, not under-count it.
 */
export function pricingFor(
  model: string,
  table: Record<string, ModelPricing> = MODEL_PRICING,
): ModelPricing {
  const id = normalizeModel(model);
  if (table[id]) return table[id];

  let best: ModelPricing | undefined;
  let bestLen = -1;
  for (const [key, price] of Object.entries(table)) {
    if (id.startsWith(key) && key.length > bestLen) {
      best = price;
      bestLen = key.length;
    }
  }
  return best ?? FALLBACK_PRICING;
}
