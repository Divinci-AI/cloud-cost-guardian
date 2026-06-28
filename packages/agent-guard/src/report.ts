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

/** One-line plan-limit summary for a status bar (e.g. Claude Code statusLine). */
export function formatStatusline(limits: LimitsReport, now: number = Date.now()): string {
  if (limits.source === "headers" && limits.windows.length) {
    const dot = limits.level === "danger" ? "🟥" : limits.level === "warn" ? "🟡" : "🟢";
    const five = limits.windows.find((w) => w.window === "5h");
    const weekly = limits.windows.find((w) => w.window === "weekly");
    // Compact pill: "10%5h · 52%w · 13%d · 2.9wd" — percent-before-label, then the
    // derived daily burn and weekly days-left, so the whole pacing picture fits one line.
    const tokens: string[] = [];
    if (five) tokens.push(`${Math.round(five.utilization * 100)}%5h`);
    if (weekly) {
      tokens.push(`${Math.round(weekly.utilization * 100)}%w`);
      if (weekly.resetAt != null) {
        // Daily burn = weekly used ÷ days elapsed this week = your average %/day,
        // to read against the ~14%/day budget (weekly ÷ 7). Skip the first half-day,
        // where too little has elapsed to divide into a meaningful rate.
        const daysElapsed = (WINDOW_MS.weekly - (weekly.resetAt - now)) / DAY_MS;
        if (daysElapsed >= 0.5) tokens.push(`${Math.round((weekly.utilization / daysElapsed) * 100)}%d`);
        const daysLeft = (weekly.resetAt - now) / DAY_MS;
        if (daysLeft > 0) tokens.push(`${daysLeft.toFixed(1)}wd`);
      }
    }
    return `🛡 ${dot} ${tokens.join(" · ")}`;
  }
  const label = limits.tier ? tierLabel(limits.tier) : "limits";
  return `🛡 ${label} · usage pending`;
}

/**
 * Render the FULL `status` view (plain text lines) — shared by `agent-guard
 * status` and `ks guard status` so they never drift. It leads with the signal
 * that matters: real plan limits first, then the dollar budget. Disabled caps
 * (hard = 0) render as "off" — never "$0.00 / NN%" — and on a subscription the
 * dollar section is collapsed to advisory, since dollars don't apply there.
 */
export function formatStatusReport(r: StatusReport, now: number = Date.now()): string[] {
  const out: string[] = [];
  const onSub = r.limits.source === "headers";
  const dollarsOff = r.budget.dailyHardUSD === 0 && r.budget.sessionHardUSD === 0;

  const icon = r.paused ? "⏸" : onSub ? "🛡" : r.verdict === "block" ? "🛑" : r.verdict === "warn" ? "⚠️" : "🛡";
  out.push(`${icon}  Agent Guard${r.paused ? " — PAUSED (enforcement off)" : ""}`);
  if (r.paused) {
    out.push(`   ${r.pauseUntil ? "resumes " + new Date(r.pauseUntil).toLocaleString() : "paused indefinitely — `ks guard resume` to re-arm"}`);
  }
  out.push("");

  // 1) Plan limits — the signal that matters. (Self-describing: real %, or a nudge.)
  for (const line of formatLimitsLines(r.limits, now)) out.push(line);
  out.push("");

  // 2) Dollar budget.
  if (dollarsOff) {
    out.push(onSub
      ? "💲 Dollar caps: off — flat-fee plan, dollars aren't enforced."
      : "💲 Dollar caps: off — `ks guard config --daily-hard 150` to enable.");
  } else {
    const dpct = r.budget.dailyHardUSD > 0 ? Math.min(1, r.dailyUSD / r.budget.dailyHardUSD) : 0;
    const cap = r.budget.dailyHardUSD > 0 ? fmtUSD(r.budget.dailyHardUSD) : "off";
    const note = onSub ? "   (advisory — flat-fee plan)" : "";
    out.push(`💲 Daily (24h): ${fmtUSD(r.dailyUSD)} / ${cap}  ${bar(dpct)}${note}`);
    for (const s of r.sessions.slice(0, 5)) {
      if (r.budget.sessionHardUSD > 0) {
        const sp = Math.min(1, s.costUSD / r.budget.sessionHardUSD);
        out.push(`   ${fmtUSD(s.costUSD).padStart(9)} / ${fmtUSD(r.budget.sessionHardUSD)}  ${bar(sp)}  ${s.id.slice(0, 8)}`);
      } else {
        out.push(`   ${fmtUSD(s.costUSD).padStart(9)}  ${s.id.slice(0, 8)}`);
      }
    }
  }

  // 3) Reasons — dollar reasons are noise on a flat-fee plan, so skip them there.
  if (!onSub && r.reasons.length) {
    out.push("");
    for (const reason of r.reasons) out.push(`  • ${reason}`);
  }
  return out;
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
