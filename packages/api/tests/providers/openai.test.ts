/**
 * OpenAI Provider Tests
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../src/providers/shared.js", () => ({
  providerFetch: vi.fn(),
  evaluateViolations: vi.fn().mockReturnValue([]),
  estimateTokenCost: vi.fn().mockReturnValue(0),
}));

import { openaiProvider } from "../../src/providers/openai/checker.js";
import { providerFetch, evaluateViolations } from "../../src/providers/shared.js";

const cred = { provider: "openai" as const, openaiApiKey: "sk-test-key" };
const credWithOrg = { ...cred, openaiOrgId: "org-abc123" };

// ─── checkUsage ────────────────────────────────────────────────────────────

describe("OpenAI Provider — checkUsage", () => {
  beforeEach(() => vi.clearAllMocks());

  it("sums tokens and requests from usage API", async () => {
    vi.mocked(providerFetch).mockResolvedValueOnce({
      data: [
        { snapshot_id: "gpt-4o-mini", n_context_tokens_total: 500_000, n_generated_tokens_total: 100_000, n_requests: 200 },
        { snapshot_id: "gpt-4o",      n_context_tokens_total: 200_000, n_generated_tokens_total:  50_000, n_requests:  50 },
      ],
    });

    const result = await openaiProvider.checkUsage(cred, {});

    expect(providerFetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.stringContaining("/organization/usage"),
      expect.any(Object),
      "OpenAI"
    );
    expect(result.services[0].metrics[0].value).toBe(850_000); // total tokens
    expect(result.services[0].metrics[1].value).toBe(250);     // total requests
  });

  it("uses orgId as accountId when present", async () => {
    vi.mocked(providerFetch).mockResolvedValueOnce({ data: [] });
    const result = await openaiProvider.checkUsage(credWithOrg, {});
    expect(result.accountId).toBe("org-abc123");
  });

  it("defaults accountId to 'openai' when no orgId", async () => {
    vi.mocked(providerFetch).mockResolvedValueOnce({ data: [] });
    const result = await openaiProvider.checkUsage(cred, {});
    expect(result.accountId).toBe("openai");
  });

  it("falls back to /models ping when usage call fails", async () => {
    vi.mocked(providerFetch)
      .mockRejectedValueOnce(new Error("network"))
      .mockResolvedValueOnce({ data: [{ id: "gpt-4o" }] });

    const result = await openaiProvider.checkUsage(cred, {});
    expect(result.services[0].metrics[0].value).toBe(0); // zero tokens on fallback
    expect(result.totalEstimatedDailyCostUSD).toBe(0);
  });

  it("throws when both usage and models ping fail", async () => {
    vi.mocked(providerFetch)
      .mockRejectedValueOnce(new Error("network"))
      .mockRejectedValueOnce(new Error("401 Unauthorized"));

    await expect(openaiProvider.checkUsage(cred, {})).rejects.toThrow("Failed to connect to OpenAI API");
  });

  it("passes services to evaluateViolations with correct cost key", async () => {
    vi.mocked(providerFetch).mockResolvedValueOnce({ data: [] });

    await openaiProvider.checkUsage(cred, { openaiDailyCostUSD: 50 });

    expect(evaluateViolations).toHaveBeenCalledWith(
      expect.arrayContaining([expect.objectContaining({ serviceName: "openai:api" })]),
      expect.any(Object),
      expect.any(Number),
      "openaiDailyCostUSD",
      "openai-billing"
    );
  });

  it("handles missing data array gracefully", async () => {
    vi.mocked(providerFetch).mockResolvedValueOnce({}); // no .data field
    const result = await openaiProvider.checkUsage(cred, {});
    expect(result.services[0].metrics[0].value).toBe(0);
  });
});

// ─── executeKillSwitch ─────────────────────────────────────────────────────

describe("OpenAI Provider — executeKillSwitch", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns manual instructions for rotate-creds", async () => {
    const result = await openaiProvider.executeKillSwitch(cred, "openai:api", "rotate-creds");
    expect(result.success).toBe(false);
    expect(result.details).toContain("manual action");
    expect(result.details).toContain("platform.openai.com");
  });

  it("returns unsupported for non-rotate actions", async () => {
    const actions = ["delete", "scale-down", "disconnect", "stop-instances"] as const;
    for (const action of actions) {
      const result = await openaiProvider.executeKillSwitch(cred, "openai:api", action as any);
      expect(result.success).toBe(false);
      expect(result.details).toContain("not supported");
    }
  });
});

// ─── validateCredential ────────────────────────────────────────────────────

describe("OpenAI Provider — validateCredential", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns invalid when API key is missing", async () => {
    const result = await openaiProvider.validateCredential({ provider: "openai" } as any);
    expect(result.valid).toBe(false);
    expect(result.error).toContain("Missing");
  });

  it("returns valid with model count from /models", async () => {
    vi.mocked(providerFetch).mockResolvedValueOnce({ data: [{ id: "gpt-4o" }, { id: "gpt-4o-mini" }] });
    const result = await openaiProvider.validateCredential(cred);
    expect(result.valid).toBe(true);
    expect(result.accountName).toContain("2 models");
  });

  it("uses orgId as accountId when present", async () => {
    vi.mocked(providerFetch).mockResolvedValueOnce({ data: [] });
    const result = await openaiProvider.validateCredential(credWithOrg);
    expect(result.valid).toBe(true);
    expect(result.accountId).toBe("org-abc123");
  });

  it("returns invalid when API call fails", async () => {
    vi.mocked(providerFetch).mockRejectedValueOnce(new Error("401 Unauthorized"));
    const result = await openaiProvider.validateCredential(cred);
    expect(result.valid).toBe(false);
    expect(result.error).toContain("401");
  });
});

// ─── getDefaultThresholds ─────────────────────────────────────────────────

describe("OpenAI Provider — getDefaultThresholds", () => {
  it("returns sensible defaults", () => {
    const t = openaiProvider.getDefaultThresholds();
    expect(t.openaiTokensPerDay).toBeGreaterThan(0);
    expect(t.openaiRequestsPerDay).toBeGreaterThan(0);
    expect(t.openaiDailyCostUSD).toBeGreaterThan(0);
    expect(t.monthlySpendLimitUSD).toBeGreaterThan(0);
  });
});
