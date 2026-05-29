/**
 * Shared status report — the single computation behind `agent-guard status` and
 * `ks guard status`, so both emit an identical JSON shape and never drift.
 */

import { loadConfig } from "./config.js";
import { isPaused, pauseExpiry } from "./config.js";
import { loadLedger, rollingDailyCost, type SessionRecord } from "./ledger.js";
import { evaluate, type Budget, type VerdictLevel } from "./budget.js";

const DAY_MS = 24 * 60 * 60 * 1000;

export interface StatusReport {
  budget: Budget;
  dailyUSD: number;
  verdict: VerdictLevel;
  reasons: string[];
  paused: boolean;
  /** Epoch ms the pause auto-expires, or null (indefinite / not paused). */
  pauseUntil: number | null;
  sessions: Array<{ id: string } & SessionRecord>;
}

/** Build the current status report from the on-disk config + ledger. */
export function buildStatusReport(now: number = Date.now()): StatusReport {
  const cfg = loadConfig();
  const ledger = loadLedger();
  const dailyUSD = rollingDailyCost(ledger, now);

  const sessions = Object.entries(ledger.sessions)
    .filter(([, s]) => now - s.lastAt < DAY_MS)
    .sort((a, b) => b[1].lastAt - a[1].lastAt)
    .map(([id, s]) => ({ id, ...s }));

  const topSession = sessions[0]?.costUSD ?? 0;
  const verdict = evaluate({ sessionUSD: topSession, dailyUSD }, cfg.budget);

  return {
    budget: cfg.budget,
    dailyUSD,
    verdict: verdict.level,
    reasons: verdict.reasons,
    paused: isPaused(now),
    pauseUntil: pauseExpiry(),
    sessions,
  };
}
