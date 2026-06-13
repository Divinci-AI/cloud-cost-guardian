import { describe, it, expect } from "vitest";
import { estimateSnapshot, isEstimated, TIER_BUDGETS } from "../src/estimate.js";
import { emptyLedger, type Ledger } from "../src/ledger.js";

/**
 * Hook-only estimation is a fuzzy fallback (no headers to read), driven by the
 * ledger's COST (which includes cache) rather than raw token counts (which
 * don't). We assert directional behaviour: in-window cost drives utilization up,
 * out-of-window cost is ignored, higher tiers have more headroom, and snapshots
 * are tagged "estimated".
 */

function ledgerWith(records: Array<{ lastAt: number; costUSD: number }>): Ledger {
  const l = emptyLedger();
  records.forEach((r, i) => {
    l.sessions[`s${i}`] = {
      startedAt: r.lastAt,
      lastAt: r.lastAt,
      costUSD: r.costUSD,
      inputTokens: 0,
      outputTokens: 0,
      notified: {},
    };
  });
  return l;
}

const now = 1_700_000_000_000;
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

describe("estimateSnapshot (cost-based)", () => {
  it("counts in-window cost toward utilization", () => {
    // Half of Max 20x's 5h dollar ceiling, recent → ~50% 5h utilization.
    const half = TIER_BUDGETS.max20.fiveHourUSD / 2;
    const ledger = ledgerWith([{ lastAt: now - HOUR, costUSD: half }]);
    const snap = estimateSnapshot(ledger, "max20", now);
    expect(snap.fiveHour!.utilization).toBeCloseTo(0.5, 1);
    expect(snap.fiveHour!.resetAt).toBeNull();
    expect(isEstimated(snap)).toBe(true);
  });

  it("uses cost (incl. cache), so a heavy spender reads high — not 1%", () => {
    // The bug this fixes: token-count estimates undercounted cache-heavy agents.
    // A week of heavy spend should read near the cap, not trivially low.
    const ledger = ledgerWith([{ lastAt: now - DAY, costUSD: TIER_BUDGETS.max20.weeklyUSD * 2 }]);
    const snap = estimateSnapshot(ledger, "max20", now);
    expect(snap.weekly!.utilization).toBe(1); // clamped — clearly maxed
  });

  it("ignores activity outside the window", () => {
    const ledger = ledgerWith([{ lastAt: now - 10 * DAY, costUSD: 99_999 }]);
    const snap = estimateSnapshot(ledger, "max5", now);
    expect(snap.fiveHour!.utilization).toBe(0);
    expect(snap.weekly!.utilization).toBe(0);
  });

  it("scales down utilization for higher tiers (more headroom)", () => {
    const cost = TIER_BUDGETS.pro.weeklyUSD; // exactly Pro's weekly ceiling
    const ledger = ledgerWith([{ lastAt: now - DAY, costUSD: cost }]);
    const pro = estimateSnapshot(ledger, "pro", now).weekly!.utilization;
    const max20 = estimateSnapshot(ledger, "max20", now).weekly!.utilization;
    expect(pro).toBeGreaterThan(max20);
  });
});
