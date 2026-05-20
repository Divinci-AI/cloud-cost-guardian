/**
 * Anthropic Provider Tests
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../src/providers/shared.js", () => ({
  providerFetch: vi.fn(),
  evaluateViolations: vi.fn().mockReturnValue([]),
  estimateTokenCost: vi.fn().mockReturnValue(0),
}));

import { anthropicProvider } from "../../src/providers/anthropic/checker.js";
import { providerFetch, evaluateViolations } from "../../src/providers/shared.js";

const cred = { provider: "anthropic" as const, anthropicApiKey: "sk-ant-test-key" };
const credWithWorkspace = { ...cred, anthropicWorkspaceId: "ws-abc123" };

// ─── checkUsage ────────────────────────────────────────────────────────────

describe("Anthropic Provider — checkUsage", () => {
  beforeEach(() => vi.clearAllMocks());

  it("sums tokens from usage API", async () => {
    vi.mocked(providerFetch).mockResolvedValueOnce({
      data: [
        { model: "claude-3.5-sonnet", input_tokens: 300_000, output_tokens: 50_000 },
        { model: "claude-3-haiku",    input_tokens: 200_000, output_tokens: 30_000 },
      ],
    });

    const result = await anthropicProvider.checkUsage(cred, {});

    expect(providerFetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.stringContaining("/usage"),
      expect.any(Object),
      "Anthropic"
    );
    expect(result.services[0].metrics[0].value).toBe(580_000); // total tokens
  });

  it("uses workspaceId as accountId when present", async () => {
    vi.mocked(providerFetch).mockResolvedValueOnce({ data: [] });
    const result = await anthropicProvider.checkUsage(credWithWorkspace, {});
    expect(result.accountId).toBe("ws-abc123");
  });

  it("defaults accountId to 'anthropic' when no workspaceId", async () => {
    vi.mocked(providerFetch).mockResolvedValueOnce({ data: [] });
    const result = await anthropicProvider.checkUsage(cred, {});
    expect(result.accountId).toBe("anthropic");
  });

  it("falls back to /models ping when usage call fails", async () => {
    vi.mocked(providerFetch)
      .mockRejectedValueOnce(new Error("network"))
      .mockResolvedValueOnce({ data: [{ id: "claude-3.5-sonnet" }] });

    const result = await anthropicProvider.checkUsage(cred, {});
    expect(result.services[0].metrics[0].value).toBe(0);
    expect(result.totalEstimatedDailyCostUSD).toBe(0);
  });

  it("throws when both usage and models ping fail", async () => {
    vi.mocked(providerFetch)
      .mockRejectedValueOnce(new Error("network"))
      .mockRejectedValueOnce(new Error("401 Unauthorized"));

    await expect(anthropicProvider.checkUsage(cred, {})).rejects.toThrow("Failed to connect to Anthropic API");
  });

  it("passes services to evaluateViolations with correct cost key", async () => {
    vi.mocked(providerFetch).mockResolvedValueOnce({ data: [] });

    await anthropicProvider.checkUsage(cred, { anthropicDailyCostUSD: 50 });

    expect(evaluateViolations).toHaveBeenCalledWith(
      expect.arrayContaining([expect.objectContaining({ serviceName: "anthropic:api" })]),
      expect.any(Object),
      expect.any(Number),
      "anthropicDailyCostUSD",
      "anthropic-billing",
      expect.any(Object)
    );
  });

  it("handles missing data array gracefully", async () => {
    vi.mocked(providerFetch).mockResolvedValueOnce({}); // no .data field
    const result = await anthropicProvider.checkUsage(cred, {});
    expect(result.services[0].metrics[0].value).toBe(0);
  });
});

// ─── executeKillSwitch ─────────────────────────────────────────────────────

describe("Anthropic Provider — executeKillSwitch", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns manual instructions for rotate-creds", async () => {
    const result = await anthropicProvider.executeKillSwitch(cred, "anthropic:api", "rotate-creds");
    expect(result.success).toBe(false);
    expect(result.details).toContain("manual action");
    expect(result.details).toContain("console.anthropic.com");
  });

  it("returns unsupported for non-rotate actions", async () => {
    const actions = ["delete", "scale-down", "disconnect", "stop-instances"] as const;
    for (const action of actions) {
      const result = await anthropicProvider.executeKillSwitch(cred, "anthropic:api", action as any);
      expect(result.success).toBe(false);
      expect(result.details).toContain("not supported");
    }
  });
});

// ─── validateCredential ────────────────────────────────────────────────────

describe("Anthropic Provider — validateCredential", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns invalid when API key is missing", async () => {
    const result = await anthropicProvider.validateCredential({ provider: "anthropic" } as any);
    expect(result.valid).toBe(false);
    expect(result.error).toContain("Missing");
  });

  it("returns valid when count_tokens succeeds", async () => {
    vi.mocked(providerFetch).mockResolvedValueOnce({ input_tokens: 5 });
    const result = await anthropicProvider.validateCredential(cred);
    expect(result.valid).toBe(true);
    expect(result.accountName).toBe("Anthropic Claude API");
  });

  it("returns valid when count_tokens returns 404 (endpoint unavailable but key works)", async () => {
    vi.mocked(providerFetch).mockRejectedValueOnce(new Error("404 Not Found"));
    const result = await anthropicProvider.validateCredential(cred);
    expect(result.valid).toBe(true);
  });

  it("returns invalid on 401 auth failure", async () => {
    vi.mocked(providerFetch).mockRejectedValueOnce(new Error("401 Unauthorized"));
    const result = await anthropicProvider.validateCredential(cred);
    expect(result.valid).toBe(false);
    expect(result.error).toContain("Invalid API key");
  });

  it("returns invalid on 403 forbidden", async () => {
    vi.mocked(providerFetch).mockRejectedValueOnce(new Error("403 Forbidden"));
    const result = await anthropicProvider.validateCredential(cred);
    expect(result.valid).toBe(false);
  });

  it("uses workspaceId as accountId when present", async () => {
    vi.mocked(providerFetch).mockResolvedValueOnce({ input_tokens: 5 });
    const result = await anthropicProvider.validateCredential(credWithWorkspace);
    expect(result.valid).toBe(true);
    expect(result.accountId).toBe("ws-abc123");
  });
});

// ─── getDefaultThresholds ─────────────────────────────────────────────────

describe("Anthropic Provider — getDefaultThresholds", () => {
  it("returns sensible defaults", () => {
    const t = anthropicProvider.getDefaultThresholds();
    expect(t.anthropicTokensPerDay).toBeGreaterThan(0);
    expect(t.anthropicDailyCostUSD).toBeGreaterThan(0);
    expect(t.monthlySpendLimitUSD).toBeGreaterThan(0);
  });
});
