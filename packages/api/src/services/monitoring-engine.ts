/**
 * Monitoring Engine
 *
 * Core check loop — iterates over all active cloud accounts and runs
 * provider-specific usage checks. When thresholds are exceeded:
 * 1. Executes kill switch actions (disconnect/delete)
 * 2. Sends alerts to configured channels
 * 3. Records usage snapshot for dashboard
 */

import { CloudAccountModel } from "../models/cloud-account/schema.js";
import { GuardianAccountModel } from "../models/guardian-account/schema.js";
import { KillSwitchRuleModel } from "../models/kill-switch-rule/schema.js";
import { getCredential } from "../models/encrypted-credential/schema.js";
import { getProvider } from "../providers/index.js";
import { sendAlerts } from "./alerting.js";
import { recordUsageSnapshot, recordAlert, recordRuleEvent } from "../globals/index.js";
import { captureSnapshot } from "./forensics.js";
import { evaluateRules } from "./rule-engine.js";
import { withSentinel } from "../providers/shared.js";
import { createHash } from "node:crypto";
import type { UsageResult, Violation, KillAction, ProviderId, KillContext } from "../providers/types.js";

/**
 * Minimum time between alerts for the same violation hash. The monitoring
 * loop runs every 5 min but violations persist; without this cooldown we'd
 * re-send the same alert to every channel on every tick.
 */
const ALERT_COOLDOWN_MS = Number(process.env.ALERT_COOLDOWN_MS || 6 * 60 * 60 * 1000); // 6h default

/**
 * Stable hash of the current violations. Same violations → same hash → deduped.
 * Different violations (new service, changed severity) → different hash → fires a new alert.
 */
function hashViolations(violations: Violation[]): string {
  const normalized = violations
    .map(v => `${v.serviceName}|${v.metricName}|${v.severity}`)
    .sort()
    .join(";");
  return createHash("sha256").update(normalized).digest("hex").slice(0, 16);
}

function getDefaultKillAction(provider: ProviderId): KillAction {
  switch (provider) {
    case "cloudflare": return "disconnect";
    case "gcp":        return "scale-down";
    case "aws":        return "stop-instances";
    case "runpod":     return "stop-pod";
    case "redis":      return "kill-connections";
    case "mongodb":    return "kill-connections";
    case "openai":     return "rotate-creds";
    case "anthropic":  return "rotate-creds";
    case "xai":        return "rotate-creds";
    case "replicate":  return "scale-down";  // cancels all running/queued predictions
    case "snowflake":  return "scale-down";
    case "vercel":     return "scale-down";
    case "datadog":    return "rotate-creds";
    case "neon":       return "scale-down";
    default:           return "disconnect";
  }
}

export interface CheckResult {
  cloudAccountId: string;
  provider: string;
  status: "ok" | "violation" | "error";
  violations: Violation[];
  actionsTaken: string[];
  ruleActionsTaken: string[];
  forensicSnapshotIds: string[];
  usage: UsageResult | null;
  error?: string;
}

/**
 * Run a single check cycle across all active accounts
 */
