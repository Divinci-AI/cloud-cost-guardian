/**
 * Shared status report — the single computation behind `agent-guard status` and
 * `ks guard status`, so both emit an identical JSON shape and never drift.
 *
 * Two halves:
 *   - the dollar budget (session + daily-rolling), always present; and
 *   - the subscription rate-limit standing. Real 5-hour/weekly utilization is
 *     only knowable from Anthropic's `unified-*` headers, which the proxy
 *     captures — so when we have a fresh snapshot we show real percentages, and
 *     otherwise we show what's honestly knowable locally: the auto-detected plan
 *     tier plus absolute rolling cost (NOT a fabricated "% of limit" — local cost
 *     does not map to Anthropic's internal rate-limit units). Alert-only.
 */

import { loadConfig, isPaused, pauseExpiry, type GuardConfig } from "./config.js";
import { loadLedger, rollingDailyCost, type SessionRecord, type Ledger } from "./ledger.js";
import { evaluate, type Budget, type VerdictLevel } from "./budget.js";
import { fmtUSD } from "./cost.js";
import { loadLimitsState, WINDOW_MS, type ExtraWindow } from "./limits.js";
import { assessSnapshot, worstLevel, type PacingAssessment, type PacingLevel } from "./pacing.js";
import { detectPlanTier, tierLabel, type SubscriptionTier } from "./claude-code.js";

const DAY_MS = 24 * 60 * 60 * 1000;

export interface LimitsReport {
  /** "headers" = real proxy data; "none" = no live data (show tier + cost only). */
  source: "headers" | "none";
  /** Configured plan ("auto" | tier). */
  plan: string;
  /** Resolved subscription tier (from config or auto-detected from ~/.claude.json). */
  tier: SubscriptionTier | null;
  /** True when the tier came from ~/.claude.json rather than an explicit --plan. */
  tierDetected: boolean;
  subscriptionDetected: boolean;
  /** Epoch ms the headers snapshot was observed, or null. */
  observedAt: number | null;
  /** Real per-window pacing (only when source === "headers"). */
  windows: PacingAssessment[];
  /** Extra display-only windows (per-model weekly) from the OAuth usage endpoint. */
  extras: ExtraWindow[];
  level: PacingLevel;
  /** Absolute rolling cost (API-equivalent USD) — honest local signal, not a limit %. */
  cost: { fiveHourUSD: number; dailyUSD: number; weeklyUSD: number };
}

export interface StatusReport {
  budget: Budget;
  dailyUSD: number;
  verdict: VerdictLevel;
  reasons: string[];
  paused: boolean;
  pauseUntil: number | null;
  sessions: Array<{ id: string } & SessionRecord>;
  limits: LimitsReport;
}

/** Sum metered cost across sessions whose last activity is within `windowMs`. */
function costInWindow(ledger: Ledger, now: number, windowMs: number): number {
  let total = 0;
  for (const s of Object.values(ledger.sessions)) {
    if (now - s.lastAt < windowMs) total += s.costUSD || 0;
  }
  return total;
}

/**
 * Compute the subscription rate-limit section. Exported so the Claude Code hook
 * can reuse its already-loaded cfg + ledger instead of paying for a second
 * loadConfig/loadLedger on every tool call.
 */
export function buildLimitsReport(cfg: GuardConfig, ledger: Ledger, now: number): LimitsReport {
  const state = loadLimitsState();
  const plan = cfg.limits.plan;
  // A pinned tier is free to know; auto-detection (a big ~/.claude.json parse) is
  // deferred to the no-live-data branch below, where the tier is actually shown —
  // so the hook's hot path doesn't parse that file on every tool call (G2).
  const pinnedTier: SubscriptionTier | null =
    plan === "pro" || plan === "max5" || plan === "max20" ? plan : null;

  const cost = {
    fiveHourUSD: costInWindow(ledger, now, WINDOW_MS["5h"]),
    dailyUSD: costInWindow(ledger, now, DAY_MS),
    weeklyUSD: costInWindow(ledger, now, WINDOW_MS.weekly),
  };

  // Real data: a fresh snapshot, with any already-reset window dropped (stale).
  const snap = state.snapshot;
  if (snap && now - snap.observedAt < WINDOW_MS.weekly) {
    const windows = assessSnapshot(snap, cfg.limits, now).filter(
      (w) => !(w.resetAt != null && w.resetAt <= now),
    );
    if (windows.length) {
      return {
        source: "headers",
        plan,
        tier: pinnedTier, // headers view doesn't display the tier; skip the detection parse
        tierDetected: false,
        subscriptionDetected: state.subscriptionDetected,
        observedAt: snap.observedAt,
        windows,
        extras: snap.extras ?? [],
        level: worstLevel(windows),
        cost,
      };
    }
  }

  // No live data — honest local signal only (tier + absolute cost, never a fake %).
  // The tier IS shown here, so auto-detect it now (lazily).
  let tier = pinnedTier;
  let tierDetected = false;
  if (!tier) {
    const detected = detectPlanTier();
    if (detected) {
      tier = detected;
      tierDetected = true;
    }
  }
  return {
    source: "none",
    plan,
    tier,
    tierDetected,
    subscriptionDetected: state.subscriptionDetected,
    observedAt: null,
    windows: [],
    extras: [],
    level: "ok",
    cost,
  };
}

function bar(frac: number): string {
  const pct = Math.max(0, Math.min(100, Math.round(frac * 100)));
  const filled = Math.round(pct / 5);
  return `[${"█".repeat(filled)}${"░".repeat(20 - filled)}]`;
}

function ageString(observedAt: number, now: number): string {
  const ms = now - observedAt;
  if (ms < 60_000) return "just now";
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m ago`;
  if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)}h ago`;
  return `${Math.round(ms / 86_400_000)}d ago`;
}

/**
 * Render the subscription rate-limit section as plain text lines (no color), so
 * both the `agent-guard` and `ks guard` status views stay identical.
 */
export function formatLimitsLines(limits: LimitsReport, now: number = Date.now()): string[] {
  // Real proxy data → real percentages.
  if (limits.source === "headers") {
    const icon = limits.level === "danger" ? "🟥" : limits.level === "warn" ? "🟡" : "🟢";
    const lines = [`${icon} Claude Code plan limits  ·  observed ${limits.observedAt ? ageString(limits.observedAt, now) : "—"}`];
    for (const w of limits.windows) lines.push(`  ${bar(w.utilization)}  ${w.message}`);
    for (const e of limits.extras) {
      const pct = `${Math.round(e.utilization * 100)}%`.padStart(4);
      lines.push(`  ${bar(e.utilization)}  ${e.label} ${pct}`);
    }
    return lines;
  }

  // No live data: show what's honestly knowable — the tier and absolute cost,
  // and steer to the proxy for the real percentages. Never a fabricated % bar.
  const planStr = limits.tier
    ? `Claude Code plan: ${tierLabel(limits.tier)}${limits.tierDetected ? " (detected)" : ""}`
    : "Claude Code plan: unknown";
  const c = limits.cost;
  return [
    `📊 ${planStr} — real 5-hour/weekly limit % needs the proxy`,
    `   local rolling cost (API-equivalent, NOT a limit %): 5h ${fmtUSD(c.fiveHourUSD)} · 24h ${fmtUSD(c.dailyUSD)} · 7d ${fmtUSD(c.weeklyUSD)}`,
    `   for exact limits: \`ks guard proxy\` → ANTHROPIC_BASE_URL=http://localhost:8787 claude`,
  ];
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
    limits: buildLimitsReport(cfg, ledger, now),
  };
}
