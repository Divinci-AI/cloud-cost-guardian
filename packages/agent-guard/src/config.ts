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

/**
 * Subscription rate-limit config. Separate from the dollar {@link Budget}
 * because a Claude Code Pro/Max session pays a flat fee — the scarce resource is
 * the plan's 5-hour and weekly quota, not dollars. This is alert-only: the guard
 * never blocks on these (you already paid), it just warns before you lock out.
 */
export interface LimitsConfig {
  /**
   * Plan tier. "auto" = derive everything from observed `unified-*` headers
   * (proxy path); a pinned tier additionally enables hook-only estimation when
   * no fresh header snapshot exists. See estimate.ts.
   */
  plan: "auto" | "pro" | "max5" | "max20";
  /** Per-window soft (warn) / danger thresholds, as 0–1 utilization fractions. */
  fiveHourSoftPct: number;
  fiveHourDangerPct: number;
  weeklySoftPct: number;
  weeklyDangerPct: number;
  /** Burn ratio (actual/expected pace) above which we escalate on pacing alone. */
  burnRatioWarn: number;
}

export interface GuardConfig {
  budget: Budget;
  limits: LimitsConfig;
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

export const DEFAULT_LIMITS: LimitsConfig = {
  plan: "auto",
  fiveHourSoftPct: 0.7,
  fiveHourDangerPct: 0.9,
  weeklySoftPct: 0.6,
  weeklyDangerPct: 0.85,
  burnRatioWarn: 1.5,
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
/** Subscription rate-limit state (latest unified-header snapshot + dedup). */
export const limitsPath = () => join(guardDir(), "limits.json");

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

  const fileLimits: Partial<LimitsConfig> = fileCfg.limits ?? {};
  const envPlan = process.env.AGENT_GUARD_PLAN as LimitsConfig["plan"] | undefined;
  const validPlan = (p: string | undefined): p is LimitsConfig["plan"] =>
    p === "auto" || p === "pro" || p === "max5" || p === "max20";
  const limits: LimitsConfig = {
    plan: validPlan(envPlan) ? envPlan : validPlan(fileLimits.plan) ? fileLimits.plan : DEFAULT_LIMITS.plan,
    fiveHourSoftPct: fileLimits.fiveHourSoftPct ?? DEFAULT_LIMITS.fiveHourSoftPct,
    fiveHourDangerPct: fileLimits.fiveHourDangerPct ?? DEFAULT_LIMITS.fiveHourDangerPct,
    weeklySoftPct: fileLimits.weeklySoftPct ?? DEFAULT_LIMITS.weeklySoftPct,
    weeklyDangerPct: fileLimits.weeklyDangerPct ?? DEFAULT_LIMITS.weeklyDangerPct,
    burnRatioWarn: fileLimits.burnRatioWarn ?? DEFAULT_LIMITS.burnRatioWarn,
  };

  return {
    budget,
    limits,
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
