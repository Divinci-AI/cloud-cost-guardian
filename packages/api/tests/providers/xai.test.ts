/**
 * xAI Provider Tests
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../src/providers/shared.js", () => ({
  providerFetch: vi.fn(),
  evaluateViolations: vi.fn().mockReturnValue([]),
  estimateTokenCost: vi.fn().mockReturnValue(0),
}));

import { xaiProvider } from "../../src/providers/xai/checker.js";
import { providerFetch, evaluateViolations, estimateTokenCost } from "../../src/providers/shared.js";

const cred = { provider: "xai" as const, xaiApiKey: "xai-test-key" };

// ─── checkUsage ────────────────────────────────────────────────────────────

describe("xAI Provider — checkUsage", () => {
  beforeEach(() => vi.clearAllMocks());

  it("sums tokens from usage API", async () => {
    vi.mocked(providerFetch).mockResolvedValueOnce({
      data: [
        { model: "grok-2",      input_tokens: 400_000, output_tokens: 80_000 },
        { model: "grok-2-mini", input_tokens: 100_000, output_tokens: 20_000 },
      ],
    });

    const result = await xaiProvider.checkUsage(cred, {});

    expect(providerFetch).toHaveBeenCalledWith(
      expect.stringContaining("x.ai"),
      expect.stringContaining("/usage"),
      expect.any(Object),
      "xAI"
    );
    expect(result.services[0].metrics[0].value).toBe(600_000); // total tokens
  });

  it("supports OpenAI-compatible field names (n_context_tokens_total)", async () => {
    vi.mocked(providerFetch).mockResolvedValueOnce({
      data: [
        { model: "grok-2", n_context_tokens_total: 300_000, n_generated_tokens_total: 50_000 },
      ],
    });

    const result = await xaiProvider.checkUsage(cred, {});
    expect(result.services[0].metrics[0].value).toBe(350_000);
  });

  it("accountId is always 'xai'", async () => {
    vi.mocked(providerFetch).mockResolvedValueOnce({ data: [] });
    const result = await xaiProvider.checkUsage(cred, {});
    expect(result.accountId).toBe("xai");
  });

  it("falls back to /models ping when usage call fails", async () => {
    vi.mocked(providerFetch)
      .mockRejectedValueOnce(new Error("network"))
      .mockResolvedValueOnce({ data: [{ id: "grok-2" }] });

    const result = await xaiProvider.checkUsage(cred, {});
    expect(result.services[0].metrics[0].value).toBe(0);
    expect(result.totalEstimatedDailyCostUSD).toBe(0);
  });

  it("throws when both usage and models ping fail", async () => {
    vi.mocked(providerFetch)
      .mockRejectedValueOnce(new Error("network"))
      .mockRejectedValueOnce(new Error("401 Unauthorized"));

    await expect(xaiProvider.checkUsage(cred, {})).rejects.toThrow("Failed to connect to xAI API");
  });

  it("passes services to evaluateViolations with correct cost key", async () => {
    vi.mocked(providerFetch).mockResolvedValueOnce({ data: [] });

    await xaiProvider.checkUsage(cred, { xaiDailyCostUSD: 50 });

    expect(evaluateViolations).toHaveBeenCalledWith(
      expect.arrayContaining([expect.objectContaining({ serviceName: "xai:api" })]),
      expect.any(Object),
      expect.any(Number),
      "xaiDailyCostUSD",
      "xai-billing",
      expect.any(Object)
    );
  });

  it("calls estimateTokenCost for each entry", async () => {
    vi.mocked(providerFetch).mockResolvedValueOnce({
      data: [{ model: "grok-2", input_tokens: 100, output_tokens: 50 }],
    });

    await xaiProvider.checkUsage(cred, {});
    expect(estimateTokenCost).toHaveBeenCalledWith(
      expect.any(Object),
      "grok-2",
      "grok-2",
      100,
      50
    );
  });

  it("handles missing data array gracefully", async () => {
    vi.mocked(providerFetch).mockResolvedValueOnce({});
    const result = await xaiProvider.checkUsage(cred, {});
    expect(result.services[0].metrics[0].value).toBe(0);
  });
});

// ─── executeKillSwitch ─────────────────────────────────────────────────────

describe("xAI Provider — executeKillSwitch", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns manual instructions for rotate-creds", async () => {
    const result = await xaiProvider.executeKillSwitch(cred, "xai:api", "rotate-creds");
    expect(result.success).toBe(false);
    expect(result.details).toContain("manual action");
    expect(result.details).toContain("console.x.ai");
  });

  it("returns unsupported for non-rotate actions", async () => {
    const actions = ["delete", "scale-down", "disconnect", "stop-instances"] as const;
    for (const action of actions) {
      const result = await xaiProvider.executeKillSwitch(cred, "xai:api", action as any);
      expect(result.success).toBe(false);
      expect(result.details).toContain("not supported");
    }
  });
});

// ─── validateCredential ────────────────────────────────────────────────────

describe("xAI Provider — validateCredential", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns invalid when API key is missing", async () => {
    const result = await xaiProvider.validateCredential({ provider: "xai" } as any);
    expect(result.valid).toBe(false);
    expect(result.error).toContain("Missing");
  });

  it("returns valid with model count from /models", async () => {
    vi.mocked(providerFetch).mockResolvedValueOnce({
      data: [{ id: "grok-2" }, { id: "grok-2-mini" }, { id: "grok-1" }],
    });
    const result = await xaiProvider.validateCredential(cred);
    expect(result.valid).toBe(true);
    expect(result.accountName).toContain("3 models");
  });

  it("accountId is always 'xai' on success", async () => {
    vi.mocked(providerFetch).mockResolvedValueOnce({ data: [] });
    const result = await xaiProvider.validateCredential(cred);
    expect(result.valid).toBe(true);
    expect(result.accountId).toBe("xai");
  });

  it("returns invalid when API call fails", async () => {
    vi.mocked(providerFetch).mockRejectedValueOnce(new Error("401 Unauthorized"));
    const result = await xaiProvider.validateCredential(cred);
    expect(result.valid).toBe(false);
    expect(result.error).toContain("401");
  });
});

// ─── getDefaultThresholds ─────────────────────────────────────────────────

describe("xAI Provider — getDefaultThresholds", () => {
  it("returns sensible defaults", () => {
    const t = xaiProvider.getDefaultThresholds();
    expect(t.xaiTokensPerDay).toBeGreaterThan(0);
    expect(t.xaiDailyCostUSD).toBeGreaterThan(0);
    expect(t.monthlySpendLimitUSD).toBeGreaterThan(0);
  });
});
