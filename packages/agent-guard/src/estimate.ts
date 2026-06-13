/**
 * Hook-only fallback estimate of subscription utilization.
 *
 * Ground truth for plan limits lives in the `anthropic-ratelimit-unified-*`
 * response headers, which only the proxy sees. A user running just the Claude
 * Code hook (the common, zero-config setup) never sees those headers — so when
 * they've told us their plan tier, we *estimate* where they stand.
 *
 * We estimate from the ledger's **cost** (`costUSD`), not its token counts. That
 * matters: a coding agent's volume is dominated by cache reads/writes, and the
 * ledger only stores non-cache input/output token counts — so a token-based
 * estimate undercounts real throughput (and thus rate-limit consumption) by a
 * large factor. `costUSD` is priced from the *full* usage including cache, so it
 * tracks actual consumption far better. We compare it against a rough per-tier
 * **API-equivalent** dollar ceiling for each window.
 *
 * This is still deliberately approximate and always labelled as such:
 *   - Anthropic meters opaque "prompts" / "active hours", and the dollar ceilings
 *     below are rough API-equivalent calibrations, not contractual.
 *   - The ledger stores a session's cumulative cost against a single `lastAt`,
 *     not a time series, so a long session is counted wholesale into whichever
 *     window its last activity falls in.
 *
 * It exists to give hook-only users *a* directional signal and to nudge them
 * toward `ks guard proxy` for exact numbers — never to block (subscription mode
 * is alert-only).
 */

import { WINDOW_MS, type LimitSnapshot } from "./limits.js";
import type { Ledger } from "./ledger.js";

export type PlanTier = "pro" | "max5" | "max20";

/**
 * Rough per-tier **API-equivalent USD** ceilings per window — what the plan's
 * rate limit lets you consume before lock-out, expressed in the same list-price
 * dollars the ledger meters. Scaled by plan: Pro is the baseline, Max 5x/20x lift
 * the burst (5h) roughly with the multiplier and the weekly cap more
 * conservatively. These are estimates; the proxy's real headers override them.
 */
export interface TierBudget {
  fiveHourUSD: number;
  weeklyUSD: number;
}

export const TIER_BUDGETS: Record<PlanTier, TierBudget> = {
  pro: { fiveHourUSD: 16, weeklyUSD: 100 },
  max5: { fiveHourUSD: 80, weeklyUSD: 500 },
  max20: { fiveHourUSD: 300, weeklyUSD: 2000 },
};

const FIVE_HOUR_MS = WINDOW_MS["5h"];
const WEEK_MS = WINDOW_MS.weekly;

/** Sum metered cost across sessions whose last activity is within `windowMs`. */
function costInWindow(ledger: Ledger, now: number, windowMs: number): number {
  let total = 0;
  for (const s of Object.values(ledger.sessions)) {
    if (now - s.lastAt < windowMs) total += s.costUSD || 0;
  }
  return total;
}

/**
 * Build an estimated {@link LimitSnapshot} from the ledger for a known tier.
 * `resetAt` is null (the true rolling reset is unknowable without a per-event
 * time series), so pacing reports utilization only — no fabricated reset/lockout.
 */
export function estimateSnapshot(
  ledger: Ledger,
  tier: PlanTier,
  now: number,
  budgets: Record<PlanTier, TierBudget> = TIER_BUDGETS,
): LimitSnapshot {
  const b = budgets[tier];
  const fiveUSD = costInWindow(ledger, now, FIVE_HOUR_MS);
  const weekUSD = costInWindow(ledger, now, WEEK_MS);
  const clamp = (n: number) => Math.max(0, Math.min(1, n));

  return {
    fiveHour: { utilization: clamp(fiveUSD / b.fiveHourUSD), resetAt: null, status: "estimated" },
    weekly: { utilization: clamp(weekUSD / b.weeklyUSD), resetAt: null, status: "estimated" },
    status: "estimated",
    observedAt: now,
  };
}

/** True when a snapshot came from {@link estimateSnapshot} rather than real headers. */
export function isEstimated(snap: LimitSnapshot | null): boolean {
  return !!snap && snap.status === "estimated";
}
