import { describe, it, expect } from "vitest";
import { estimateSnapshot, isEstimated, TIER_BUDGETS } from "../src/estimate.js";
import { emptyLedger, type Ledger } from "../src/ledger.js";

/**
 * Hook-only estimation is a fuzzy fallback (no headers to read), so we only
 * assert the directional behaviour: tokens in-window drive utilization up,
 * out-of-window tokens are ignored, and snapshots are tagged "estimated".
 */

function ledgerWith(records: Array<{ lastAt: number; inTok: number; outTok: number }>): Ledger {
  const l = emptyLedger();
  records.forEach((r, i) => {
    l.sessions[`s${i}`] = {
      startedAt: r.lastAt,
      lastAt: r.lastAt,
      costUSD: 0,
      inputTokens: r.inTok,
      outputTokens: r.outTok,
      notified: {},
    };
  });
  return l;
}

const now = 1_700_000_000_000;
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

describe("estimateSnapshot", () => {
  it("counts in-window tokens toward utilization", () => {
    // Half of Pro's 5h budget, recent → ~50% 5h utilization.
    const half = TIER_BUDGETS.pro.fiveHourTokens / 2;
    const ledger = ledgerWith([{ lastAt: now - HOUR, inTok: half, outTok: 0 }]);
    const snap = estimateSnapshot(ledger, "pro", now);
    expect(snap.fiveHour!.utilization).toBeCloseTo(0.5, 1);
    expect(isEstimated(snap)).toBe(true);
  });

  it("ignores activity outside the window", () => {
    // Activity 10 days ago counts toward neither 5h nor weekly.
    const ledger = ledgerWith([{ lastAt: now - 10 * DAY, inTok: 999_000_000, outTok: 0 }]);
    const snap = estimateSnapshot(ledger, "max5", now);
    expect(snap.fiveHour!.utilization).toBe(0);
    expect(snap.weekly!.utilization).toBe(0);
  });

  it("clamps utilization at 1.0 on a blowout", () => {
    const ledger = ledgerWith([{ lastAt: now - HOUR, inTok: 10 * TIER_BUDGETS.pro.fiveHourTokens, outTok: 0 }]);
    const snap = estimateSnapshot(ledger, "pro", now);
    expect(snap.fiveHour!.utilization).toBe(1);
  });

  it("scales down utilization for higher tiers (more headroom)", () => {
    const tokens = TIER_BUDGETS.pro.weeklyTokens; // exactly Pro's weekly budget
    const ledger = ledgerWith([{ lastAt: now - DAY, inTok: tokens, outTok: 0 }]);
    const pro = estimateSnapshot(ledger, "pro", now).weekly!.utilization;
    const max20 = estimateSnapshot(ledger, "max20", now).weekly!.utilization;
    expect(pro).toBeGreaterThan(max20);
  });
});
