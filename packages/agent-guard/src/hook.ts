/**
 * Claude Code hook entrypoint — `agent-guard hook`.
 *
 * Wired into .claude/settings.json for PreToolUse, UserPromptSubmit, and Stop.
 * On every call it:
 *   1. Reads the hook JSON from stdin (session_id, transcript_path, cwd, event).
 *   2. Recomputes the session's total spend from the transcript (authoritative).
 *   3. Derives rolling-24h spend from the ledger and evaluates the budget.
 *   4. Emits the event-appropriate decision:
 *        - ok    → exit 0 silently
 *        - warn  → allow, surface a systemMessage + additionalContext (once/scope)
 *        - block → deny the tool / block the prompt with a reason
 *   5. Fires alerts on the first warn and first block per scope.
 *
 * Design rule: this runs before every tool call, so it must be fast and must
 * never crash the agent. Any internal error fails OPEN (exit 0, agent proceeds)
 * — a buggy guard must not brick the user's session.
 */

import { loadConfig, mergedPricing, isPaused } from "./config.js";
import { fileURLToPath } from "node:url";
import { MODEL_PRICING } from "./pricing.js";
import { costForUsage } from "./cost.js";
import { parseTranscript } from "./transcript.js";
import {
  loadLedger,
  saveLedger,
  setSessionCost,
  rollingDailyCost,
  prune,
} from "./ledger.js";
import { evaluate, warnKey, type Verdict } from "./budget.js";
import { dispatchAlert, type AlertEvent } from "./alert.js";
import { buildLimitsReport, type LimitsReport } from "./report.js";
import { triggerBackgroundRefresh } from "./claude-usage.js";
import type { GuardConfig } from "./config.js";
import type { Ledger, SessionRecord } from "./ledger.js";

interface HookInput {
  session_id?: string;
  transcript_path?: string;
  cwd?: string;
  hook_event_name?: string;
  [k: string]: unknown;
}

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    let data = "";
    if (process.stdin.isTTY) return resolve("");
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c) => (data += c));
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", () => resolve(data));
  });
}

function emit(obj: unknown): void {
  process.stdout.write(JSON.stringify(obj));
}

/** Build the block decision shaped for the specific hook event. */
function blockDecision(event: string, reason: string, systemMessage: string): unknown {
  if (event === "PreToolUse") {
    return {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: reason,
      },
      systemMessage,
    };
  }
  // UserPromptSubmit (and others that honor decision/block)
  return { decision: "block", reason, systemMessage };
}

function warnDecision(event: string, context: string, systemMessage: string): unknown {
  if (event === "PreToolUse" || event === "UserPromptSubmit") {
    return {
      hookSpecificOutput: { hookEventName: event, additionalContext: context },
      systemMessage,
    };
  }
  return { systemMessage };
}