export async function runCheckCycle(guardianAccountId?: string): Promise<CheckResult[]> {
  const filter: any = { status: "active" };
  if (guardianAccountId) filter.guardianAccountId = guardianAccountId;
  const activeAccounts = await CloudAccountModel.find(filter);

  if (activeAccounts.length === 0) {
    console.error("[guardian] No active cloud accounts to check");
    return [];
  }

  // Filter to accounts whose checkIntervalMinutes has elapsed since lastCheckAt.
  // When guardianAccountId is explicitly provided (manual /check endpoint), skip the filter.
  let dueAccounts = activeAccounts;
  if (!guardianAccountId) {
    const now = Date.now();
    // Batch-load guardian accounts to avoid N+1
    const orgIds = [...new Set(activeAccounts.map(a => a.guardianAccountId))];
    const orgs = await GuardianAccountModel.find({ _id: { $in: orgIds } }, "settings");
    const orgIntervalMs: Record<string, number> = {};
    for (const org of orgs) {
      const minutes = (org as any).settings?.checkIntervalMinutes ?? 360;
      orgIntervalMs[(org as any)._id.toString()] = minutes * 60 * 1000;
    }
    dueAccounts = activeAccounts.filter(a => {
      const intervalMs = orgIntervalMs[a.guardianAccountId] ?? (360 * 60 * 1000);
      const lastCheck = (a as any).lastCheckAt ?? 0;
      return now - lastCheck >= intervalMs;
    });
    if (dueAccounts.length < activeAccounts.length) {
      console.error(`[guardian] ${activeAccounts.length - dueAccounts.length} account(s) skipped (not due yet)`);
    }
  }

  if (dueAccounts.length === 0) {
    console.error("[guardian] No accounts due for check");
    return [];
  }

  console.error(`[guardian] Checking ${dueAccounts.length} cloud account(s)...`);

  // Run checks concurrently (max 5 at a time to avoid thundering herd)
  const CONCURRENCY = 5;
  const results: CheckResult[] = [];
  for (let i = 0; i < dueAccounts.length; i += CONCURRENCY) {
    const batch = dueAccounts.slice(i, i + CONCURRENCY);
    const settled = await Promise.allSettled(batch.map(a => checkSingleAccount(a)));
    for (const outcome of settled) {
      if (outcome.status === "fulfilled") {
        results.push(outcome.value);
      } else {
        console.error("[guardian] Account check failed:", outcome.reason?.message || outcome.reason);
      }
    }
  }

  const violations = results.filter(r => r.status === "violation");
  const errors = results.filter(r => r.status === "error");

  console.error(`[guardian] Check cycle complete: ${results.length} accounts, ${violations.length} violations, ${errors.length} errors`);

  return results;
}

