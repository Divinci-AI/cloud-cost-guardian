import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildLimitsReport, formatLimitsLines, formatStatusline, formatStatusReport, buildStatusReport } from "../src/report.js";
import { saveLimitsState, emptyLimitsState, WINDOW_MS, type LimitSnapshot } from "../src/limits.js";
import { DEFAULT_BUDGET, DEFAULT_LIMITS, type GuardConfig } from "../src/config.js";
import { emptyLedger, saveLedger, setSessionCost, type Ledger } from "../src/ledger.js";
import { setBudget } from "../src/ops.js";

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

describe("formatStatusReport — adaptive status view", () => {
  it("renders disabled dollar caps as 'off' — never $0.00 / '% of hard cap'", () => {
    setBudget({ sessionHardUSD: 0, dailyHardUSD: 0, sessionSoftUSD: 100, dailySoftUSD: 300 });
    const led = emptyLedger();
    setSessionCost(led, "s", 800, 100, 100, now);
    saveLedger(led);
    const out = formatStatusReport(buildStatusReport(now), now).join("\n");
    expect(out).toMatch(/Dollar caps: off/);
    expect(out).not.toMatch(/% of hard cap/); // the old divide-by-zero nonsense
    expect(out).not.toMatch(/\/ \$0\.00/);
  });

  it("leads with plan limits, then the dollar section, on a subscription", () => {
    saveLimitsState({
      ...emptyLimitsState(),
      subscriptionDetected: true,
      snapshot: {
        fiveHour: { utilization: 0.25, resetAt: now + 3 * HOUR },
        weekly: { utilization: 0.28, resetAt: now + 3 * DAY },
        status: "oauth-usage",
        observedAt: now,
      },
    });
    setBudget({ sessionHardUSD: 0, dailyHardUSD: 0 });
    const lines = formatStatusReport(buildStatusReport(now), now);
    const planIdx = lines.findIndex((l) => l.includes("Claude Code plan limits"));
    const dollarIdx = lines.findIndex((l) => l.includes("Dollar caps"));
    expect(planIdx).toBeGreaterThanOrEqual(0);
    expect(dollarIdx).toBeGreaterThan(planIdx); // real signal first
  });
});

describe("formatStatusline — status-bar one-liner", () => {
  it("shows real percentages with a level dot when we have headers", () => {
    saveLimitsState({
      ...emptyLimitsState(),
      subscriptionDetected: true,
      snapshot: snapshot({
        fiveHour: { utilization: 0.26, resetAt: now + 3 * HOUR },
        weekly: { utilization: 0.19, resetAt: now + 3 * DAY },
      }),
    });
    const r = buildLimitsReport(cfg("auto"), emptyLedger(), now);
    // Compact pill: percent-before-label, plus derived daily burn (weekly ÷ days
    // elapsed = 19% ÷ 4d = ~5%/day) and weekly days-left (3.0wd).
    expect(formatStatusline(r, now)).toBe("🛡 🟢 26%5h · 19%w · 5%d · 3.0wd");
  });

  it("shows fractional weekly-days-left inside the final day", () => {
    saveLimitsState({
      ...emptyLimitsState(),
      subscriptionDetected: true,
      snapshot: snapshot({
        fiveHour: { utilization: 0.26, resetAt: now + 3 * HOUR },
        weekly: { utilization: 0.8, resetAt: now + 10 * HOUR },
      }),
    });
    const r = buildLimitsReport(cfg("auto"), emptyLedger(), now);
    // ~6.6 days elapsed → daily burn 80% ÷ 6.58 ≈ 12%/day; 10h left ≈ 0.4wd.
    expect(formatStatusline(r, now)).toBe("🛡 🟢 26%5h · 80%w · 12%d · 0.4wd");
  });

  it("falls back to tier + 'usage pending' with no live data", () => {
    const r = buildLimitsReport(cfg("max20"), emptyLedger(), now);
    expect(formatStatusline(r)).toBe("🛡 Max 20x · usage pending");
  });

  it("says 'limits · usage pending' when the tier is unknown too", () => {
    const r = buildLimitsReport(cfg("auto"), emptyLedger(), now);
    expect(formatStatusline(r)).toBe("🛡 limits · usage pending");
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

/**
 * Staleness. A snapshot that stopped refreshing must never be rendered as live
 * numbers: a 10-hour-old "0%" looks identical to a real 0% but is simply wrong,
 * and it's the same fabricated-percentage we refuse to show anywhere else.
 */
describe("stale snapshots — say so instead of quoting old numbers", () => {
  it("marks an aged snapshot stale, refuses to colour off it, and says 'limits stale'", () => {
    saveLimitsState({
      ...emptyLimitsState(),
      subscriptionDetected: true,
      snapshot: snapshot({
        fiveHour: { utilization: 0.9, resetAt: now + 2 * HOUR },
        weekly: { utilization: 0.95, resetAt: now + 2 * DAY },
        observedAt: now - 10 * 60 * 60_000, // 10 hours ago
      }),
    });
    const r = buildLimitsReport(cfg("auto"), emptyLedger(), now);

    expect(r.stale).toBe(true);
    expect(r.ageMs).toBe(10 * 60 * 60_000);
    // 95% weekly would normally be danger — but we won't grade stale data.
    expect(r.level).toBe("ok");

    const bar = formatStatusline(r, now);
    expect(bar).toMatch(/limits stale/);
    expect(bar).not.toMatch(/90%|95%|🟥|🟡/); // no confident numbers, no alarm colour

    expect(formatLimitsLines(r, now).join("\n")).toMatch(/STALE/);
  });

  it("a fresh snapshot is not stale and still renders real numbers", () => {
    saveLimitsState({
      ...emptyLimitsState(),
      subscriptionDetected: true,
      snapshot: snapshot({
        fiveHour: { utilization: 0.5, resetAt: now + 2 * HOUR },
        weekly: { utilization: 0.25, resetAt: now + 5 * DAY },
        observedAt: now - 60_000, // a minute ago
      }),
    });
    const r = buildLimitsReport(cfg("auto"), emptyLedger(), now);
    expect(r.stale).toBe(false);
    // 2 days elapsed → daily burn 25% ÷ 2 = 12.5 ≈ 13%/day.
    expect(formatStatusline(r, now)).toBe("🛡 🟢 50%5h · 25%w · 13%d · 5.0wd");
  });
});
