/**
 * Configuration & paths for agent-guard.
 *
 * Resolution order (later wins): built-in defaults → config file
 * (~/.kill-switch/agent-guard/config.json) → environment variables.
 * Env override lets you set a tighter budget for a single risky run without
 * editing files, e.g. `AGENT_GUARD_SESSION_HARD=10 claude`.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import type { Budget } from "./budget.js";
import type { ModelPricing } from "./pricing.js";

export interface GuardConfig {
  budget: Budget;
  /** Optional pricing overrides merged onto the built-in table. */
  pricingOverrides?: Record<string, ModelPricing>;
  /** Kill Switch API key (ks_live_…) for reporting kill events to Guardian. */
  apiKey?: string;
  /** Guardian API base URL. */
  apiUrl?: string;
  /** Slack incoming-webhook URL for breach alerts. */
  slackWebhook?: string;
}

export const DEFAULT_BUDGET: Budget = {
  sessionSoftUSD: 5,
  sessionHardUSD: 20,
  dailySoftUSD: 25,
  dailyHardUSD: 100,
};

/** ~/.kill-switch/agent-guard — created on demand. */
export function guardDir(): string {
  return join(homedir(), ".kill-switch", "agent-guard");
}

export function ensureGuardDir(): string {
  const dir = guardDir();
  mkdirSync(dir, { recursive: true });
  return dir;
}

export const ledgerPath = () => join(guardDir(), "ledger.json");
export const configPath = () => join(guardDir(), "config.json");
export const pricingPath = () => join(guardDir(), "pricing.json");
export const eventsPath = () => join(guardDir(), "events.jsonl");

/**
 * Escape hatch. The hook/proxy fail OPEN while this sentinel exists, so a human
 * can always disable enforcement from outside the agent loop — even with zero
 * tooling: `touch ~/.kill-switch/agent-guard/PAUSED`.
 *
 * An empty file pauses indefinitely; a file containing an epoch-ms number pauses
 * until that time, then enforcement resumes on its own.
 */
export const pausePath = () => join(guardDir(), "PAUSED");

/** True if enforcement is currently paused (sentinel present and not expired). */
export function isPaused(now: number): boolean {
  try {
    const raw = readFileSync(pausePath(), "utf8").trim();
    if (!raw) return true; // indefinite
    const until = Number(raw);
    return Number.isFinite(until) ? now < until : true;
  } catch {
    return false;
  }
}

/** Read the pause expiry (epoch ms), or null if indefinite/not paused. */
export function pauseExpiry(): number | null {
  try {
    const raw = readFileSync(pausePath(), "utf8").trim();
    const until = Number(raw);
    return raw && Number.isFinite(until) ? until : null;
  } catch {
    return null;
  }
}

export function writePause(untilMs?: number): void {
  ensureGuardDir();
  writeFileSync(pausePath(), untilMs && Number.isFinite(untilMs) ? String(untilMs) : "");
}

export function clearPause(): void {
  try {
    rmSync(pausePath());
  } catch {
    /* not paused */
  }
}

function readJson<T>(path: string): T | undefined {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return undefined;
  }
}

function num(envVal: string | undefined, fallback: number): number {
  const n = Number(envVal);
  return envVal !== undefined && Number.isFinite(n) ? n : fallback;
}

export function loadConfig(): GuardConfig {
  const fileCfg = readJson<Partial<GuardConfig>>(configPath()) ?? {};
  const filePricing = readJson<Record<string, ModelPricing>>(pricingPath());

  const fileBudget: Partial<Budget> = fileCfg.budget ?? {};
  const budget: Budget = {
    sessionSoftUSD: num(process.env.AGENT_GUARD_SESSION_SOFT, fileBudget.sessionSoftUSD ?? DEFAULT_BUDGET.sessionSoftUSD),
    sessionHardUSD: num(process.env.AGENT_GUARD_SESSION_HARD, fileBudget.sessionHardUSD ?? DEFAULT_BUDGET.sessionHardUSD),
    dailySoftUSD: num(process.env.AGENT_GUARD_DAILY_SOFT, fileBudget.dailySoftUSD ?? DEFAULT_BUDGET.dailySoftUSD),
    dailyHardUSD: num(process.env.AGENT_GUARD_DAILY_HARD, fileBudget.dailyHardUSD ?? DEFAULT_BUDGET.dailyHardUSD),
  };

  return {
    budget,
    pricingOverrides: { ...(fileCfg.pricingOverrides ?? {}), ...(filePricing ?? {}) },
    apiKey: process.env.KILL_SWITCH_API_KEY ?? fileCfg.apiKey,
    apiUrl: process.env.KILL_SWITCH_API_URL ?? fileCfg.apiUrl ?? "https://api.kill-switch.net",
    slackWebhook: process.env.KILL_SWITCH_SLACK_WEBHOOK ?? fileCfg.slackWebhook,
  };
}

/** Merge built-in pricing with any overrides from config. */
export function mergedPricing(cfg: GuardConfig, base: Record<string, ModelPricing>): Record<string, ModelPricing> {
  if (!cfg.pricingOverrides || Object.keys(cfg.pricingOverrides).length === 0) return base;
  return { ...base, ...cfg.pricingOverrides };
}
