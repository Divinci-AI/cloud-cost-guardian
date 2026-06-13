import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  usageToSnapshot,
  refreshUsage,
  triggerBackgroundRefresh,
  saveUsageMeta,
  loadUsageMeta,
  type UsageResponse,
} from "../src/claude-usage.js";
import { saveLimitsState, emptyLimitsState, loadLimitsState } from "../src/limits.js";

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

describe("refreshUsage — throttle (uses usage-meta, never touches the snapshot — G3)", () => {
  let prevHome: string | undefined;
  beforeEach(() => {
    prevHome = process.env.HOME;
    process.env.HOME = mkdtempSync(join(tmpdir(), "ag-usage-"));
  });
  afterEach(() => {
    if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
  });

  it("skips the fetch when the meta stamp is recent and a snapshot exists", async () => {
    saveUsageMeta({ lastFetchAt: now - 1000 }); // 1s ago — throttle stamp lives in usage-meta
    saveLimitsState({
      ...emptyLimitsState(),
      subscriptionDetected: true,
      snapshot: { fiveHour: { utilization: 0.1, resetAt: now + 3600_000 }, weekly: null, status: "oauth-usage", observedAt: now - 1000 },
    });
    const result = await refreshUsage(now, { throttleMs: 120_000 });
    expect(result).toBeNull();
    // the snapshot must be untouched (the throttle stamp is a separate file)
    expect(loadLimitsState().snapshot!.fiveHour!.utilization).toBeCloseTo(0.1);
  });
});

describe("triggerBackgroundRefresh — G1 authorization gate", () => {
  let prevHome: string | undefined;
  beforeEach(() => {
    prevHome = process.env.HOME;
    process.env.HOME = mkdtempSync(join(tmpdir(), "ag-bg-"));
  });
  afterEach(() => {
    if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
  });

  it("does NOT claim or spawn until a foreground command authorized it", () => {
    // no authorized flag → must return early (no surprise Keychain read), no stamp claimed
    triggerBackgroundRefresh("/tmp/ks-nonexistent-refresh.js", now);
    expect(loadUsageMeta().lastFetchAt).toBeUndefined();
  });

  it("claims the stamp once authorized + stale", () => {
    saveUsageMeta({ authorized: true });
    triggerBackgroundRefresh("/tmp/ks-nonexistent-refresh.js", now);
    expect(loadUsageMeta().lastFetchAt).toBe(now);
  });
});
