/**
 * Pacing engine — the "intelligent" half the user asked for.
 *
 * Blocking at "90% of weekly" is dumb: 90% on day 6 is fine, but 60% on day 2
 * means you'll be locked out mid-week. The resource you're spending is a budget
 * that should last until the window resets, so the real question isn't "how much
 * is left" — it's "at this burn rate, will I run out before the window resets?".
 *
 * For each window we compute:
 *   - expected utilization = fraction of the window already elapsed
 *   - burn ratio           = actual / expected   (1.0 = perfectly on pace)
 *   - projected exhaustion  = when utilization hits 1.0 at the current rate
 *   - will-lock-out-before-reset = exhaustion lands before the reset
 *
 * The level (ok / warn / danger) is the worse of two signals: absolute
 * utilization against soft/danger thresholds, and pacing (burning fast enough to
 * lock out before reset). Crucially, the *soft* warn is pace-gated once we know
 * where we are in the window: 60% of the weekly quota with 2 days left is under
 * the prorated daily budget (weekly ÷ 7 ≈ 14%/day) and must NOT warn — only being
 * at/ahead of the linear pace (or projecting a lockout) escalates. The *danger*
 * threshold is pace-gated the same way: 89% of the weekly cap with 8 hours left is
 * under the daily budget and won't lock out, so it shouldn't scream red. That's
 * safe because high utilization while under pace only happens near reset (under
 * pace ⇒ lots of the window elapsed) — a real lockout still escalates via the
 * projection regardless of pace. In subscription mode the guard never blocks — it surfaces the
 * assessment as a warning so the human can ease off or switch to a cheaper model
 * before Anthropic's own limit stops them mid-task.
 */

import { WINDOW_MS, type LimitSnapshot, type LimitWindow, type WindowState } from "./limits.js";

const DAY_MS = 24 * 60 * 60 * 1000;

export interface PacingThresholds {
  /** Per-window soft / danger utilization thresholds (0–1). */
  fiveHourSoftPct: number;
  fiveHourDangerPct: number;
  weeklySoftPct: number;
  weeklyDangerPct: number;
  /** Burn ratio above which pacing alone escalates (with meaningful utilization). */
  burnRatioWarn: number;
}

export type PacingLevel = "ok" | "warn" | "danger";

export interface PacingAssessment {
  window: LimitWindow;
  /** 0–1 fraction of the window consumed. */
  utilization: number;
  /** Epoch ms the window resets, or null if unknown. */
  resetAt: number | null;
  /** actual / expected utilization; null when elapsed is unknown (no reset time). */
  burnRatio: number | null;
  /** Epoch ms we project utilization hits 100% at the current rate, or null. */
  projectedExhaustionAt: number | null;
  /** True when projected exhaustion lands before the window resets. */
  willLockOutBeforeReset: boolean;
  level: PacingLevel;
  /** One-line human summary. */
  message: string;
}

function windowLabel(w: LimitWindow): string {
  return w === "5h" ? "5-hour" : "weekly";
}

function fmtClock(epochMs: number, now: number): string {
  const dt = new Date(epochMs);
  const sameDay = new Date(now).toDateString() === dt.toDateString();
  // Day-of-week + time reads naturally for a multi-day weekly window.
  return sameDay
    ? dt.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
    : dt.toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" });
}

function fmtDuration(ms: number): string {
  if (ms <= 0) return "now";
  const h = ms / (60 * 60 * 1000);
  if (h < 1) return `${Math.round(ms / 60000)}m`;
  if (h < 24) return `${h.toFixed(h < 10 ? 1 : 0)}h`;
  return `${(h / 24).toFixed(1)}d`;
}

