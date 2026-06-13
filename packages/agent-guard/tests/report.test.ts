import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildLimitsReport, formatLimitsLines } from "../src/report.js";
import { saveLimitsState, emptyLimitsState, WINDOW_MS, type LimitSnapshot } from "../src/limits.js";
import { DEFAULT_BUDGET, DEFAULT_LIMITS, type GuardConfig } from "../src/config.js";
import { emptyLedger, type Ledger } from "../src/ledger.js";

/**
 * Staleness (F2/F3) and estimate honesty (F4). buildLimitsReport reads
 * limits.json from $HOME, so a temp home isolates each case.
 */

let prevHome: string | undefined;
beforeEach(() => {
  prevHome = process.env.HOME;
  process.env.HOME = mkdtempSync(join(tmpdir(), "ag-report-"));
});
afterEach(() => {
  if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
});

const now = 1_700_000_000_000;
const HOUR = 3600_000;
const DAY = 24 * HOUR;

function cfg(plan: GuardConfig["limits"]["plan"]): GuardConfig {
  return { budget: { ...DEFAULT_BUDGET }, limits: { ...DEFAULT_LIMITS, plan } } as GuardConfig;
}

function snapshot(partial: Partial<LimitSnapshot>): LimitSnapshot {
  return { fiveHour: null, weekly: null, status: "allowed", observedAt: now, ...partial };
}

describe("buildLimitsReport — staleness (F2/F3)", () => {
  it("drops a window whose reset has already passed, keeps the live one", () => {
    saveLimitsState({
      ...emptyLimitsState(),
      subscriptionDetected: true,
      snapshot: snapshot({
        fiveHour: { utilization: 0.8, resetAt: now - HOUR }, // already reset → must be dropped
        weekly: { utilization: 0.5, resetAt: now + 3 * DAY }, // still live
      }),
    });
    const r = buildLimitsReport(cfg("auto"), emptyLedger(), now);
    expect(r.source).toBe("headers");
    expect(r.windows.map((w) => w.window)).toEqual(["weekly"]);
  });

  it("ignores a snapshot older than the weekly window entirely", () => {
    saveLimitsState({
      ...emptyLimitsState(),
      subscriptionDetected: true,
      snapshot: snapshot({
        observedAt: now - (WINDOW_MS.weekly + DAY), // ancient
        weekly: { utilization: 0.9, resetAt: now + DAY },
      }),
    });
    const r = buildLimitsReport(cfg("auto"), emptyLedger(), now);
    expect(r.source).toBe("none"); // too old to trust, no pinned tier to estimate from
  });

  it("with a stale snapshot and a pinned tier, shows tier + cost — no fake estimate", () => {
    saveLimitsState({
      ...emptyLimitsState(),
      subscriptionDetected: true,
      // all windows already reset → snapshot yields nothing usable
      snapshot: snapshot({ weekly: { utilization: 0.9, resetAt: now - HOUR } }),
    });
    const ledger: Ledger = emptyLedger();
    ledger.sessions["s"] = { startedAt: now, lastAt: now, costUSD: 12.5, inputTokens: 0, outputTokens: 0, notified: {} };
    const r = buildLimitsReport(cfg("max5"), ledger, now);
    expect(r.source).toBe("none"); // no estimate — honest "no live data"
    expect(r.tier).toBe("max5");
    expect(r.windows).toEqual([]);
    expect(r.cost.weeklyUSD).toBeCloseTo(12.5);
  });
});

describe("honest no-proxy output (no fabricated %)", () => {
  it("shows the pinned/detected tier + absolute cost, never a limit %", () => {
    const ledger: Ledger = emptyLedger();
    ledger.sessions["s"] = { startedAt: now, lastAt: now, costUSD: 5301, inputTokens: 0, outputTokens: 0, notified: {} };
    const r = buildLimitsReport(cfg("max20"), ledger, now);
    expect(r.source).toBe("none");
    expect(r.tier).toBe("max20");
    const text = formatLimitsLines(r, now).join("\n");
    expect(text).toMatch(/Max 20x/);
    expect(text).toMatch(/NOT a limit %/);
    expect(text).toMatch(/ks guard proxy/);
    expect(text).not.toMatch(/\d+% used/); // crucially: no fabricated percentage
    expect(text).toMatch(/7d \$5301/); // honest absolute rolling cost
  });
});
