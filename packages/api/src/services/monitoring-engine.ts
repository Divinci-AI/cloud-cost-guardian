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
import { getCredential } from "../models/encrypted-credential/schema.js";
import { getProvider } from "../providers/index.js";
import { sendAlerts } from "./alerting.js";
import { recordUsageSnapshot, recordAlert } from "../globals/index.js";
import { captureSnapshot } from "./forensics.js";
import type { UsageResult, Violation, KillAction, ProviderId } from "../providers/types.js";

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

    if (usage.violations.length > 0) {
      result.status = "violation";
      result.violations = usage.violations;

      // Execute kill switch for non-protected services
      for (const violation of usage.violations) {
        if (cloudAccount.protectedServices.includes(violation.serviceName)) {
          result.actionsTaken.push(`PROTECTED: ${violation.serviceName}`);
          continue;
        }

        if (cloudAccount.autoDelete && violation.severity === "critical") {
          const action = await provider.executeKillSwitch(credential, violation.serviceName, "delete");
          result.actionsTaken.push(action.details);
          // Capture forensic snapshot for evidence and compliance
          captureSnapshot(credential, violation.serviceName, `kill-switch:delete:${violation.metricName}`, cloudAccount._id.toString())
            .then(snap => result.forensicSnapshotIds.push(snap.id))
            .catch(err => console.warn(`[guardian] Forensic snapshot failed for ${violation.serviceName}:`, err.message));
        } else if (cloudAccount.autoDisconnect) {
          const killAction = getDefaultKillAction(cloudAccount.provider as ProviderId);
          const action = await provider.executeKillSwitch(credential, violation.serviceName, killAction);
          result.actionsTaken.push(action.details);
          // Capture forensic snapshot for evidence and compliance
          captureSnapshot(credential, violation.serviceName, `kill-switch:${killAction}:${violation.metricName}`, cloudAccount._id.toString())
            .then(snap => result.forensicSnapshotIds.push(snap.id))
            .catch(err => console.warn(`[guardian] Forensic snapshot failed for ${violation.serviceName}:`, err.message));
        }
      }

      // Send alerts
      const guardianAccount = await GuardianAccountModel.findById(cloudAccount.guardianAccountId);
      if (guardianAccount && guardianAccount.alertChannels.length > 0) {
        const summary = `${provider.name} cost alert: ${usage.violations.length} service(s) exceeded thresholds on ${cloudAccount.name}`;
        await sendAlerts(guardianAccount.alertChannels, summary, "critical", {
          provider: cloudAccount.provider,
          accountName: cloudAccount.name,
          cloudAccountId: cloudAccount._id.toString(),
          violations: usage.violations,
          actionsTaken: result.actionsTaken,
          totalEstimatedDailyCost: usage.totalEstimatedDailyCostUSD,
        });
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
