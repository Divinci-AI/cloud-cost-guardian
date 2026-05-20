/**
 * Snowflake Provider Tests
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../src/providers/shared.js", () => ({
  providerFetch: vi.fn(),
  evaluateViolations: vi.fn().mockReturnValue([]),
  estimateTokenCost: vi.fn().mockReturnValue(0),
}));

import { snowflakeProvider } from "../../src/providers/snowflake/checker.js";
import { providerFetch, evaluateViolations } from "../../src/providers/shared.js";

const cred = {
  provider: "snowflake" as const,
  snowflakeAccountName: "myaccount",
  snowflakeUsername: "user",
  snowflakePassword: "pass",
  snowflakeWarehouseName: "COMPUTE_WH",
};

// ─── checkUsage ────────────────────────────────────────────────────────────

describe("Snowflake Provider — checkUsage", () => {
  beforeEach(() => vi.clearAllMocks());

  it("reads credits and queries from SQL results", async () => {
    vi.mocked(providerFetch)
      .mockResolvedValueOnce({ data: [["12.5"]] })   // credits query
      .mockResolvedValueOnce({ data: [["300"]] });    // queries query

    const result = await snowflakeProvider.checkUsage(cred, {});

    expect(result.services[0].metrics[0].value).toBe(12.5);   // credits
    expect(result.services[0].metrics[1].value).toBe(300);    // queries
  });

  it("calculates cost as credits * 3", async () => {
    vi.mocked(providerFetch)
      .mockResolvedValueOnce({ data: [["10"]] })
      .mockResolvedValueOnce({ data: [["0"]] });

    const result = await snowflakeProvider.checkUsage(cred, {});
    expect(result.totalEstimatedDailyCostUSD).toBe(30);
  });

  it("uses accountName as accountId", async () => {
    vi.mocked(providerFetch)
      .mockResolvedValueOnce({ data: [["0"]] })
      .mockResolvedValueOnce({ data: [["0"]] });

    const result = await snowflakeProvider.checkUsage(cred, {});
    expect(result.accountId).toBe("myaccount");
  });

  it("defaults accountId to 'snowflake' when no accountName", async () => {
    const credNoAccount = { ...cred, snowflakeAccountName: undefined as any };
    vi.mocked(providerFetch)
      .mockResolvedValueOnce({ data: [["0"]] })
      .mockResolvedValueOnce({ data: [["0"]] });

    const result = await snowflakeProvider.checkUsage(credNoAccount, {});
    expect(result.accountId).toBe("snowflake");
  });

  it("falls back to SELECT CURRENT_ACCOUNT() ping when SQL queries fail", async () => {
    vi.mocked(providerFetch)
      .mockRejectedValueOnce(new Error("network"))
      .mockResolvedValueOnce({ data: [["MYACCOUNT"]] });

    const result = await snowflakeProvider.checkUsage(cred, {});
    expect(result.services[0].metrics[0].value).toBe(0); // zero credits on fallback
    expect(result.totalEstimatedDailyCostUSD).toBe(0);
  });

  it("throws when both SQL and ping fail", async () => {
    vi.mocked(providerFetch)
      .mockRejectedValueOnce(new Error("network"))
      .mockRejectedValueOnce(new Error("401 Unauthorized"));

    await expect(snowflakeProvider.checkUsage(cred, {})).rejects.toThrow("Failed to connect to Snowflake");
  });

  it("throws on invalid warehouse name", async () => {
    const credBadWH = { ...cred, snowflakeWarehouseName: "bad warehouse; DROP TABLE--" };
    await expect(snowflakeProvider.checkUsage(credBadWH, {})).rejects.toThrow("Invalid warehouse name");
  });

  it("passes services to evaluateViolations with correct cost key", async () => {
    vi.mocked(providerFetch)
      .mockResolvedValueOnce({ data: [["0"]] })
      .mockResolvedValueOnce({ data: [["0"]] });

    await snowflakeProvider.checkUsage(cred, { snowflakeDailyCostUSD: 100 });

    expect(evaluateViolations).toHaveBeenCalledWith(
      expect.arrayContaining([expect.objectContaining({ serviceName: "snowflake:compute" })]),
      expect.any(Object),
      expect.any(Number),
      "snowflakeDailyCostUSD",
      "snowflake-billing",
      expect.any(Object)
    );
  });

  it("handles null/undefined SQL result gracefully", async () => {
    vi.mocked(providerFetch)
      .mockResolvedValueOnce({ data: [[null]] })
      .mockResolvedValueOnce({ data: [[undefined]] });

    const result = await snowflakeProvider.checkUsage(cred, {});
    expect(result.services[0].metrics[0].value).toBe(0);
    expect(result.services[0].metrics[1].value).toBe(0);
  });

  it("uses default warehouse COMPUTE_WH when not specified", async () => {
    const credNoWH = { ...cred, snowflakeWarehouseName: undefined as any };
    vi.mocked(providerFetch)
      .mockResolvedValueOnce({ data: [["5"]] })
      .mockResolvedValueOnce({ data: [["100"]] });

    const result = await snowflakeProvider.checkUsage(credNoWH, {});
    // Should work without error, using default warehouse
    expect(result.provider).toBe("snowflake");
  });
});

// ─── executeKillSwitch ─────────────────────────────────────────────────────

describe("Snowflake Provider — executeKillSwitch", () => {
  beforeEach(() => vi.clearAllMocks());

  it("scale-down resizes warehouse to X-SMALL", async () => {
    vi.mocked(providerFetch).mockResolvedValueOnce({});
    const result = await snowflakeProvider.executeKillSwitch(cred, "snowflake:compute", "scale-down");
    expect(result.success).toBe(true);
    expect(result.details).toContain("X-SMALL");
    expect(result.details).toContain("COMPUTE_WH");
  });

  it("stop-instances suspends the warehouse", async () => {
    vi.mocked(providerFetch).mockResolvedValueOnce({});
    const result = await snowflakeProvider.executeKillSwitch(cred, "snowflake:compute", "stop-instances");
    expect(result.success).toBe(true);
    expect(result.details).toContain("suspended");
    expect(result.details).toContain("COMPUTE_WH");
  });

  it("scale-down returns failure when SQL throws", async () => {
    vi.mocked(providerFetch).mockRejectedValueOnce(new Error("permission denied"));
    const result = await snowflakeProvider.executeKillSwitch(cred, "snowflake:compute", "scale-down");
    expect(result.success).toBe(false);
    expect(result.details).toContain("Failed to scale down");
  });

  it("stop-instances returns failure when SQL throws", async () => {
    vi.mocked(providerFetch).mockRejectedValueOnce(new Error("permission denied"));
    const result = await snowflakeProvider.executeKillSwitch(cred, "snowflake:compute", "stop-instances");
    expect(result.success).toBe(false);
    expect(result.details).toContain("Failed to suspend");
  });

  it("returns unsupported for other actions", async () => {
    const actions = ["delete", "rotate-creds", "disconnect"] as const;
    for (const action of actions) {
      const result = await snowflakeProvider.executeKillSwitch(cred, "snowflake:compute", action as any);
      expect(result.success).toBe(false);
      expect(result.details).toContain("not supported");
    }
  });

  it("rejects invalid warehouse name in executeKillSwitch", async () => {
    const credBadWH = { ...cred, snowflakeWarehouseName: "bad; DROP--" };
    const result = await snowflakeProvider.executeKillSwitch(credBadWH, "snowflake:compute", "scale-down");
    expect(result.success).toBe(false);
    expect(result.details).toContain("Invalid warehouse name");
  });
});

// ─── validateCredential ────────────────────────────────────────────────────

describe("Snowflake Provider — validateCredential", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns invalid when accountName is missing", async () => {
    const result = await snowflakeProvider.validateCredential({ provider: "snowflake" } as any);
    expect(result.valid).toBe(false);
    expect(result.error).toContain("Missing");
  });

  it("returns invalid when username is missing", async () => {
    const result = await snowflakeProvider.validateCredential({
      provider: "snowflake", snowflakeAccountName: "acct",
    } as any);
    expect(result.valid).toBe(false);
    expect(result.error).toContain("Missing");
  });

  it("returns valid with account name from CURRENT_ACCOUNT()", async () => {
    vi.mocked(providerFetch).mockResolvedValueOnce({ data: [["PROD_ACCOUNT"]] });
    const result = await snowflakeProvider.validateCredential(cred);
    expect(result.valid).toBe(true);
    expect(result.accountId).toBe("PROD_ACCOUNT");
    expect(result.accountName).toContain("PROD_ACCOUNT");
  });

  it("falls back to credential accountName when SQL result empty", async () => {
    vi.mocked(providerFetch).mockResolvedValueOnce({ data: [[null]] });
    const result = await snowflakeProvider.validateCredential(cred);
    expect(result.valid).toBe(true);
    expect(result.accountId).toBe("myaccount");
  });

  it("returns invalid when SQL call fails", async () => {
    vi.mocked(providerFetch).mockRejectedValueOnce(new Error("401 Unauthorized"));
    const result = await snowflakeProvider.validateCredential(cred);
    expect(result.valid).toBe(false);
    expect(result.error).toContain("401");
  });
});

// ─── getDefaultThresholds ─────────────────────────────────────────────────

describe("Snowflake Provider — getDefaultThresholds", () => {
  it("returns sensible defaults", () => {
    const t = snowflakeProvider.getDefaultThresholds();
    expect(t.snowflakeCreditsPerDay).toBeGreaterThan(0);
    expect(t.snowflakeDailyCostUSD).toBeGreaterThan(0);
    expect(t.monthlySpendLimitUSD).toBeGreaterThan(0);
  });
});
