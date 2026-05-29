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

    // 4) Alert (deduped per scope) + decide what to output.
    const action = verdict.level === "block"
      ? event === "PreToolUse" ? "denied next tool call" : "blocked new prompt"
      : verdict.level === "warn" ? "warned, agent allowed to continue" : "none";

    const baseEvt: Omit<AlertEvent, "level"> = {
      ts: now,
      source: "hook",
      sessionId,
      sessionUSD,
      dailyUSD,
      reasons: verdict.reasons,
      action,
      cwd: input.cwd,
    };

    let shouldAlert = false;
    if (verdict.level === "block") {
      if (!rec.notified["block"]) {
        rec.notified["block"] = true;
        shouldAlert = true;
      }
    } else if (verdict.level === "warn") {
      for (const t of verdict.triggers) {
        const k = warnKey(t.scope);
        if (!rec.notified[k]) {
          rec.notified[k] = true;
          shouldAlert = true;
        }
      }
    }

    prune(ledger, now);
    saveLedger(ledger);

    if (shouldAlert) {
      await dispatchAlert(cfg, { ...baseEvt, level: verdict.level });
    }

    // 5) Output decision.
    if (verdict.level === "block") {
      const reason = renderBlockReason(verdict, sessionId);
      // Stop events can't usefully block spend; allow them through (alert already fired).
      if (event === "Stop") {
        process.exit(0);
      }
      emit(blockDecision(event, reason, `🛑 Kill Switch stopped this agent — ${verdict.reasons[0] ?? "budget exceeded"}.`));
      process.exit(0);
    }

    // Surface the warn nudge only on the first trip per scope (shouldAlert), not
    // on every subsequent tool call — otherwise the agent's context fills with
    // duplicate notices. After that, warnings stay silent until the hard cap.
    if (verdict.level === "warn" && shouldAlert) {
      const ctx = renderWarnContext(verdict);
      emit(warnDecision(event, ctx, `⚠️ Kill Switch: ${verdict.reasons[0] ?? "approaching budget"}.`));
      process.exit(0);
    }

    process.exit(0);
  } catch {
    process.exit(0); // fail open on any unexpected error
  }
}

/** Absolute path to this CLI, so recovery commands work without PATH / npm-link. */
function selfCmd(): string {
  try {
    return `"${process.execPath}" "${fileURLToPath(import.meta.url).replace(/hook\.js$/, "cli.js")}"`;
  } catch {
    return "agent-guard";
  }
}

function renderBlockReason(v: Verdict, sessionId: string): string {
  const cmd = selfCmd();
  return [
    "Kill Switch hard cap reached — further tool use is blocked to prevent a runaway bill.",
    ...v.reasons,
    "Do not retry. The escape hatch belongs to the HUMAN, not you — tell the user to run ONE of these in their own shell (the `!` prefix in Claude Code bypasses this hook):",
    `(1) PAUSE for 30 min:  ${cmd} pause --minutes 30`,
    `(2) RAISE the caps:    ${cmd} config --session-hard 2000 --daily-hard 4000`,
    `(3) RESET this session's spend:  ${cmd} reset --session ${sessionId}`,
    "Or, with zero tooling: `touch ~/.kill-switch/agent-guard/PAUSED` (and `rm` it to re-arm).",
  ].join(" ");
}

function renderWarnContext(v: Verdict): string {
  return [
    "Kill Switch budget notice (informational, you may continue):",
    ...v.reasons,
    "Consider wrapping up or narrowing scope to avoid hitting the hard cap, which will halt tool use.",
  ].join(" ");
}
