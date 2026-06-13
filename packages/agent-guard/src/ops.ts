/**
 * Operations shared by the standalone `agent-guard` CLI and the `ks guard`
 * subcommands, so both drive the same logic instead of duplicating it (or
 * shelling out). Pure side-effecting helpers over config + Claude Code settings.
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { configPath, ensureGuardDir, DEFAULT_BUDGET, DEFAULT_LIMITS, type GuardConfig, type LimitsConfig } from "./config.js";
import type { Budget } from "./budget.js";
import { loadLedger, saveLedger, emptyLedger } from "./ledger.js";

export interface InstallOptions {
  /** Install into ~/.claude/settings.json instead of ./.claude/settings.json */
  global?: boolean;
  /** Override the hook command (default: absolute path to this binary). */
  command?: string;
  /** Working dir for the project-local install (default: process.cwd()). */
  cwd?: string;
}

export interface InstallResult {
  settingsPath: string;
  command: string;
  added: string[];
}

/**
 * Wire the agent-guard hook into Claude Code settings for PreToolUse,
 * UserPromptSubmit, and Stop. Idempotent: re-running adds nothing if the hook
 * command is already present.
 */
export function installHook(cliPath: string, execPath: string, opts: InstallOptions = {}): InstallResult {
  const settingsPath = opts.global
    ? join(homedir(), ".claude", "settings.json")
    : join(opts.cwd ?? process.cwd(), ".claude", "settings.json");

  const command = opts.command || `"${execPath}" "${cliPath}" hook`;

  let settings: any = {};
  try {
    settings = JSON.parse(readFileSync(settingsPath, "utf8"));
  } catch {
    /* new file */
  }
  settings.hooks ??= {};

  const ensure = (event: string, withMatcher: boolean): boolean => {
    settings.hooks[event] ??= [];
    const blob = JSON.stringify(settings.hooks[event]);
    if (blob.includes("agent-guard") || blob.includes("cli.js") || blob.includes(command)) return false;
    const entry: any = { hooks: [{ type: "command", command }] };
    if (withMatcher) entry.matcher = "*";
    settings.hooks[event].push(entry);
    return true;
  };

  const added: string[] = [];
  if (ensure("PreToolUse", true)) added.push("PreToolUse");
  if (ensure("UserPromptSubmit", false)) added.push("UserPromptSubmit");
  if (ensure("Stop", false)) added.push("Stop");

  mkdirSync(dirname(settingsPath), { recursive: true });
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n");

  return { settingsPath, command, added };
}

/** Partial budget update (USD). Merges onto the existing config file. */
export interface BudgetPatch {
  sessionSoftUSD?: number;
  sessionHardUSD?: number;
  dailySoftUSD?: number;
  dailyHardUSD?: number;
  slackWebhook?: string;
}

/** Write budget/webhook overrides to the config file. Returns the saved budget. */
export function setBudget(patch: BudgetPatch): Budget {
  let file: Partial<GuardConfig> = {};
  try {
    file = JSON.parse(readFileSync(configPath(), "utf8"));
  } catch {
    /* new */
  }
  const budget: Budget = { ...DEFAULT_BUDGET, ...(file.budget ?? {}) };
  const set = (k: keyof Budget, v: number | undefined) => {
    if (v !== undefined && Number.isFinite(v)) budget[k] = v;
  };
  set("sessionSoftUSD", patch.sessionSoftUSD);
  set("sessionHardUSD", patch.sessionHardUSD);
  set("dailySoftUSD", patch.dailySoftUSD);
  set("dailyHardUSD", patch.dailyHardUSD);
  file.budget = budget;
  if (patch.slackWebhook) file.slackWebhook = patch.slackWebhook;

  ensureGuardDir();
  writeFileSync(configPath(), JSON.stringify(file, null, 2) + "\n");
  return budget;
}

/** Partial subscription-limits update. Merges onto the existing config file. */
export interface LimitsPatch {
  plan?: LimitsConfig["plan"];
  fiveHourSoftPct?: number;
  fiveHourDangerPct?: number;
  weeklySoftPct?: number;
  weeklyDangerPct?: number;
  burnRatioWarn?: number;
}

/** Write subscription-limit overrides to the config file. Returns the saved limits. */
export function setLimits(patch: LimitsPatch): LimitsConfig {
  let file: Partial<GuardConfig> = {};
  try {
    file = JSON.parse(readFileSync(configPath(), "utf8"));
  } catch {
    /* new */
  }
  const limits: LimitsConfig = { ...DEFAULT_LIMITS, ...(file.limits ?? {}) };
  if (patch.plan && ["auto", "pro", "max5", "max20"].includes(patch.plan)) limits.plan = patch.plan;
  const setPct = (k: keyof LimitsConfig, v: number | undefined) => {
    if (v !== undefined && Number.isFinite(v)) (limits[k] as number) = v;
  };
  setPct("fiveHourSoftPct", patch.fiveHourSoftPct);
  setPct("fiveHourDangerPct", patch.fiveHourDangerPct);
  setPct("weeklySoftPct", patch.weeklySoftPct);
  setPct("weeklyDangerPct", patch.weeklyDangerPct);
  setPct("burnRatioWarn", patch.burnRatioWarn);
  file.limits = limits;

  ensureGuardDir();
  writeFileSync(configPath(), JSON.stringify(file, null, 2) + "\n");
  return limits;
}

/** Clear the spend ledger. Scope: all | a single session | today's sessions. */
export function resetLedger(opts: { all?: boolean; session?: string; today?: boolean }): string {
  if (opts.all) {
    saveLedger(emptyLedger());
    return "Ledger wiped.";
  }
  const ledger = loadLedger();
  if (opts.session) {
    delete ledger.sessions[opts.session];
    saveLedger(ledger);
    return `Cleared session ${opts.session}.`;
  }
  if (opts.today) {
    const today = new Date().toISOString().slice(0, 10);
    for (const [id, s] of Object.entries(ledger.sessions)) {
      if (new Date(s.lastAt).toISOString().slice(0, 10) === today) delete ledger.sessions[id];
    }
    saveLedger(ledger);
    return "Cleared today's sessions.";
  }
  return "Specify all, session <id>, or today.";
}
