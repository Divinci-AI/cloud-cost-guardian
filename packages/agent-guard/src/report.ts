/**
 * Shared status report — the single computation behind `agent-guard status` and
 * `ks guard status`, so both emit an identical JSON shape and never drift.
 *
 * Two halves:
 *   - the dollar budget (session + daily-rolling), always present; and
 *   - the subscription rate-limit standing (5-hour + weekly pacing), present
 *     once we've seen Anthropic's unified headers via the proxy, or estimated
 *     when the user has pinned a plan tier. Alert-only — never blocks.
 */

import { loadConfig } from "./config.js";
import { isPaused, pauseExpiry } from "./config.js";
import { loadLedger, rollingDailyCost, type SessionRecord } from "./ledger.js";
import { evaluate, type Budget, type VerdictLevel } from "./budget.js";
import { loadLimitsState, WINDOW_MS } from "./limits.js";
import { assessSnapshot, worstLevel, type PacingAssessment, type PacingLevel } from "./pacing.js";
import { estimateSnapshot, type PlanTier } from "./estimate.js";
import type { GuardConfig } from "./config.js";
import type { Ledger } from "./ledger.js";

const DAY_MS = 24 * 60 * 60 * 1000;

export interface LimitsReport {
  /** Where the numbers came from. "none" = no data and no pinned plan to estimate from. */
  source: "headers" | "estimated" | "none";
  plan: string;
  subscriptionDetected: boolean;
  /** Epoch ms the snapshot was observed (headers) or computed (estimated). */
  observedAt: number | null;
  windows: PacingAssessment[];
  level: PacingLevel;
}

export interface StatusReport {
  budget: Budget;
  dailyUSD: number;
  verdict: VerdictLevel;
  reasons: string[];
  paused: boolean;
  /** Epoch ms the pause auto-expires, or null (indefinite / not paused). */
  pauseUntil: number | null;
  sessions: Array<{ id: string } & SessionRecord>;
  /** Subscription rate-limit pacing — present whenever we have data to show. */
  limits: LimitsReport;
}

/**
 * Compute the subscription rate-limit section. Exported so the Claude Code hook
 * can reuse its already-loaded cfg + ledger instead of paying for a second
 * loadConfig/loadLedger on every tool call.
 */
export function buildLimitsReport(cfg: GuardConfig, ledger: Ledger, now: number): LimitsReport {
  const state = loadLimitsState();
  const thresholds = cfg.limits;
  const plan = cfg.limits.plan;

  // Prefer real header data — but only while it's still usable. A snapshot older
  // than the weekly window is too stale to trust at all; and any single window
  // whose reset time has already passed has since rolled over (its utilization is
  // from a prior window), so we drop it rather than present expired numbers — and
  // a reset time in the past — as if they were live. If nothing usable remains we
  // fall through to the estimate (or "none").
  const snap = state.snapshot;
  if (snap && now - snap.observedAt < WINDOW_MS.weekly) {
    const windows = assessSnapshot(snap, thresholds, now).filter(
      (w) => !(w.resetAt != null && w.resetAt <= now),
    );
    if (windows.length) {
      return {
        source: "headers",
        plan,
        subscriptionDetected: state.subscriptionDetected,
        observedAt: snap.observedAt,
        windows,
        level: worstLevel(windows),
      };
    }
  }

  // Otherwise estimate, but only when the user pinned a tier (opt-in, fuzzy).
  if (plan === "pro" || plan === "max5" || plan === "max20") {
    const snap = estimateSnapshot(ledger, plan as PlanTier, now);
    const windows = assessSnapshot(snap, thresholds, now);
    return {
      source: "estimated",
      plan,
      subscriptionDetected: state.subscriptionDetected,
      observedAt: snap.observedAt,
      windows,
      level: worstLevel(windows),
    };
  }

  return {
    source: "none",
    plan,
    subscriptionDetected: state.subscriptionDetected,
    observedAt: null,
    windows: [],
    level: "ok",
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
 * both the `agent-guard` and `ks guard` status views stay identical. Returns an
 * empty array when there's nothing useful to show.
 */
export function formatLimitsLines(limits: LimitsReport, now: number = Date.now()): string[] {
  if (limits.source === "none") {
    // Only nudge if they haven't opted into either path.
    if (!limits.subscriptionDetected) {
      return [
        "Claude Code plan limits: unknown.",
        "  Run `ks guard proxy` and point Claude Code at it for exact 5-hour + weekly usage,",
        "  or set your tier (`ks guard config --plan max5`) for an estimate.",
      ];
    }
    return [];
  }

  const icon = limits.level === "danger" ? "🟥" : limits.level === "warn" ? "🟡" : "🟢";
  const tag = limits.source === "estimated" ? " (estimated — run the proxy for exact)" : "";
  const lines = [`${icon} Claude Code plan limits${tag}  ·  observed ${limits.observedAt ? ageString(limits.observedAt, now) : "—"}`];

  for (const w of limits.windows) {
    // w.message already leads with "<window> limit NN% used, …", so the bar
    // carries the visual and the message carries the numbers + pacing.
    lines.push(`  ${bar(w.utilization)}  ${w.message}`);
  }
  return lines;
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
