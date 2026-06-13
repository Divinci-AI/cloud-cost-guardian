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
  DEFAULT_LIMITS,
  guardDir,
  ensureGuardDir,
  configPath,
  limitsPath,
  pausePath,
  isPaused,
  pauseExpiry,
  writePause,
  clearPause,
  type GuardConfig,
  type LimitsConfig,
} from "./config.js";
export { dispatchAlert, type AlertEvent, type AlertLevel } from "./alert.js";
export { startProxy, resolveUpstream, type ProxyOptions } from "./proxy.js";
export { runHook } from "./hook.js";
export { buildStatusReport, buildLimitsReport, formatLimitsLines, type StatusReport, type LimitsReport } from "./report.js";
export { detectPlanTier, mapRateLimitTier, tierLabel, type SubscriptionTier } from "./claude-code.js";
export { readOAuthToken, fetchUsage, usageToSnapshot, refreshUsage, type UsageResponse } from "./claude-usage.js";
export {
  parseUnifiedHeaders,
  parseUtilization,
  parseReset,
  recordHeaders,
  loadLimitsState,
  saveLimitsState,
  emptyLimitsState,
  limitNotifyKey,
  unifiedHeaderDump,
  logUnifiedHeaders,
  WINDOW_MS,
  type LimitSnapshot,
  type WindowState,
  type ExtraWindow,
  type LimitsState,
  type LimitWindow,
  type HeaderGetter,
} from "./limits.js";
export {
  assessWindow,
  assessSnapshot,
  worstLevel,
  type PacingAssessment,
  type PacingLevel,
  type PacingThresholds,
} from "./pacing.js";
export {
  installHook,
  setBudget,
  setLimits,
  resetLedger,
  type InstallOptions,
  type InstallResult,
  type BudgetPatch,
  type LimitsPatch,
} from "./ops.js";
