/**
 * Vercel Provider Tests
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../../src/providers/shared.js", () => ({
  providerFetch: vi.fn(),
  evaluateViolations: vi.fn().mockReturnValue([]),
}));

import { vercelProvider } from "../../src/providers/vercel/checker.js";
import { providerFetch, evaluateViolations } from "../../src/providers/shared.js";

const cred = { provider: "vercel" as const, vercelApiToken: "tok_test" };
const credWithTeam = { ...cred, vercelTeamId: "team_abc" };

// ─── checkUsage ────────────────────────────────────────────────────────────

describe("Vercel Provider — checkUsage", () => {
  beforeEach(() => vi.clearAllMocks());

  it("counts invocations and bandwidth from usage API", async () => {
    vi.mocked(providerFetch).mockResolvedValueOnce({
      functionInvocations: 50_000,
      bandwidth: 10 * 1024 ** 3, // 10 GB
    });

    const result = await vercelProvider.checkUsage(cred, {});

    expect(providerFetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.stringContaining("/v1/usage"),
      expect.any(Object),
      "Vercel"
    );
    expect(result.services[0].metrics[0].value).toBe(50_000);
    expect(result.services[0].metrics[1].value).toBe(10);
  });

  it("reads metrics from nested metrics object", async () => {
    vi.mocked(providerFetch).mockResolvedValueOnce({
      metrics: { functionInvocations: 1000, bandwidth: 1024 ** 3 },
    });

    const result = await vercelProvider.checkUsage(cred, {});
    expect(result.services[0].metrics[0].value).toBe(1000);
    expect(result.services[0].metrics[1].value).toBe(1);
  });

  it("appends teamId to usage path when present", async () => {
    vi.mocked(providerFetch).mockResolvedValueOnce({ functionInvocations: 0, bandwidth: 0 });

    await vercelProvider.checkUsage(credWithTeam, {});

    expect(providerFetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.stringContaining("teamId=team_abc"),
      expect.any(Object),
      "Vercel"
    );
  });

  it("falls back to /user ping when usage call fails", async () => {
    vi.mocked(providerFetch)
      .mockRejectedValueOnce(new Error("network"))
      .mockResolvedValueOnce({ user: { username: "alice" } });

    const result = await vercelProvider.checkUsage(cred, {});
    expect(result.services[0].metrics[0].value).toBe(0);
    expect(result.totalEstimatedDailyCostUSD).toBe(0);
  });

  it("throws when both usage and user ping fail", async () => {
    vi.mocked(providerFetch)
      .mockRejectedValueOnce(new Error("network"))
      .mockRejectedValueOnce(new Error("auth"));

    await expect(vercelProvider.checkUsage(cred, {})).rejects.toThrow("Failed to connect to Vercel API");
  });

  it("passes services to evaluateViolations", async () => {
    vi.mocked(providerFetch).mockResolvedValueOnce({ functionInvocations: 200_000, bandwidth: 0 });

    await vercelProvider.checkUsage(cred, { vercelFunctionInvocationsPerDay: 100_000 });

    expect(evaluateViolations).toHaveBeenCalledWith(
      expect.arrayContaining([expect.objectContaining({ serviceName: "vercel:platform" })]),
      expect.any(Object),
      expect.any(Number),
      "vercelDailyCostUSD",
      "vercel-billing"
    );
  });
});

// ─── executeKillSwitch ─────────────────────────────────────────────────────

describe("Vercel Provider — executeKillSwitch", () => {
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockFetch = vi.fn();
    vi.stubGlobal("fetch", mockFetch);
  });

  afterEach(() => vi.unstubAllGlobals());

  it("cancels BUILDING and QUEUED deployments on scale-down", async () => {
    vi.mocked(providerFetch).mockResolvedValueOnce({
      deployments: [
        { uid: "dpl_1", state: "BUILDING" },
        { uid: "dpl_2", state: "QUEUED" },
        { uid: "dpl_3", state: "READY" },    // already done — not cancelled
      ],
    });
    mockFetch.mockResolvedValue({ ok: true });

    const result = await vercelProvider.executeKillSwitch(cred, "vercel:platform", "scale-down");

    expect(result.success).toBe(true);
    expect(result.details).toContain("Cancelled 2");
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining("dpl_1"),
      expect.objectContaining({ method: "PATCH" })
    );
  });

  it("handles disconnect as alias for scale-down", async () => {
    vi.mocked(providerFetch).mockResolvedValueOnce({ deployments: [{ uid: "d1", state: "BUILDING" }] });
    mockFetch.mockResolvedValue({ ok: true });

    const result = await vercelProvider.executeKillSwitch(cred, "vercel:platform", "disconnect");
    expect(result.success).toBe(true);
  });

  it("returns success when no builds are running", async () => {
    vi.mocked(providerFetch).mockResolvedValueOnce({
      deployments: [{ uid: "dpl_1", state: "READY" }, { uid: "dpl_2", state: "ERROR" }],
    });

    const result = await vercelProvider.executeKillSwitch(cred, "vercel:platform", "scale-down");

    expect(result.success).toBe(true);
    expect(result.details).toContain("No active builds");
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("appends teamId to cancel URL when present", async () => {
    vi.mocked(providerFetch).mockResolvedValueOnce({ deployments: [{ uid: "dpl_1", state: "BUILDING" }] });
    mockFetch.mockResolvedValue({ ok: true });

    await vercelProvider.executeKillSwitch(credWithTeam, "vercel:platform", "scale-down");

    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining("teamId=team_abc"),
      expect.any(Object)
    );
  });

  it("reports partial failures when some cancellations fail", async () => {
    vi.mocked(providerFetch).mockResolvedValueOnce({
      deployments: [{ uid: "dpl_1", state: "BUILDING" }, { uid: "dpl_2", state: "QUEUED" }],
    });
    mockFetch
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({ ok: false, status: 409 });

    const result = await vercelProvider.executeKillSwitch(cred, "vercel:platform", "scale-down");

    expect(result.success).toBe(true); // at least one succeeded
    expect(result.details).toContain("1 failed");
  });

  it("returns failure when deployment list fetch throws", async () => {
    vi.mocked(providerFetch).mockRejectedValueOnce(new Error("network error"));

    const result = await vercelProvider.executeKillSwitch(cred, "vercel:platform", "scale-down");

    expect(result.success).toBe(false);
    expect(result.details).toContain("Failed to cancel builds");
  });

  it("returns manual instructions for rotate-creds", async () => {
    const result = await vercelProvider.executeKillSwitch(cred, "vercel:platform", "rotate-creds");

    expect(result.success).toBe(false);
    expect(result.details).toContain("manual action");
    expect(result.details).toContain("vercel.com");
  });

  it("returns unsupported for unknown actions", async () => {
    const result = await vercelProvider.executeKillSwitch(cred, "vercel:platform", "delete" as any);

    expect(result.success).toBe(false);
    expect(result.details).toContain("not supported");
  });
});

// ─── validateCredential ────────────────────────────────────────────────────

describe("Vercel Provider — validateCredential", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns invalid when API token is missing", async () => {
    const result = await vercelProvider.validateCredential({ provider: "vercel" } as any);
    expect(result.valid).toBe(false);
  });

  it("returns valid with username from /user", async () => {
    vi.mocked(providerFetch).mockResolvedValueOnce({ user: { username: "alice", name: "Alice" } });
    const result = await vercelProvider.validateCredential(cred);
    expect(result.valid).toBe(true);
    expect(result.accountName).toContain("alice");
  });

  it("uses team ID as accountId when present", async () => {
    vi.mocked(providerFetch).mockResolvedValueOnce({ user: { username: "alice" } });
    const result = await vercelProvider.validateCredential(credWithTeam);
    expect(result.valid).toBe(true);
    expect(result.accountId).toBe("team_abc");
  });

  it("returns invalid when API call fails", async () => {
    vi.mocked(providerFetch).mockRejectedValueOnce(new Error("401 Unauthorized"));
    const result = await vercelProvider.validateCredential(cred);
    expect(result.valid).toBe(false);
    expect(result.error).toContain("401");
  });
});

// ─── getDefaultThresholds ─────────────────────────────────────────────────

describe("Vercel Provider — getDefaultThresholds", () => {
  it("returns sensible defaults", () => {
    const t = vercelProvider.getDefaultThresholds();
    expect(t.vercelFunctionInvocationsPerDay).toBeGreaterThan(0);
    expect(t.vercelBandwidthGBPerDay).toBeGreaterThan(0);
    expect(t.vercelDailyCostUSD).toBeGreaterThan(0);
    expect(t.monthlySpendLimitUSD).toBeGreaterThan(0);
  });
});
