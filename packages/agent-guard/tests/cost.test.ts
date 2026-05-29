import { describe, it, expect } from "vitest";
import { costForUsage } from "../src/cost.js";
import { pricingFor, normalizeModel } from "../src/pricing.js";

describe("pricing resolution", () => {
  it("matches dated snapshots by longest prefix", () => {
    expect(pricingFor("claude-3-5-sonnet-20241022").input).toBe(3.0);
    expect(pricingFor("claude-sonnet-4-20250101").output).toBe(15.0);
  });

  it("strips provider prefixes", () => {
    expect(normalizeModel("anthropic/claude-3-haiku")).toBe("claude-3-haiku");
    expect(normalizeModel("openai/GPT-4o")).toBe("gpt-4o");
  });

  it("falls back to premium rates for unknown models (never under-count)", () => {
    expect(pricingFor("totally-unknown-model")).toEqual({ input: 3.0, output: 15.0 });
  });
});

describe("costForUsage", () => {
  it("prices plain input/output", () => {
    // 1M input @ $3 + 1M output @ $15 = $18
    const cost = costForUsage("claude-sonnet-4", { inputTokens: 1_000_000, outputTokens: 1_000_000 });
    expect(cost).toBeCloseTo(18, 6);
  });

  it("applies default cache multipliers (write 1.25x, read 0.10x of input)", () => {
    // cache write 1M @ 3*1.25=3.75 ; cache read 1M @ 3*0.10=0.30
    const cost = costForUsage("claude-sonnet-4", {
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationTokens: 1_000_000,
      cacheReadTokens: 1_000_000,
    });
    expect(cost).toBeCloseTo(3.75 + 0.3, 6);
  });

  it("prices OpenAI models", () => {
    // gpt-4o: 1M in @ 2.5 + 1M out @ 10 = 12.5
    expect(costForUsage("gpt-4o", { inputTokens: 1_000_000, outputTokens: 1_000_000 })).toBeCloseTo(12.5, 6);
  });
});