export async function checkSingleAccount(cloudAccount: any): Promise<CheckResult> {
  const result: CheckResult = {
    cloudAccountId: cloudAccount._id.toString(),
    provider: cloudAccount.provider,
    status: "ok",
    violations: [],
    actionsTaken: [],
    ruleActionsTaken: [],
    forensicSnapshotIds: [],
    usage: null,
  };

  try {
    const provider = getProvider(cloudAccount.provider);
    if (!provider) {
      throw new Error(`Unknown provider: ${cloudAccount.provider}`);
    }

    // Decrypt credential from encrypted store
    const credential = await getCredential(cloudAccount.credentialId);
    if (!credential) {
      throw new Error(`Credential not found for cloud account ${cloudAccount.name}`);
    }

    // Run usage check
    const usage = await provider.checkUsage(credential, cloudAccount.thresholds);
    result.usage = usage;

    // Pre-flight upstream health: check the API surface we'd use to fire kill
    // actions BEFORE we fire any. If the kill-action API is degraded, our
    // usage signal may be inconsistent with reality and a kill could amplify
    // the outage.
    //
    // Lazy + memoized: only probe on the first kill site that needs it. No
    // violations + no rule matches = no probe at all (saves ~28K daily API
    // calls for an org with 100 accounts on 5-min cadence).
    let cachedHealth: { healthy: boolean; reason?: string } | undefined;
    const getHealth = async (): Promise<{ healthy: boolean; reason?: string }> => {
      if (cachedHealth) return cachedHealth;
      if (typeof provider.checkHealth !== "function") {
        cachedHealth = { healthy: true };
        return cachedHealth;
      }
      try {
        cachedHealth = await provider.checkHealth(credential);
      } catch (e: any) {
        cachedHealth = { healthy: false, reason: `health-probe-error: ${e.message}` };
      }
      return cachedHealth;
    };

    // Evaluate custom kill switch rules against usage data
    try {
      const ruleDocs = await KillSwitchRuleModel.find({ guardianAccountId: cloudAccount.guardianAccountId }).lean();
      if (ruleDocs.length > 0) {
        const ruleResults = evaluateRules(ruleDocs as any, usage);
        for (const ruleResult of ruleResults) {
          // Emit `evaluated` for *every* enabled rule we considered. This is
          // the load-bearing signal: if rule X never appears in events, the
          // evaluator never saw it (config issue, not "rule is quiet").
          await recordRuleEvent({
            kind: "evaluated",
            guardianAccountId: cloudAccount.guardianAccountId,
            cloudAccountId: cloudAccount._id.toString(),
            ruleId: ruleResult.ruleId,
            ruleName: ruleResult.ruleName,
            details: ruleResult.cooldownActive ? "cooldown-active" : (ruleResult.triggered ? "triggered" : "no-match"),
          });
          if (ruleResult.cooldownActive) {
            await recordRuleEvent({
              kind: "action_skipped",
              guardianAccountId: cloudAccount.guardianAccountId,
              cloudAccountId: cloudAccount._id.toString(),
              ruleId: ruleResult.ruleId,
              ruleName: ruleResult.ruleName,
              reason: "cooldown",
              details: `Within cooldown window`,
            });
            continue;
          }
          if (!ruleResult.triggered) continue;
          await recordRuleEvent({
            kind: "matched",
            guardianAccountId: cloudAccount.guardianAccountId,
            cloudAccountId: cloudAccount._id.toString(),
            ruleId: ruleResult.ruleId,
            ruleName: ruleResult.ruleName,
            details: ruleResult.conditionsMatched.join("; "),
          });
          // Update lastFiredAt on the rule
          await KillSwitchRuleModel.updateOne(
            { guardianAccountId: cloudAccount.guardianAccountId, id: ruleResult.ruleId },
            { lastFiredAt: Date.now() }
          );
          for (const action of ruleResult.actionsToExecute) {
            if (action.requiresApproval) {
              result.ruleActionsTaken.push(`RULE[${ruleResult.ruleName}]: ${action.type} on ${action.target} — awaiting approval`);
              await recordRuleEvent({
                kind: "action_skipped",
                guardianAccountId: cloudAccount.guardianAccountId,
                cloudAccountId: cloudAccount._id.toString(),
                ruleId: ruleResult.ruleId,
                ruleName: ruleResult.ruleName,
                actionType: action.type,
                target: action.target,
                reason: "awaiting-approval",
              });
              continue;
            }
            if (action.type === "snapshot") {
              captureSnapshot(credential, action.target, `rule:${ruleResult.ruleId}`, cloudAccount._id.toString())
                .then(snap => result.forensicSnapshotIds.push(snap.id))
                .catch(err => console.warn(`[guardian] Rule forensic snapshot failed:`, err.message));
              result.ruleActionsTaken.push(`RULE[${ruleResult.ruleName}]: snapshot captured`);
              await recordRuleEvent({
                kind: "action_taken",
                guardianAccountId: cloudAccount.guardianAccountId,
                cloudAccountId: cloudAccount._id.toString(),
                ruleId: ruleResult.ruleId,
                ruleName: ruleResult.ruleName,
                actionType: "snapshot",
                target: action.target,
                success: true,
              });
              continue;
            }
            const ruleHealth = await getHealth();
            if (!ruleHealth.healthy) {
              // Skip kills when the kill-action API surface is degraded.
              // Firing into a half-broken cloud could amplify an outage; the
              // user's KILL_SWITCH_SDK_FEEDBACK_2026_05_01 doc calls this
              // "the bug was already there" — kill switches mask, not heal,
              // pre-existing failures.
              result.ruleActionsTaken.push(`RULE[${ruleResult.ruleName}]: ${action.type} skipped — provider degraded (${ruleHealth.reason})`);
              await recordRuleEvent({
                kind: "action_skipped",
                guardianAccountId: cloudAccount.guardianAccountId,
                cloudAccountId: cloudAccount._id.toString(),
                ruleId: ruleResult.ruleId,
                ruleName: ruleResult.ruleName,
                actionType: action.type,
                target: action.target,
                reason: "provider-degraded",
                details: ruleHealth.reason,
              });
              continue;
            }
            try {
              const killContext: KillContext = {
                ruleId: ruleResult.ruleId,
                ruleName: ruleResult.ruleName,
                reason: `rule:${ruleResult.ruleId}`,
                triggeredAt: Date.now(),
              };
              const raw = await provider.executeKillSwitch(credential, action.target, action.type as KillAction, killContext);
              const killResult = withSentinel(raw, killContext);
              result.ruleActionsTaken.push(`RULE[${ruleResult.ruleName}]: ${killResult.details}`);
              await recordRuleEvent({
                kind: "action_taken",
                guardianAccountId: cloudAccount.guardianAccountId,
                cloudAccountId: cloudAccount._id.toString(),
                ruleId: ruleResult.ruleId,
                ruleName: ruleResult.ruleName,
                actionType: action.type,
                target: action.target,
                success: killResult.success,
                details: killResult.details,
              });
            } catch (err: any) {
              console.warn(`[guardian] Rule action failed (${ruleResult.ruleId}/${action.type}):`, err.message);
              result.ruleActionsTaken.push(`RULE[${ruleResult.ruleName}]: ${action.type} failed — ${err.message}`);
              await recordRuleEvent({
                kind: "action_skipped",
                guardianAccountId: cloudAccount.guardianAccountId,
                cloudAccountId: cloudAccount._id.toString(),
                ruleId: ruleResult.ruleId,
                ruleName: ruleResult.ruleName,
                actionType: action.type,
                target: action.target,
                reason: "exec-failed",
                details: err.message,
              });
            }
          }
        }
        const triggeredRules = ruleResults.filter(r => r.triggered);
        if (triggeredRules.length > 0) {
          console.error(`[guardian] ${triggeredRules.length} rule(s) triggered for ${cloudAccount.name}`);
        }
      }
    } catch (ruleErr: any) {
      // Rule evaluation failures must not abort the main check
      console.warn("[guardian] Rule evaluation failed:", ruleErr.message);
    }

    if (usage.violations.length > 0) {
      result.status = "violation";
      result.violations = usage.violations;

      // Execute kill switch for non-protected services
      for (const violation of usage.violations) {
        // Health probe runs once per cycle on the first kill site that needs
        // it; subsequent violations hit the cached result.
        const thresholdHealth = await getHealth();
        if (!thresholdHealth.healthy) {
          result.actionsTaken.push(`SKIPPED: ${violation.serviceName} — provider degraded (${thresholdHealth.reason})`);
          await recordRuleEvent({
            kind: "action_skipped",
            guardianAccountId: cloudAccount.guardianAccountId,
            cloudAccountId: cloudAccount._id.toString(),
            actionType: "threshold-kill",
            target: violation.serviceName,
            reason: "provider-degraded",
            details: thresholdHealth.reason,
          });
          continue;
        }
        if (cloudAccount.protectedServices.includes(violation.serviceName)) {
          result.actionsTaken.push(`PROTECTED: ${violation.serviceName}`);
          await recordRuleEvent({
            kind: "action_skipped",
            guardianAccountId: cloudAccount.guardianAccountId,
            cloudAccountId: cloudAccount._id.toString(),
            actionType: "threshold-kill",
            target: violation.serviceName,
            reason: "protected-service",
            details: `Threshold breached but ${violation.serviceName} is on the protected-services list`,
          });
          continue;
        }

        const buildThresholdContext = (killAction: KillAction): KillContext => ({
          reason: `threshold:${violation.metricName}`,
          triggeredAt: Date.now(),
        });

        // Helper so success/failure event emission stays identical between
        // the autoDelete and autoDisconnect branches.
        const fireThresholdKill = async (killAction: KillAction): Promise<void> => {
          const ctx = buildThresholdContext(killAction);
          try {
            const raw = await provider.executeKillSwitch(credential, violation.serviceName, killAction, ctx);
            const action = withSentinel(raw, ctx);
            result.actionsTaken.push(action.details);
            await recordRuleEvent({
              kind: "action_taken",
              guardianAccountId: cloudAccount.guardianAccountId,
              cloudAccountId: cloudAccount._id.toString(),
              actionType: `threshold-kill:${killAction}`,
              target: violation.serviceName,
              success: action.success,
              details: action.details,
            });
            // Capture forensic snapshot for evidence and compliance
            captureSnapshot(credential, violation.serviceName, `kill-switch:${killAction}:${violation.metricName}`, cloudAccount._id.toString())
              .then(snap => result.forensicSnapshotIds.push(snap.id))
              .catch(err => console.warn(`[guardian] Forensic snapshot failed for ${violation.serviceName}:`, err.message));
          } catch (err: any) {
            console.warn(`[guardian] Threshold kill failed (${violation.serviceName}/${killAction}):`, err.message);
            result.actionsTaken.push(`${killAction} failed on ${violation.serviceName} — ${err.message}`);
            await recordRuleEvent({
              kind: "action_skipped",
              guardianAccountId: cloudAccount.guardianAccountId,
              cloudAccountId: cloudAccount._id.toString(),
              actionType: `threshold-kill:${killAction}`,
              target: violation.serviceName,
              reason: "exec-failed",
              details: err.message,
            });
          }
        };

        if (cloudAccount.autoDelete && violation.severity === "critical") {
          await fireThresholdKill("delete");
        } else if (cloudAccount.autoDisconnect) {
          await fireThresholdKill(getDefaultKillAction(cloudAccount.provider as ProviderId));
        }
      }

      // Send alerts — deduped so we don't re-alert the same violations every 5 min.
      // Same violation hash + sent within cooldown window → skip. New violations
      // (different services/metrics) always re-alert immediately.
      const guardianAccount = await GuardianAccountModel.findById(cloudAccount.guardianAccountId);
      if (guardianAccount && guardianAccount.alertChannels.length > 0) {
        const alertHash = hashViolations(usage.violations);
        const now = Date.now();
        const sameAsLast = cloudAccount.lastAlertHash === alertHash;
        const stillInCooldown = cloudAccount.lastAlertedAt && (now - cloudAccount.lastAlertedAt) < ALERT_COOLDOWN_MS;
        const shouldSkip = sameAsLast && stillInCooldown;

        if (shouldSkip) {
          console.log(`[guardian] Skipping alert for ${cloudAccount.name} (same violations, cooldown active until ${new Date((cloudAccount.lastAlertedAt ?? 0) + ALERT_COOLDOWN_MS).toISOString()})`);
        } else {
          const summary = `${provider.name} cost alert: ${usage.violations.length} service(s) exceeded thresholds on ${cloudAccount.name}`;
          await sendAlerts(guardianAccount.alertChannels, summary, "critical", {
            provider: cloudAccount.provider,
            accountName: cloudAccount.name,
            cloudAccountId: cloudAccount._id.toString(),
            violations: usage.violations,
            actionsTaken: result.actionsTaken,
            totalEstimatedDailyCost: usage.totalEstimatedDailyCostUSD,
          });
          // Persist dedup state so the next tick in the cooldown window skips
          await CloudAccountModel.findByIdAndUpdate(cloudAccount._id, {
            lastAlertHash: alertHash,
            lastAlertedAt: now,
          });
        }
      }
    }

    // Update cloud account with check results
    await CloudAccountModel.findByIdAndUpdate(cloudAccount._id, {
      lastCheckAt: Date.now(),
      lastCheckStatus: result.status,
      lastCheckError: undefined,
      lastViolations: result.violations.map(v => `${v.serviceName}: ${v.metricName} = ${v.currentValue} (threshold: ${v.threshold})`),
    });

    // Record usage snapshot to PostgreSQL for dashboard charts
    try {
      await recordUsageSnapshot(
        cloudAccount._id.toString(),
        cloudAccount.guardianAccountId,
        cloudAccount.provider,
        {
          services: usage.services.map(s => ({ name: s.serviceName, metrics: s.metrics, cost: s.estimatedDailyCostUSD })),
          totalCost: usage.totalEstimatedDailyCostUSD,
        },
        result.violations.map(v => `${v.serviceName}: ${v.metricName}`),
        result.actionsTaken,
        usage.totalEstimatedDailyCostUSD,
        usage.services.length
      );
    } catch (pgError: any) {
      // Don't fail the check if Postgres is unavailable
      console.warn("[guardian] Failed to record usage snapshot:", pgError.message);
    }

  } catch (error: any) {
    result.status = "error";
    result.error = error.message;
    console.error(`[guardian] Error checking ${cloudAccount.name}:`, error.message);

    await CloudAccountModel.findByIdAndUpdate(cloudAccount._id, {
      lastCheckAt: Date.now(),
      lastCheckStatus: "error",
      lastCheckError: error.message,
    });
  }

  return result;
}
