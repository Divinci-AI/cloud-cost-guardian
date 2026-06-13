/**
 * Budget evaluation — the decision core shared by hook and proxy.
 *
 * Two scopes, two thresholds each:
 *   - session: catches a single runaway run (the $4,200-weekend scenario)
 *   - daily rolling 24h: catches many small sessions adding up (the $87k-month)
 *
 * Verdict levels: ok → warn (soft cap crossed) → block (hard cap reached).
 * The hard cap is a >= comparison so spend can never exceed it by design.
 */

import { fmtUSD } from "./cost.js";

export interface Budget {
  sessionSoftUSD: number;
  sessionHardUSD: number;
  dailySoftUSD: number;
  dailyHardUSD: number;
}

export type VerdictLevel = "ok" | "warn" | "block";

export interface Verdict {
  level: VerdictLevel;
  /** Which scopes tripped, for dedup of warnings and for the alert payload. */
  triggers: Array<{
    scope: "session" | "daily";
    level: "warn" | "block";
    spentUSD: number;
    limitUSD: number;
    pct: number;
  }>;
  /** Human-readable summary lines. */
  reasons: string[];
}

export interface Spend {
  sessionUSD: number;
  dailyUSD: number;
}

function pct(spent: number, limit: number): number {
  return limit > 0 ? Math.round((spent / limit) * 100) : 0;
}

export function evaluate(spend: Spend, budget: Budget): Verdict {
  const triggers: Verdict["triggers"] = [];
  const reasons: string[] = [];

  const checks: Array<{ scope: "session" | "daily"; spent: number; soft: number; hard: number }> = [
    { scope: "session", spent: spend.sessionUSD, soft: budget.sessionSoftUSD, hard: budget.sessionHardUSD },
    { scope: "daily", spent: spend.dailyUSD, soft: budget.dailySoftUSD, hard: budget.dailyHardUSD },
  ];

  for (const c of checks) {
    if (c.hard > 0 && c.spent >= c.hard) {
      triggers.push({ scope: c.scope, level: "block", spentUSD: c.spent, limitUSD: c.hard, pct: pct(c.spent, c.hard) });
      reasons.push(`${c.scope} spend ${fmtUSD(c.spent)} reached the hard cap of ${fmtUSD(c.hard)}`);
    } else if (c.soft > 0 && c.spent >= c.soft) {
      triggers.push({ scope: c.scope, level: "warn", spentUSD: c.spent, limitUSD: c.soft, pct: pct(c.spent, c.soft) });
      // Reference the hard cap when set, otherwise the soft cap — never claim
      // "% of hard cap" when the hard cap is disabled (0).
      const refLimit = c.hard > 0 ? c.hard : c.soft;
      const refLabel = c.hard > 0 ? "hard cap" : "soft cap";
      reasons.push(`${c.scope} spend ${fmtUSD(c.spent)} crossed the soft cap of ${fmtUSD(c.soft)} (${pct(c.spent, refLimit)}% of ${refLabel})`);
    }
  }

  const level: VerdictLevel = triggers.some((t) => t.level === "block")
    ? "block"
    : triggers.some((t) => t.level === "warn")
      ? "warn"
      : "ok";

  return { level, triggers, reasons };
}

/** Stable key for deduping a warn-level trigger so we alert once per scope, not per tool call. */
export function warnKey(scope: "session" | "daily"): string {
  return `warn:${scope}`;
}