export async function runHook(): Promise<void> {
  let input: HookInput = {};
  try {
    const raw = await readStdin();
    if (raw.trim()) input = JSON.parse(raw);
  } catch {
    process.exit(0); // fail open
  }

  const event = input.hook_event_name || "PreToolUse";
  const sessionId = input.session_id || "unknown-session";
  const now = Date.now();

  // Escape hatch: if a human has paused enforcement, fail open immediately —
  // before any budget math — so a paused guard can never block a tool call.
  if (isPaused(now)) {
    process.exit(0);
  }

  try {
    const cfg = loadConfig();
    const pricing = mergedPricing(cfg, MODEL_PRICING);

    // 1) Recompute authoritative session spend from the transcript.
    let sessionUSD = 0;
    let inTok = 0;
    let outTok = 0;
    if (input.transcript_path) {
      const { byModel } = parseTranscript(input.transcript_path);
      for (const [model, usage] of byModel) {
        sessionUSD += costForUsage(model, usage, pricing);
        inTok += usage.inputTokens;
        outTok += usage.outputTokens;
      }
    }

    // 2) Persist + derive rolling daily.
    const ledger = loadLedger();
    const rec = setSessionCost(ledger, sessionId, sessionUSD, inTok, outTok, now);
    const dailyUSD = rollingDailyCost(ledger, now);

    // 3) Evaluate.
    const verdict = evaluate({ sessionUSD, dailyUSD }, cfg.budget);

    // 4) Real plan limits + subscription detection. Keep the snapshot fresh in
    // the background (throttled, non-blocking), then read it.
    try {
      const cliPath = fileURLToPath(import.meta.url).replace(/hook\.js$/, "cli.js");
      triggerBackgroundRefresh(cliPath, now);
    } catch {
      /* best-effort */
    }
    const limits = safeLimits(cfg, ledger, now);
    // On a Claude Code subscription, dollars are an API-list-price ESTIMATE —
    // meaningless on a flat-fee plan — so the hook never hard-blocks on them
    // (mirroring the proxy). "Subscription" = real plan-limit data, or a pinned tier.
    const onSubscription = limits?.source === "headers" || isSubscriptionPlan(cfg.limits.plan);

    // First-trip dedup for the dollar notices (once per scope per session).
    let firstDollarBlock = false;
    let firstDollarWarn = false;
    if (verdict.level === "block" && !rec.notified["block"]) {
      rec.notified["block"] = true;
      firstDollarBlock = true;
    } else if (verdict.level === "warn") {
      for (const t of verdict.triggers) {
        const k = warnKey(t.scope);
        if (!rec.notified[k]) {
          rec.notified[k] = true;
          firstDollarWarn = true;
        }
      }
    }
    prune(ledger, now);
    saveLedger(ledger);

    // Alert channels (Slack / Guardian): dollar trips only matter for pay-as-you-go
    // API keys — on a flat-fee subscription they're noise, so skip them.
    if (!onSubscription && (firstDollarBlock || firstDollarWarn)) {
      const action = verdict.level === "block"
        ? event === "PreToolUse" ? "denied next tool call" : "blocked new prompt"
        : "warned, agent allowed to continue";
      await dispatchAlert(cfg, {
        ts: now, source: "hook", sessionId, sessionUSD, dailyUSD,
        reasons: verdict.reasons, action, cwd: input.cwd, level: verdict.level,
      });
    }

    // 5) Output decision. Stop events can't usefully gate spend.
    if (event === "Stop") process.exit(0);

    const limitMsg = limitNudge(rec, ledger, now, limits);

    if (onSubscription) {
      // Flat-fee plan: never hard-block on dollars. If the $-equivalent crosses the
      // hard cap, advise ONCE (it likely shouldn't gate you) and show the real
      // usage so the human can judge — then stay quiet and let the session run.
      if (verdict.level === "block" && !rec.notified["dollar-advisory"]) {
        rec.notified["dollar-advisory"] = true;
        saveLedger(ledger);
        emit(warnDecision(event, renderSubscriptionAdvisory(verdict, limits),
          "⚠️ Kill Switch: dollar-cap estimate reached — but you're on a subscription, so NOT blocking."));
        process.exit(0);
      }
      // The signal that actually matters for you: real rate-limit pacing.
      if (limitMsg) {
        emit(warnDecision(event,
          `Kill Switch — Claude Code plan pacing (informational): ${limitMsg}`,
          `⚠️ Kill Switch: ${limitMsg}`));
        process.exit(0);
      }
      process.exit(0);
    }

    // Pay-as-you-go API key: dollars are real money — enforce the wall.
    if (verdict.level === "block") {
      emit(blockDecision(event, renderBlockReason(verdict, sessionId),
        "🛑 Kill Switch — dollar hard cap reached."));
      process.exit(0);
    }
    if (verdict.level === "warn" && firstDollarWarn) {
      const ctx = limitMsg ? `${renderWarnContext(verdict)}\n\n${limitMsg}` : renderWarnContext(verdict);
      emit(warnDecision(event, ctx, "⚠️ Kill Switch: approaching budget."));
      process.exit(0);
    }
    if (limitMsg) {
      emit(warnDecision(event,
        `Kill Switch — Claude Code plan pacing (informational): ${limitMsg}`,
        `⚠️ Kill Switch: ${limitMsg}`));
      process.exit(0);
    }
    process.exit(0);
  } catch {
    process.exit(0); // fail open on any unexpected error
  }
}

