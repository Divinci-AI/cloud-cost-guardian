import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

/**
 * Integration test for the hook's real wired path: stdin (Claude Code hook
 * payload) → transcript parse → cost → ledger → verdict → emitted JSON.
 *
 * Runs the COMPILED dist/cli.js as a subprocess (the way Claude Code invokes
 * it), with an isolated HOME so it never touches the real ledger/config. This
 * is the closest thing to a true e2e for the hook without mocking its internals.
 *
 * Requires `npm run build` first (dist/cli.js). Skips with a clear message if absent.
 */

const here = fileURLToPath(import.meta.url);
const cliJs = join(here, "..", "..", "dist", "cli.js");
const haveBuild = existsSync(cliJs);

let home: string;

beforeAll(() => {
  if (!haveBuild) console.warn(`[hook-integration] dist/cli.js missing — run \`npm run build\`. Skipping.`);
});

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ag-hook-"));
});
afterAll(() => {
  // best-effort cleanup of the last home; per-test homes are tmp and harmless
});

/** Run `cli.js hook` with the given stdin payload + env. Returns {stdout, status}. */
function runHook(payload: object, env: Record<string, string>): { stdout: string; status: number } {
  try {
    const stdout = execFileSync(process.execPath, [cliJs, "hook"], {
      input: JSON.stringify(payload),
      env: { ...process.env, HOME: home, ...env },
      encoding: "utf8",
    });
    return { stdout, status: 0 };
  } catch (e: any) {
    return { stdout: e.stdout?.toString() ?? "", status: e.status ?? 1 };
  }
}

/** Write a transcript with a single assistant turn of the given token usage. */
function writeTranscript(model: string, inputTokens: number, outputTokens: number): string {
  const p = join(home, "transcript.jsonl");
  writeFileSync(p, JSON.stringify({ message: { model, usage: { input_tokens: inputTokens, output_tokens: outputTokens } } }) + "\n");
  return p;
}

/** Seed limits.json in the isolated HOME with a fresh snapshot (as the proxy would). */
function writeLimitsSnapshot(snapshot: object): void {
  const dir = join(home, ".kill-switch", "agent-guard");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "limits.json"), JSON.stringify({ version: 1, subscriptionDetected: true, snapshot, notified: {} }));
}

function usageMetaPath(): string {
  return join(home, ".kill-switch", "agent-guard", "usage-meta.json");
}
function writeUsageMeta(meta: object): void {
  mkdirSync(join(home, ".kill-switch", "agent-guard"), { recursive: true });
  writeFileSync(usageMetaPath(), JSON.stringify(meta));
}
function readUsageMeta(): any {
  try { return JSON.parse(readFileSync(usageMetaPath(), "utf8")); } catch { return {}; }
}

