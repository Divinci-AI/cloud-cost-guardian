/**
 * Hook-only fallback estimate of subscription utilization.
 *
 * Ground truth for plan limits lives in the `anthropic-ratelimit-unified-*`
 * response headers, which only the proxy sees. A user running just the Claude
 * Code hook (the common, zero-config setup) never sees those headers — so when
 * they've told us their plan tier, we *estimate* where they stand by summing the
 * tokens the ledger recorded inside each rolling window and dividing by a
 * per-tier token budget.
 *
 * This is deliberately approximate and always labelled as such:
 *   - Anthropic meters opaque "prompts" / "active hours", not tokens, so the
 *     token budgets below are calibrated rough equivalents, not contractual.
 *   - The ledger stores a session's cumulative tokens against a single
 *     `lastAt`, not a time series, so a long session is counted wholesale into
 *     whichever window its last activity falls in.
 *
 * It exists to give hook-only users *a* signal and to nudge them toward
 * `ks guard proxy` for exact numbers — never to block (subscription mode is
 * alert-only). When in doubt it under-claims utilization so it won't cry wolf.
 */

import { WINDOW_MS, type LimitSnapshot } from "./limits.js";
import type { Ledger } from "./ledger.js";

export type PlanTier = "pro" | "max5" | "max20";

/**
 * Rough per-tier token-equivalent budgets per window. Pro is the published
 * baseline; Max 5x / 20x scale the 5-hour burst ~linearly with the multiplier,
 * while the weekly cap scales more conservatively (Anthropic's weekly multiplier
 * is smaller than the per-session one). Tune via config if your mileage differs.
 */
export interface TierBudget {
  fiveHourTokens: number;
  weeklyTokens: number;
}

export const TIER_BUDGETS: Record<PlanTier, TierBudget> = {
  // Calibrated rough equivalents — Pro ≈ 45 prompts / 5h, modest weekly cap.
  pro: { fiveHourTokens: 8_000_000, weeklyTokens: 120_000_000 },
  max5: { fiveHourTokens: 40_000_000, weeklyTokens: 480_000_000 },
  max20: { fiveHourTokens: 160_000_000, weeklyTokens: 1_400_000_000 },
};

const FIVE_HOUR_MS = WINDOW_MS["5h"];
const WEEK_MS = WINDOW_MS.weekly;

/** Sum tokens (input+output) across sessions whose last activity is within `windowMs`. */
function tokensInWindow(ledger: Ledger, now: number, windowMs: number): number {
  let total = 0;
  for (const s of Object.values(ledger.sessions)) {
    if (now - s.lastAt < windowMs) total += (s.inputTokens || 0) + (s.outputTokens || 0);
  }
  return total;
}

/**
 * Build an estimated {@link LimitSnapshot} from the ledger for a known tier.
 * Reset times are derived from the rolling window assumption (oldest in-window
 * activity + window length is unknowable here, so we report the window end from
 * `now` as a conservative upper bound on time remaining).
 */
export function estimateSnapshot(
  ledger: Ledger,
  tier: PlanTier,
  now: number,
  budgets: Record<PlanTier, TierBudget> = TIER_BUDGETS,
): LimitSnapshot {
  const b = budgets[tier];
  const fiveTokens = tokensInWindow(ledger, now, FIVE_HOUR_MS);
  const weekTokens = tokensInWindow(ledger, now, WEEK_MS);

  const clamp = (n: number) => Math.max(0, Math.min(1, n));

  // resetAt is null, not fabricated: we have no per-event time series, so the
  // true rolling reset is unknowable. A null reset means pacing reports
  // utilization only (no burn-rate, no lockout projection, no bogus reset time) —
  // the honest behaviour for an estimate.
  return {
    fiveHour: { utilization: clamp(fiveTokens / b.fiveHourTokens), resetAt: null, status: "estimated" },
    weekly: { utilization: clamp(weekTokens / b.weeklyTokens), resetAt: null, status: "estimated" },
    status: "estimated",
    observedAt: now,
  };
}

/** True when a snapshot came from {@link estimateSnapshot} rather than real headers. */
export function isEstimated(snap: LimitSnapshot | null): boolean {
  return !!snap && snap.status === "estimated";
}
