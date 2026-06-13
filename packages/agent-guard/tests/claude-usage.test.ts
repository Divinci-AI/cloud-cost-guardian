import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { usageToSnapshot, refreshUsage, type UsageResponse } from "../src/claude-usage.js";
import { saveLimitsState, emptyLimitsState } from "../src/limits.js";

const now = 1_700_000_000_000;

describe("usageToSnapshot — OAuth usage endpoint mapping", () => {
  it("maps five_hour/seven_day utilization as a PERCENT (÷100), not the header heuristic", () => {
    const u: UsageResponse = {
      five_hour: { utilization: 12, resets_at: "2026-06-13T16:20:00+00:00" },
      seven_day: { utilization: 17, resets_at: "2026-06-17T03:00:00+00:00" },
    };
    const s = usageToSnapshot(u, now);
    expect(s.fiveHour!.utilization).toBeCloseTo(0.12);
    expect(s.weekly!.utilization).toBeCloseTo(0.17);
    expect(s.fiveHour!.resetAt).toBe(Date.parse("2026-06-13T16:20:00+00:00"));
    expect(s.status).toBe("oauth-usage");
  });

  it("reads a 1% window as 0.01, NOT 1.0 (the bug the header parser would have)", () => {
    const s = usageToSnapshot({ seven_day_sonnet: { utilization: 1, resets_at: null } }, now);
    expect(s.extras).toEqual([{ label: "weekly · Sonnet", utilization: 0.01, resetAt: null }]);
  });

  it("surfaces per-model weekly windows as extras, skipping nulls", () => {
    const u: UsageResponse = {
      five_hour: { utilization: 5, resets_at: null },
      seven_day_sonnet: { utilization: 1, resets_at: null },
      seven_day_opus: null,
    };
    const s = usageToSnapshot(u, now);
    expect(s.extras!.map((e) => e.label)).toEqual(["weekly · Sonnet"]);
  });

  it("handles missing/empty windows without throwing", () => {
    const s = usageToSnapshot({}, now);
    expect(s.fiveHour).toBeNull();
    expect(s.weekly).toBeNull();
    expect(s.extras).toBeUndefined();
  });

  it("clamps an over-100 utilization to 1.0", () => {
    const s = usageToSnapshot({ five_hour: { utilization: 130, resets_at: null } }, now);
    expect(s.fiveHour!.utilization).toBe(1);
  });
});

describe("refreshUsage — throttle", () => {
  let prevHome: string | undefined;
  beforeEach(() => {
    prevHome = process.env.HOME;
    process.env.HOME = mkdtempSync(join(tmpdir(), "ag-usage-"));
  });
  afterEach(() => {
    if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
  });

  it("skips the fetch (returns null, no network) when a recent snapshot exists", async () => {
    saveLimitsState({
      ...emptyLimitsState(),
      subscriptionDetected: true,
      lastFetchAt: now - 1000, // 1s ago
      snapshot: { fiveHour: { utilization: 0.1, resetAt: now + 3600_000 }, weekly: null, status: "oauth-usage", observedAt: now - 1000 },
    });
    // throttle is 120s by default; 1s-old → must skip without touching the network/token.
    const result = await refreshUsage(now, { throttleMs: 120_000 });
    expect(result).toBeNull();
  });
});