describe.skipIf(!haveBuild)("hook integration (compiled cli.js hook)", () => {
  it("emits nothing and exits 0 when under the soft cap", () => {
    // 100k input on sonnet-4 @ $3/M = $0.30, under the $5 default soft cap.
    const transcript = writeTranscript("claude-sonnet-4", 100_000, 0);
    const { stdout, status } = runHook(
      { session_id: "s-ok", transcript_path: transcript, hook_event_name: "PreToolUse" },
      {},
    );
    expect(status).toBe(0);
    expect(stdout.trim()).toBe("");
  });

  it("denies the next tool call when over the hard cap", () => {
    // 1M input on sonnet-4 = $3.00, over a $1 hard cap.
    const transcript = writeTranscript("claude-sonnet-4", 1_000_000, 0);
    const { stdout, status } = runHook(
      { session_id: "s-block", transcript_path: transcript, hook_event_name: "PreToolUse" },
      { AGENT_GUARD_SESSION_HARD: "1", AGENT_GUARD_SESSION_SOFT: "0.5" },
    );
    expect(status).toBe(0); // hook always exits 0; the decision is in the JSON
    const out = JSON.parse(stdout);
    expect(out.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(out.hookSpecificOutput.permissionDecisionReason).toMatch(/hard cap/i);
  });

  it("fails OPEN (emits nothing) when paused, even over the hard cap", () => {
    const transcript = writeTranscript("claude-sonnet-4", 1_000_000, 0);
    // Pre-create the pause sentinel in the isolated HOME.
    const guardDir = join(home, ".kill-switch", "agent-guard");
    mkdirSync(guardDir, { recursive: true });
    writeFileSync(join(guardDir, "PAUSED"), ""); // indefinite pause

    const { stdout, status } = runHook(
      { session_id: "s-paused", transcript_path: transcript, hook_event_name: "PreToolUse" },
      { AGENT_GUARD_SESSION_HARD: "1" },
    );
    expect(status).toBe(0);
    expect(stdout.trim()).toBe(""); // paused → no deny emitted
  });

  it("fails OPEN on a missing transcript (never bricks the session)", () => {
    const { stdout, status } = runHook(
      { session_id: "s-missing", transcript_path: "/no/such/transcript.jsonl", hook_event_name: "PreToolUse" },
      { AGENT_GUARD_SESSION_HARD: "1" },
    );
    expect(status).toBe(0);
    expect(stdout.trim()).toBe(""); // no usage → $0 → ok → silent
  });

  it("injects a subscription pacing nudge from a persisted snapshot, even when dollars are fine", () => {
    // Dollar spend is trivial (under soft), but the proxy left a danger-level
    // weekly snapshot — the hook should read it and surface it in-session.
    const now = Date.now();
    writeLimitsSnapshot({
      fiveHour: { utilization: 0.4, resetAt: now + 3 * 3600_000 },
      weekly: { utilization: 0.92, resetAt: now + 4 * 86_400_000 }, // ≥ danger
      status: "warning",
      observedAt: now,
    });
    const transcript = writeTranscript("claude-sonnet-4", 50_000, 0); // ~$0.15, well under soft

    const { stdout, status } = runHook(
      { session_id: "s-limit", transcript_path: transcript, hook_event_name: "PreToolUse" },
      {},
    );
    expect(status).toBe(0);
    const out = JSON.parse(stdout);
    expect(out.hookSpecificOutput.additionalContext).toMatch(/plan pacing/i);
    expect(out.hookSpecificOutput.additionalContext).toMatch(/weekly limit 92% used/);
    expect(out.systemMessage).toMatch(/Kill Switch/);
  });

  it("fires a throttled background usage refresh when authorized (claims the stamp)", () => {
    // authorized (a foreground command already opted in) → the hook should claim
    // the refresh slot. NO_KEYCHAIN keeps the detached child inert (no real fetch).
    writeUsageMeta({ authorized: true });
    const transcript = writeTranscript("claude-sonnet-4", 10_000, 0);
    const { status } = runHook(
      { session_id: "s-bg", transcript_path: transcript, hook_event_name: "PreToolUse" },
      { AGENT_GUARD_NO_KEYCHAIN: "1" },
    );
    expect(status).toBe(0);
    expect(typeof readUsageMeta().lastFetchAt).toBe("number"); // the hook claimed the slot
  });

  it("does NOT fire the background refresh until authorized (no surprise Keychain read)", () => {
    writeUsageMeta({}); // not authorized
    const transcript = writeTranscript("claude-sonnet-4", 10_000, 0);
    runHook(
      { session_id: "s-bg2", transcript_path: transcript, hook_event_name: "PreToolUse" },
      { AGENT_GUARD_NO_KEYCHAIN: "1" },
    );
    expect(readUsageMeta().lastFetchAt).toBeUndefined(); // gated off
  });

  it("does NOT nudge on a stale snapshot whose window already reset (F2)", () => {
    const now = Date.now();
    writeLimitsSnapshot({
      fiveHour: null,
      weekly: { utilization: 0.95, resetAt: now - 3600_000 }, // reset already passed → must be dropped
      status: "warning",
      observedAt: now,
    });
    const transcript = writeTranscript("claude-sonnet-4", 50_000, 0);
    const { stdout, status } = runHook(
      { session_id: "s-stale", transcript_path: transcript, hook_event_name: "PreToolUse" },
      {},
    );
    expect(status).toBe(0);
    expect(stdout.trim()).toBe(""); // stale window dropped → nothing to surface
  });
});
