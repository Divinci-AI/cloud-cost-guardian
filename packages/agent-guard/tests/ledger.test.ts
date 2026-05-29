import { describe, it, expect } from "vitest";
import {
  emptyLedger,
  setSessionCost,
  addSessionCost,
  rollingDailyCost,
  prune,
} from "../src/ledger.js";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

describe("ledger spend tracking", () => {
  it("setSessionCost is authoritative (overwrites, not accumulates)", () => {
    const l = emptyLedger();
    const now = 1_000_000_000_000;
    setSessionCost(l, "s1", 5, 100, 50, now);
    setSessionCost(l, "s1", 8, 200, 90, now + 1000);
    expect(l.sessions.s1.costUSD).toBe(8);
    expect(l.sessions.s1.inputTokens).toBe(200);
  });

  it("addSessionCost accumulates deltas", () => {
    const l = emptyLedger();
    const now = 1_000_000_000_000;
    addSessionCost(l, "p1", 2, 10, 5, now);
    addSessionCost(l, "p1", 3, 10, 5, now + 1000);
    expect(l.sessions.p1.costUSD).toBeCloseTo(5, 6);
    expect(l.sessions.p1.inputTokens).toBe(20);
  });

  it("rollingDailyCost sums only sessions active within 24h, no double count", () => {
    const l = emptyLedger();
    const now = 2_000_000_000_000;
    setSessionCost(l, "recent-a", 10, 0, 0, now - 2 * HOUR);
    setSessionCost(l, "recent-b", 7, 0, 0, now - 23 * HOUR);
    setSessionCost(l, "old", 50, 0, 0, now - 2 * DAY); // outside window
    expect(rollingDailyCost(l, now)).toBeCloseTo(17, 6);
  });

  it("prune drops sessions older than the cutoff", () => {
    const l = emptyLedger();
    const now = 2_000_000_000_000;
    setSessionCost(l, "keep", 1, 0, 0, now - 1 * DAY);
    setSessionCost(l, "drop", 1, 0, 0, now - 30 * DAY);
    prune(l, now, 14);
    expect(l.sessions.keep).toBeDefined();
    expect(l.sessions.drop).toBeUndefined();
  });
});
