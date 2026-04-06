/**
 * Replicate Provider Tests
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock providerFetch and evaluateViolations
vi.mock("../../src/providers/shared.js", () => ({
  providerFetch: vi.fn(),
  evaluateViolations: vi.fn().mockReturnValue([]),
}));

import { replicateProvider } from "../../src/providers/replicate/checker.js";
import { providerFetch, evaluateViolations } from "../../src/providers/shared.js";

const cred = { provider: "replicate" as const, replicateApiToken: "r8_test_token" };

const makePred = (id: string, status: string, seconds = 60) => ({
  id,
  status,
  created_at: new Date().toISOString(),
  metrics: { predict_time: seconds },
});

describe("Replicate Provider — checkUsage", () => {
  beforeEach(() => vi.clearAllMocks());

  it("counts predictions and GPU hours from last 24h", async () => {
    vi.mocked(providerFetch).mockResolvedValueOnce({
      results: [
        makePred("p1", "succeeded", 3600),
        makePred("p2", "succeeded", 1800),
      ],
    });

    await replicateProvider.checkUsage(cred, {});

    expect(providerFetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.stringContaining("/predictions"),
      expect.any(Object),
      "Replicate"
    );
  });

  it("ignores predictions older than 24h", async () => {
    const old = makePred("old", "succeeded", 3600);
    old.created_at = new Date(Date.now() - 2 * 86_400_000).toISOString();

    vi.mocked(providerFetch).mockResolvedValueOnce({
      results: [old, makePred("recent", "succeeded", 600)],
    });

    await replicateProvider.checkUsage(cred, {});
    // evaluateViolations called with services — recent pred counted, old skipped
    const [services] = vi.mocked(evaluateViolations).mock.calls[0];
    expect(services[0].metrics[0].value).toBe(1); // 1 recent prediction
  });

  it("falls back to /account ping when predictions fail", async () => {
    vi.mocked(providerFetch)
      .mockRejectedValueOnce(new Error("network"))
      .mockResolvedValueOnce({ username: "testuser" });

    const result = await replicateProvider.checkUsage(cred, {});
    expect(result.services[0].metrics[0].value).toBe(0);
  });

  it("throws when both predictions and account ping fail", async () => {
    vi.mocked(providerFetch)
      .mockRejectedValueOnce(new Error("network"))
      .mockRejectedValueOnce(new Error("auth"));

    await expect(replicateProvider.checkUsage(cred, {})).rejects.toThrow("Failed to connect to Replicate API");
  });
});

describe("Replicate Provider — executeKillSwitch", () => {
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockFetch = vi.fn();
    vi.stubGlobal("fetch", mockFetch);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("cancels running and queued predictions on scale-down", async () => {
    vi.mocked(providerFetch).mockResolvedValueOnce({
      results: [
        makePred("p1", "processing"),
        makePred("p2", "starting"),
        makePred("p3", "succeeded"),  // already done — not cancelled
      ],
    });
    mockFetch.mockResolvedValue({ ok: true });

    const result = await replicateProvider.executeKillSwitch(cred, "replicate:predictions", "scale-down");

    expect(result.success).toBe(true);
    expect(result.details).toContain("Cancelled 2");
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining("/predictions/p1/cancel"),
      expect.objectContaining({ method: "POST" })
    );
  });

  it("handles disconnect and stop-pod as cancel-predictions aliases", async () => {
    vi.mocked(providerFetch).mockResolvedValue({ results: [makePred("p1", "processing")] });
    mockFetch.mockResolvedValue({ ok: true });

    const r1 = await replicateProvider.executeKillSwitch(cred, "replicate:predictions", "disconnect");
    const r2 = await replicateProvider.executeKillSwitch(cred, "replicate:predictions", "stop-pod");
    expect(r1.success).toBe(true);
    expect(r2.success).toBe(true);
  });

  it("returns success with message when no predictions are running", async () => {
    vi.mocked(providerFetch).mockResolvedValueOnce({
      results: [makePred("p1", "succeeded"), makePred("p2", "failed")],
    });

    const result = await replicateProvider.executeKillSwitch(cred, "replicate:predictions", "scale-down");

    expect(result.success).toBe(true);
    expect(result.details).toContain("No running predictions");
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("reports partial failures when some cancellations fail", async () => {
    vi.mocked(providerFetch).mockResolvedValueOnce({
      results: [makePred("p1", "processing"), makePred("p2", "starting")],
    });
    mockFetch
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({ ok: false, status: 422 });

    const result = await replicateProvider.executeKillSwitch(cred, "replicate:predictions", "scale-down");

    expect(result.success).toBe(true); // at least one succeeded
    expect(result.details).toContain("1 failed");
  });

  it("returns failure when prediction list fetch throws", async () => {
    vi.mocked(providerFetch).mockRejectedValueOnce(new Error("network error"));

    const result = await replicateProvider.executeKillSwitch(cred, "replicate:predictions", "scale-down");

    expect(result.success).toBe(false);
    expect(result.details).toContain("Failed to cancel predictions");
  });

  it("returns manual instructions for rotate-creds", async () => {
    const result = await replicateProvider.executeKillSwitch(cred, "replicate:predictions", "rotate-creds");

    expect(result.success).toBe(false);
    expect(result.details).toContain("manual action");
    expect(result.details).toContain("replicate.com");
  });

  it("returns unsupported for unknown actions", async () => {
    const result = await replicateProvider.executeKillSwitch(cred, "replicate:predictions", "delete" as any);

    expect(result.success).toBe(false);
    expect(result.details).toContain("not supported");
  });
});

describe("Replicate Provider — validateCredential", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns invalid when API token is missing", async () => {
    const result = await replicateProvider.validateCredential({ provider: "replicate" } as any);
    expect(result.valid).toBe(false);
  });

  it("returns valid with username from /account", async () => {
    vi.mocked(providerFetch).mockResolvedValueOnce({ username: "alice" });
    const result = await replicateProvider.validateCredential(cred);
    expect(result.valid).toBe(true);
    expect(result.accountId).toBe("alice");
  });

  it("returns invalid when API call fails", async () => {
    vi.mocked(providerFetch).mockRejectedValueOnce(new Error("401 Unauthorized"));
    const result = await replicateProvider.validateCredential(cred);
    expect(result.valid).toBe(false);
  });
});

describe("Replicate Provider — getDefaultThresholds", () => {
  it("returns sensible defaults", () => {
    const t = replicateProvider.getDefaultThresholds();
    expect(t.replicatePredictionsPerDay).toBeGreaterThan(0);
    expect(t.replicateGpuHoursPerDay).toBeGreaterThan(0);
    expect(t.replicateDailyCostUSD).toBeGreaterThan(0);
  });
});
