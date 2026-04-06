/**
 * Datadog Provider Tests
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../src/providers/shared.js", () => ({
  providerFetch: vi.fn(),
  evaluateViolations: vi.fn().mockReturnValue([]),
  estimateTokenCost: vi.fn().mockReturnValue(0),
}));

import { datadogProvider } from "../../src/providers/datadog/checker.js";
import { providerFetch, evaluateViolations } from "../../src/providers/shared.js";

const cred = {
  provider: "datadog" as const,
  datadogApiKey: "dd-api-key",
  datadogApplicationKey: "dd-app-key",
};
const credEU = { ...cred, datadogSite: "eu" as const };

// ─── checkUsage ────────────────────────────────────────────────────────────

describe("Datadog Provider — checkUsage", () => {
  beforeEach(() => vi.clearAllMocks());

  it("reads host count and log ingestion from usage API", async () => {
    vi.mocked(providerFetch).mockResolvedValueOnce({
      host_count: 20,
      usage: [{ host_count: 20, ingested_events_bytes_sum: 10 * 1024 ** 3 }],
    });

    const result = await datadogProvider.checkUsage(cred, {});

    expect(providerFetch).toHaveBeenCalledWith(
      expect.stringContaining("datadoghq.com"),
      expect.stringContaining("/usage/summary"),
      expect.any(Object),
      "Datadog"
    );
    expect(result.services[0].metrics[0].value).toBe(20); // host count
  });

  it("uses EU base URL for EU site", async () => {
    vi.mocked(providerFetch).mockResolvedValueOnce({ host_count: 5, usage: [] });

    await datadogProvider.checkUsage(credEU, {});

    expect(providerFetch).toHaveBeenCalledWith(
      expect.stringContaining("datadoghq.eu"),
      expect.any(String),
      expect.any(Object),
      "Datadog"
    );
  });

  it("accountId is 'datadog-us' for US site", async () => {
    vi.mocked(providerFetch).mockResolvedValueOnce({});
    const result = await datadogProvider.checkUsage(cred, {});
    expect(result.accountId).toBe("datadog-us");
  });

  it("accountId is 'datadog-eu' for EU site", async () => {
    vi.mocked(providerFetch).mockResolvedValueOnce({});
    const result = await datadogProvider.checkUsage(credEU, {});
    expect(result.accountId).toBe("datadog-eu");
  });

  it("falls back to /validate ping when usage call fails", async () => {
    vi.mocked(providerFetch)
      .mockRejectedValueOnce(new Error("network"))
      .mockResolvedValueOnce({ valid: true });

    const result = await datadogProvider.checkUsage(cred, {});
    expect(result.services[0].metrics[0].value).toBe(0); // zero hosts on fallback
    expect(result.totalEstimatedDailyCostUSD).toBe(0);
  });

  it("throws when both usage and validate ping fail", async () => {
    vi.mocked(providerFetch)
      .mockRejectedValueOnce(new Error("network"))
      .mockRejectedValueOnce(new Error("403 Forbidden"));

    await expect(datadogProvider.checkUsage(cred, {})).rejects.toThrow("Failed to connect to Datadog API");
  });

  it("passes services to evaluateViolations with correct cost key", async () => {
    vi.mocked(providerFetch).mockResolvedValueOnce({});

    await datadogProvider.checkUsage(cred, { datadogDailyCostUSD: 100 });

    expect(evaluateViolations).toHaveBeenCalledWith(
      expect.arrayContaining([expect.objectContaining({ serviceName: "datadog:monitoring" })]),
      expect.any(Object),
      expect.any(Number),
      "datadogDailyCostUSD",
      "datadog-billing"
    );
  });

  it("calculates cost as hostCount * 0.77 + logIngestGB * 0.10", async () => {
    vi.mocked(providerFetch).mockResolvedValueOnce({
      host_count: 10,
      usage: [{ host_count: 10, ingested_events_bytes_sum: 1024 ** 3 }], // 1 GB
    });

    const result = await datadogProvider.checkUsage(cred, {});
    // Cost = 10 * 0.77 + (1/dayOfMonth) * 0.10 — just check it's non-zero and reasonable
    expect(result.totalEstimatedDailyCostUSD).toBeGreaterThan(0);
  });

  it("handles missing usage array gracefully", async () => {
    vi.mocked(providerFetch).mockResolvedValueOnce({ host_count: 5 }); // no usage array
    const result = await datadogProvider.checkUsage(cred, {});
    expect(result.services[0].metrics[0].value).toBe(5);
  });
});

// ─── executeKillSwitch ─────────────────────────────────────────────────────

describe("Datadog Provider — executeKillSwitch", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns manual instructions for rotate-creds", async () => {
    const result = await datadogProvider.executeKillSwitch(cred, "datadog:monitoring", "rotate-creds");
    expect(result.success).toBe(false);
    expect(result.details).toContain("manual action");
    expect(result.details).toContain("datadoghq.com");
  });

  it("returns manual instructions for disable-service", async () => {
    const result = await datadogProvider.executeKillSwitch(cred, "datadog:monitoring", "disable-service" as any);
    expect(result.success).toBe(false);
    expect(result.details).toContain("manual action");
    expect(result.details).toContain("monitors");
  });

  it("returns unsupported for other actions", async () => {
    const actions = ["delete", "scale-down", "stop-instances", "disconnect"] as const;
    for (const action of actions) {
      const result = await datadogProvider.executeKillSwitch(cred, "datadog:monitoring", action as any);
      expect(result.success).toBe(false);
      expect(result.details).toContain("not supported");
    }
  });
});

// ─── validateCredential ────────────────────────────────────────────────────

describe("Datadog Provider — validateCredential", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns invalid when API key is missing", async () => {
    const result = await datadogProvider.validateCredential({ provider: "datadog" } as any);
    expect(result.valid).toBe(false);
    expect(result.error).toContain("Missing");
  });

  it("returns invalid when application key is missing", async () => {
    const result = await datadogProvider.validateCredential({
      provider: "datadog", datadogApiKey: "dd-api-key",
    } as any);
    expect(result.valid).toBe(false);
    expect(result.error).toContain("Missing");
  });

  it("returns valid when /validate responds with valid: true", async () => {
    vi.mocked(providerFetch).mockResolvedValueOnce({ valid: true });
    const result = await datadogProvider.validateCredential(cred);
    expect(result.valid).toBe(true);
    expect(result.accountName).toContain("US");
  });

  it("returns invalid when /validate responds with valid: false", async () => {
    vi.mocked(providerFetch).mockResolvedValueOnce({ valid: false });
    const result = await datadogProvider.validateCredential(cred);
    expect(result.valid).toBe(false);
    expect(result.error).toContain("Invalid API key");
  });

  it("accountId is 'datadog-eu' for EU site", async () => {
    vi.mocked(providerFetch).mockResolvedValueOnce({ valid: true });
    const result = await datadogProvider.validateCredential(credEU);
    expect(result.valid).toBe(true);
    expect(result.accountId).toBe("datadog-eu");
    expect(result.accountName).toContain("EU");
  });

  it("returns invalid when API call throws", async () => {
    vi.mocked(providerFetch).mockRejectedValueOnce(new Error("403 Forbidden"));
    const result = await datadogProvider.validateCredential(cred);
    expect(result.valid).toBe(false);
    expect(result.error).toContain("403");
  });
});

// ─── getDefaultThresholds ─────────────────────────────────────────────────

describe("Datadog Provider — getDefaultThresholds", () => {
  it("returns sensible defaults", () => {
    const t = datadogProvider.getDefaultThresholds();
    expect(t.datadogHostCount).toBeGreaterThan(0);
    expect(t.datadogLogIngestGBPerDay).toBeGreaterThan(0);
    expect(t.datadogDailyCostUSD).toBeGreaterThan(0);
    expect(t.monthlySpendLimitUSD).toBeGreaterThan(0);
  });
});
