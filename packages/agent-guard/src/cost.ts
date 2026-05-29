/**
 * Turn token usage into dollars.
 *
 * Both the hook (parsing the Claude Code transcript) and the proxy (parsing live
 * API responses) produce a {@link TokenUsage} and feed it through here, so cost
 * math lives in exactly one place.
 */

import { pricingFor, type ModelPricing } from "./pricing.js";

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  /** Anthropic cache-write tokens (a.k.a. cache_creation_input_tokens) */
  cacheCreationTokens?: number;
  /** Anthropic cache-read tokens (a.k.a. cache_read_input_tokens) */
  cacheReadTokens?: number;
}

const PER_MILLION = 1_000_000;

/** Effective cache rates, applying Anthropic's default multipliers when a model omits them. */
function cacheRates(p: ModelPricing): { write: number; read: number } {
  return {
    write: p.cacheWrite ?? p.input * 1.25,
    read: p.cacheRead ?? p.input * 0.1,
  };
}

/** Cost in USD for a single usage record on a given model. */
export function costForUsage(
  model: string,
  usage: TokenUsage,
  table?: Record<string, ModelPricing>,
): number {
  const p = pricingFor(model, table);
  const { write, read } = cacheRates(p);
  const input = usage.inputTokens || 0;
  const output = usage.outputTokens || 0;
  const cacheWrite = usage.cacheCreationTokens || 0;
  const cacheRead = usage.cacheReadTokens || 0;

  return (
    (input * p.input +
      output * p.output +
      cacheWrite * write +
      cacheRead * read) /
    PER_MILLION
  );
}

/** Total token count across all four buckets — for display / "tokens burned" metrics. */
export function totalTokens(usage: TokenUsage): number {
  return (
    (usage.inputTokens || 0) +
    (usage.outputTokens || 0) +
    (usage.cacheCreationTokens || 0) +
    (usage.cacheReadTokens || 0)
  );
}

/** Format a USD amount for terminal output. */
export function fmtUSD(n: number): string {
  return `$${n.toFixed(n < 1 ? 4 : 2)}`;
}
