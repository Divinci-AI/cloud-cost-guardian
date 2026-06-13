/**
 * Breach alerting — best-effort, fire-and-forget, never throws.
 *
 * On a soft/hard trip we:
 *   1. Always append a line to ~/.kill-switch/agent-guard/events.jsonl (local audit trail).
 *   2. POST to Slack if a webhook is configured.
 *   3. POST to the Guardian API if an API key is configured, so the kill shows
 *      up in the dashboard / existing alert channels alongside cloud-account kills.
 *
 * Everything network is wrapped in a short timeout; a down endpoint must not
 * delay (or crash) the agent's tool call.
 */

import { appendFileSync } from "node:fs";
import { eventsPath, ensureGuardDir, type GuardConfig } from "./config.js";
import { fmtUSD } from "./cost.js";
import { isSafeEndpoint, warnIfUnexpectedHost } from "./net.js";

/** Spend verdicts are ok/warn/block; pacing assessments are ok/warn/danger. */
export type AlertLevel = "ok" | "warn" | "block" | "danger";

export interface AlertEvent {
  ts: number;
  source: "hook" | "proxy";
  /** "spend" = dollar budget trip (default); "limit" = subscription pacing alert. */
  kind?: "spend" | "limit";
  sessionId: string;
  level: AlertLevel;
  sessionUSD: number;
  dailyUSD: number;
  reasons: string[];
  action: string;
  cwd?: string;
  /** For kind:"limit" — per-window utilization summary (0–1) for the payload. */
  limits?: Array<{ window: string; utilization: number; resetAt: number | null; level: string }>;
}

const TIMEOUT_MS = 2500;

async function postJson(url: string, body: unknown, headers: Record<string, string> = {}): Promise<void> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
  } catch {
    /* best-effort */
  } finally {
    clearTimeout(t);
  }
}

function writeLocal(evt: AlertEvent): void {
  try {
    ensureGuardDir();
    appendFileSync(eventsPath(), JSON.stringify(evt) + "\n");
  } catch {
    /* best-effort */
  }
}

function slackText(evt: AlertEvent): string {
  if (evt.kind === "limit") {
    const icon = evt.level === "danger" ? "🟥" : "🟡";
    return [
      `${icon} *Kill Switch — Claude Code subscription pacing*`,
      `• Status: ${evt.action}`,
      evt.cwd ? `• Project: \`${evt.cwd}\`` : "",
      ...evt.reasons.map((r) => `• ${r}`),
    ]
      .filter(Boolean)
      .join("\n");
  }
  const icon = evt.level === "block" ? "🛑" : "⚠️";
  const verb = evt.level === "block" ? "BLOCKED a coding agent" : "warning on a coding agent";
  return [
    `${icon} *Kill Switch ${verb}*`,
    `• Session: ${fmtUSD(evt.sessionUSD)}  |  Daily (24h): ${fmtUSD(evt.dailyUSD)}`,
    `• Action: ${evt.action}`,
    evt.cwd ? `• Project: \`${evt.cwd}\`` : "",
    ...evt.reasons.map((r) => `• ${r}`),
  ]
    .filter(Boolean)
    .join("\n");
}

/** Dispatch an alert across all configured channels. Resolves once all attempts settle. */
export async function dispatchAlert(cfg: GuardConfig, evt: AlertEvent): Promise<void> {
  writeLocal(evt);

  const tasks: Array<Promise<void>> = [];

  if (cfg.slackWebhook) {
    tasks.push(postJson(cfg.slackWebhook, { text: slackText(evt) }));
  }

  // Only POST the ks_live key to a safe endpoint; warn on an unexpected host.
  if (cfg.apiKey && cfg.apiUrl && isSafeEndpoint(cfg.apiUrl)) {
    warnIfUnexpectedHost(cfg.apiUrl, "api.kill-switch.net", "apiUrl");
    tasks.push(
      postJson(
        `${cfg.apiUrl.replace(/\/$/, "")}/agent-guard/events`,
        evt,
        { authorization: `Bearer ${cfg.apiKey}` },
      ),
    );
  }

  await Promise.allSettled(tasks);
}