/** Assess a single window's pacing. `now` is epoch ms. */
export function assessWindow(
  window: LimitWindow,
  state: WindowState,
  thresholds: PacingThresholds,
  now: number,
): PacingAssessment {
  const util = Math.max(0, Math.min(1, state.utilization));
  const soft = window === "5h" ? thresholds.fiveHourSoftPct : thresholds.weeklySoftPct;
  const danger = window === "5h" ? thresholds.fiveHourDangerPct : thresholds.weeklyDangerPct;

  const duration = WINDOW_MS[window];
  // elapsed = duration - timeUntilReset; only known when we have a reset time.
  let elapsed: number | null = null;
  if (state.resetAt != null) {
    const untilReset = state.resetAt - now;
    elapsed = Math.max(0, Math.min(duration, duration - untilReset));
  }

  let burnRatio: number | null = null;
  let projectedExhaustionAt: number | null = null;
  let willLockOut = false;

  if (elapsed != null && elapsed > 0) {
    const expected = elapsed / duration;
    burnRatio = expected > 0 ? util / expected : null;

    if (util > 0 && util < 1) {
      const ratePerMs = util / elapsed; // utilization per ms so far
      const msToFull = (1 - util) / ratePerMs;
      projectedExhaustionAt = now + msToFull;
      if (state.resetAt != null) willLockOut = projectedExhaustionAt < state.resetAt;
    } else if (util >= 1) {
      projectedExhaustionAt = now;
      willLockOut = true;
    }
  }

  // Level: worse of absolute-utilization and pacing signals. A projected lockout
  // only escalates once you've used a meaningful slice of the window — otherwise
  // tiny noise near a linear burn (e.g. 15% used, exhaustion landing a few hours
  // before a reset days away) would scream danger far too early. We gate it at
  // half the soft threshold.
  const lockoutFloor = soft * 0.5;
  const lockoutMatters = willLockOut && util >= lockoutFloor;

  // Absolute thresholds alone are a poor signal once we know where we are in the
  // window — the real question is "at this burn rate, will I run out before reset?"
  // 60% of the weekly quota with 2 days left, or even 89% with 8 hours left, is
  // *under* the prorated daily budget (weekly ÷ 7 ≈ 14%/day): you underspent and
  // have runway, so neither should alarm. So when pacing IS known, gate BOTH the
  // soft and danger utilization thresholds on being at/ahead of the expected
  // (linear) pace. This is safe even for danger: high utilization while UNDER pace
  // can only happen late in the window (under pace ⇒ util < elapsed/duration ⇒ lots
  // elapsed ⇒ near reset), exactly where a lockout can't land. A genuine lockout
  // risk still escalates via the willLockOut path below regardless of pace. When
  // pacing is unknown (no reset time), fall back to the absolute thresholds.
  const onOrAheadOfPace = burnRatio == null || burnRatio >= 1;
  let level: PacingLevel = "ok";
  if ((util >= danger && onOrAheadOfPace) || (lockoutMatters && util >= soft)) level = "danger";
  else if (
    (util >= soft && onOrAheadOfPace) ||
    lockoutMatters ||
    (burnRatio != null && burnRatio >= thresholds.burnRatioWarn && util >= lockoutFloor)
  )
    level = "warn";

  const pct = Math.round(util * 100);
  const label = windowLabel(window);
  const parts: string[] = [`${label} limit ${pct}% used`];
  if (state.resetAt != null) parts.push(`resets ${fmtClock(state.resetAt, now)}`);
  // Daily-budget framing for the weekly window: spell out the runway the way a
  // human reasons about it — "X% left over N days" vs the even ~14%/day budget —
  // so Claude Code gets the day-of-week context and doesn't worry too early. Only
  // shown with ≥1 day to go: inside the final day a "%/day" rate exceeds what's
  // even left and reads as nonsense, and the "resets <clock>" part already says when.
  if (window === "weekly" && state.resetAt != null && util < 1) {
    const daysLeft = (state.resetAt - now) / DAY_MS;
    if (daysLeft >= 1) {
      const remainingPct = Math.round((1 - util) * 100);
      const perDayPct = Math.round(((1 - util) / daysLeft) * 100);
      const evenDailyPct = Math.round((DAY_MS / duration) * 100); // weekly ÷ 7 ≈ 14%/day
      parts.push(`~${remainingPct}% left over ${daysLeft.toFixed(1)}d (~${perDayPct}%/day vs ~${evenDailyPct}%/day budget)`);
    }
  }
  if (burnRatio != null && burnRatio >= 1.2 && level !== "ok") parts.push(`burning ${burnRatio.toFixed(1)}× pace`);
  // Only surface the lockout projection once it actually drives the level —
  // keeps low-utilization projection noise out of the message.
  if (lockoutMatters && projectedExhaustionAt != null && state.resetAt != null) {
    const before = state.resetAt - projectedExhaustionAt;
    parts.push(`→ lockout in ~${fmtDuration(projectedExhaustionAt - now)} (${fmtDuration(before)} before reset)`);
  }

  return {
    window,
    utilization: util,
    resetAt: state.resetAt,
    burnRatio,
    projectedExhaustionAt,
    willLockOutBeforeReset: willLockOut,
    level,
    message: parts.join(", "),
  };
}

/** Assess every window present in a snapshot. */
export function assessSnapshot(
  snap: LimitSnapshot,
  thresholds: PacingThresholds,
  now: number,
): PacingAssessment[] {
  const out: PacingAssessment[] = [];
  if (snap.fiveHour) out.push(assessWindow("5h", snap.fiveHour, thresholds, now));
  if (snap.weekly) out.push(assessWindow("weekly", snap.weekly, thresholds, now));
  return out;
}

/** Worst level across a set of assessments. */
export function worstLevel(assessments: PacingAssessment[]): PacingLevel {
  if (assessments.some((a) => a.level === "danger")) return "danger";
  if (assessments.some((a) => a.level === "warn")) return "warn";
  return "ok";
}
