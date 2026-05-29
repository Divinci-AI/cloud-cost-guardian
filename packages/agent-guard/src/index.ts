/**
 * @kill-switch/agent-guard — Kill Switch for coding agents.
 *
 * Stop runaway Claude Code / Cursor / Aider sessions from racking up an LLM
 * bill, via a native Claude Code hook and a token-metering proxy that share one
 * per-session + daily-rolling budget.
 *
 * Programmatic surface (the CLI in cli.ts is the primary entrypoint):
 */

export { MODEL_PRICING, FALLBACK_PRICING, pricingFor, normalizeModel, type ModelPricing } from "./pricing.js";
export { costForUsage, totalTokens, fmtUSD, type TokenUsage } from "./cost.js";
export { evaluate, warnKey, type Budget, type Verdict, type Spend, type VerdictLevel } from "./budget.js";
export {
  loadLedger,
  saveLedger,
  setSessionCost,
  addSessionCost,
  rollingDailyCost,
  prune,
  emptyLedger,
  type Ledger,
  type SessionRecord,
} from "./ledger.js";
export { parseTranscript, type TranscriptTotals } from "./transcript.js";
export {
  loadConfig,
  DEFAULT_BUDGET,
  guardDir,
  ensureGuardDir,
  configPath,
  pausePath,
  isPaused,
  pauseExpiry,
  writePause,
  clearPause,
  type GuardConfig,
} from "./config.js";
export { dispatchAlert, type AlertEvent } from "./alert.js";
export { startProxy, resolveUpstream, type ProxyOptions } from "./proxy.js";
export { runHook } from "./hook.js";
export { buildStatusReport, type StatusReport } from "./report.js";
export {
  installHook,
  setBudget,
  resetLedger,
  type InstallOptions,
  type InstallResult,
  type BudgetPatch,
} from "./ops.js";
