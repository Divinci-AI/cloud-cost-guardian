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

  it("falls through to the estimate when the snapshot is stale and a tier is pinned", () => {
    saveLimitsState({
      ...emptyLimitsState(),
      subscriptionDetected: true,
      // all windows already reset → snapshot yields nothing usable
      snapshot: snapshot({ weekly: { utilization: 0.9, resetAt: now - HOUR } }),
    });
    const ledger: Ledger = emptyLedger();
    ledger.sessions["s"] = { startedAt: now, lastAt: now, costUSD: 0, inputTokens: 1000, outputTokens: 500, notified: {} };
    const r = buildLimitsReport(cfg("max5"), ledger, now);
    expect(r.source).toBe("estimated");
  });
});

describe("estimate honesty (F4)", () => {
  it("estimated windows have no fabricated reset time, and no 'resets' clause", () => {
    const ledger: Ledger = emptyLedger();
    ledger.sessions["s"] = { startedAt: now, lastAt: now, costUSD: 0, inputTokens: 5_000_000, outputTokens: 1_000_000, notified: {} };
    const r = buildLimitsReport(cfg("pro"), ledger, now);
    expect(r.source).toBe("estimated");
    for (const w of r.windows) expect(w.resetAt).toBeNull();
    const text = formatLimitsLines(r, now).join("\n");
    expect(text).not.toMatch(/resets/);
    expect(text).toMatch(/estimated/);
  });
});