/**
 * Most-urgent subscription-window nudge, fired once per window+level. Mutates the
 * session's notified map (and persists it) so the same warning doesn't repeat on
 * every tool call. Returns null when there's nothing to surface.
 */
function limitNudge(rec: SessionRecord, ledger: Ledger, now: number, limits: LimitsReport | null): string | null {
  try {
    if (!limits || !limits.windows.length) return null;
    const urgent =
      limits.windows.find((w) => w.level === "danger") ?? limits.windows.find((w) => w.level === "warn");
    if (!urgent) return null;
    const key = `limit:${urgent.window}:${urgent.level}`;
    if (rec.notified[key]) return null;
    rec.notified[key] = true;
    saveLedger(ledger);
    return urgent.message;
  } catch {
    return null;
  }
}

/** buildLimitsReport, but never throws (the hook must stay fail-open). */
function safeLimits(cfg: GuardConfig, ledger: Ledger, now: number): LimitsReport | null {
  try {
    return buildLimitsReport(cfg, ledger, now);
  } catch {
    return null;
  }
}

function isSubscriptionPlan(plan: string): boolean {
  return plan === "pro" || plan === "max5" || plan === "max20";
}

function renderBlockReason(v: Verdict, sessionId: string): string {
  return [
    "🛑 Kill Switch — dollar hard cap reached. Tool use is blocked to prevent a runaway bill.",
    "",
    ...v.reasons.map((r) => `  • ${r}`),
    "",
    "Do NOT retry. The escape hatch belongs to the human (the `!` prefix bypasses this hook).",
    "Tell the user to run ONE of these:",
    "  1. Continue 30 min    →  ks guard pause --minutes 30",
    "  2. Raise the caps      →  ks guard config --session-hard 2000 --daily-hard 4000",
    `  3. Reset this session  →  ks guard reset --session ${sessionId}`,
    "",
    "On a Claude Code Pro/Max subscription? These dollar caps are a list-price ESTIMATE and",
    "don't apply to a flat-fee plan — disable them with `ks guard config --session-hard 0 --daily-hard 0`",
    "and run `ks guard usage` to pace your real plan limits instead.",
  ].join("\n");
}

function renderWarnContext(v: Verdict): string {
  return [
    "⚠️ Kill Switch budget notice (informational — you may continue):",
    ...v.reasons.map((r) => `  • ${r}`),
    "Wrapping up or narrowing scope avoids the hard cap, which halts tool use.",
  ].join("\n");
}

/**
 * Shown to a SUBSCRIPTION user when the dollar-equivalent crosses the hard cap.
 * It's almost certainly a false alarm (dollars don't apply to a flat-fee plan),
 * so we don't block — we surface the real plan usage and let the human decide.
 */
function renderSubscriptionAdvisory(v: Verdict, limits: LimitsReport | null): string {
  const lines = [
    "⚠️ Kill Switch — the dollar-equivalent cap was reached, but you're on a Claude Code",
    "subscription, so this is almost certainly a FALSE alarm: dollars are an API-list-price",
    "estimate and don't apply to a flat-fee plan. NOT blocking — your session continues.",
    "",
    ...v.reasons.map((r) => `  • ${r}  (estimate)`),
  ];
  if (limits && limits.source === "headers" && limits.windows.length) {
    lines.push("", "Your REAL plan usage right now (this is the signal that matters):");
    for (const w of limits.windows) {
      const label = w.window === "5h" ? "5-hour" : "weekly";
      lines.push(`  • ${label}: ${Math.round(w.utilization * 100)}% used`);
    }
  }
  lines.push(
    "",
    "If the dollar warnings are noise for you, disable the caps (they're for pay-as-you-go API keys):",
    "  ks guard config --session-hard 0 --daily-hard 0",
  );
  return lines.join("\n");
}
