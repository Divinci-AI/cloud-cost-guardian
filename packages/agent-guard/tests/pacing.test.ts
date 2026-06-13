import { describe, it, expect } from "vitest";
import { assessWindow, worstLevel, type PacingThresholds } from "../src/pacing.js";
import { WINDOW_MS } from "../src/limits.js";

const T: PacingThresholds = {
  fiveHourSoftPct: 0.7,
  fiveHourDangerPct: 0.9,
  weeklySoftPct: 0.6,
  weeklyDangerPct: 0.85,
  burnRatioWarn: 1.5,
};

const WEEK = WINDOW_MS.weekly;
const HOUR = 60 * 60 * 1000;

describe("assessWindow — pacing math", () => {
  it("on-pace usage is ok even at moderate utilization", () => {
    // Half the week elapsed, half the quota used → burnRatio ≈ 1, level ok.
    const now = 1_700_000_000_000;
    const resetAt = now + WEEK / 2; // half elapsed
    const a = assessWindow("weekly", { utilization: 0.5, resetAt }, T, now);
    expect(a.burnRatio).toBeCloseTo(1, 1);
    expect(a.level).toBe("ok");
    expect(a.willLockOutBeforeReset).toBe(false);
  });

  it("flags lockout when burning fast enough to exhaust before reset", () => {
    // Only ~1 day elapsed (6 days to reset) but already 60% used → will lock out.
    const now = 1_700_000_000_000;
    const resetAt = now + 6 * 24 * HOUR; // 1 day elapsed of a 7-day window
    const a = assessWindow("weekly", { utilization: 0.6, resetAt }, T, now);
    expect(a.burnRatio!).toBeGreaterThan(3);
    expect(a.willLockOutBeforeReset).toBe(true);
    expect(a.level).toBe("danger");
    expect(a.projectedExhaustionAt!).toBeLessThan(resetAt);
  });

  it("does NOT escalate on a lockout projection at low utilization (no false alarms)", () => {
    // 15% used, 1 day into a 7-day window: projected exhaustion can land just
    // before reset (projection noise), but 15% is too little to cry danger.
    const now = 1_700_000_000_000;
    const resetAt = now + 6 * 24 * HOUR;
    const a = assessWindow("weekly", { utilization: 0.15, resetAt }, T, now);
    expect(a.level).toBe("ok");
    expect(a.message).not.toMatch(/lockout/);
  });

  it("absolute danger threshold trips even when perfectly on pace", () => {
    const now = 1_700_000_000_000;
    const resetAt = now + WEEK * 0.1; // 90% elapsed
    const a = assessWindow("weekly", { utilization: 0.9, resetAt }, T, now);
    expect(a.level).toBe("danger"); // 0.9 >= weeklyDangerPct 0.85
  });

  it("handles a missing reset time (no burn ratio, util-only level)", () => {
    const now = 1_700_000_000_000;
    const a = assessWindow("5h", { utilization: 0.75, resetAt: null }, T, now);
    expect(a.burnRatio).toBeNull();
    expect(a.projectedExhaustionAt).toBeNull();
    expect(a.level).toBe("warn"); // 0.75 >= 0.7 soft, < 0.9 danger
  });

  it("message reads like a human warning", () => {
    const now = 1_700_000_000_000;
    const resetAt = now + 6 * 24 * HOUR;
    const a = assessWindow("weekly", { utilization: 0.6, resetAt }, T, now);
    expect(a.message).toMatch(/weekly limit 60% used/);
    expect(a.message).toMatch(/lockout/);
  });
});

describe("worstLevel", () => {
  it("returns the most severe level present", () => {
    expect(worstLevel([{ level: "ok" } as any, { level: "warn" } as any])).toBe("warn");
    expect(worstLevel([{ level: "warn" } as any, { level: "danger" } as any])).toBe("danger");
    expect(worstLevel([])).toBe("ok");
  });
});
