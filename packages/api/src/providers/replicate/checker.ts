/**
 * Replicate Provider
 *
 * Monitors Replicate usage: predictions, GPU hours, and costs.
 * Kill actions: rotate-creds (manual).
 */

import type {
  CloudProvider, DecryptedCredential, ThresholdConfig,
  UsageResult, ActionResult, ValidationResult, ServiceUsage, Violation,
} from "../types.js";

const REPLICATE_BASE = "https://api.replicate.com/v1";

async function replicateRequest(token: string, path: string): Promise<any> {
  const resp = await fetch(`${REPLICATE_BASE}${path}`, {
    method: "GET",
    headers: { "Authorization": `Token ${token}`, "Content-Type": "application/json" },
  });
  if (!resp.ok) {
    console.error(`[guardian] Replicate API error: ${resp.status}`);
    throw new Error(`Replicate API error: ${resp.status}`);
  }
  return resp.json();
}

function evaluateViolations(services: ServiceUsage[], thresholds: ThresholdConfig, totalDailyCost: number): Violation[] {
  const violations: Violation[] = [];
  for (const service of services) {
    for (const metric of service.metrics) {
      if (!metric.thresholdKey) continue;
      const threshold = thresholds[metric.thresholdKey];
      if (threshold !== undefined && metric.value > threshold) {
        violations.push({
          serviceName: service.serviceName, metricName: metric.name,
          currentValue: metric.value, threshold, unit: metric.unit,
          severity: metric.value > threshold * 2 ? "critical" : "warning",
        });
      }
    }
  }
  if (thresholds.replicateDailyCostUSD && totalDailyCost > thresholds.replicateDailyCostUSD) {
    violations.push({
      serviceName: "replicate-billing", metricName: "Daily Cost",
      currentValue: totalDailyCost, threshold: thresholds.replicateDailyCostUSD, unit: "USD",
      severity: totalDailyCost > thresholds.replicateDailyCostUSD * 2 ? "critical" : "warning",
    });
  }
  return violations;
}

export const replicateProvider: CloudProvider = {
  id: "replicate",
  name: "Replicate",

  async checkUsage(credential, thresholds) {
    const token = credential.replicateApiToken!;
    let predictions = 0;
    let gpuHours = 0;
    let totalCost = 0;

    try {
      const result = await replicateRequest(token, "/predictions?order=desc&limit=100");
      const oneDayAgo = Date.now() - 86_400_000;
      for (const pred of result.results || []) {
        const createdAt = new Date(pred.created_at).getTime();
        if (createdAt < oneDayAgo) continue;
        predictions++;
        const seconds = pred.metrics?.predict_time || 0;
        gpuHours += seconds / 3600;
        // Replicate charges ~$0.001155/sec for mid-range GPU
        const cost = seconds * 0.001155;
        totalCost += isFinite(cost) ? cost : 0;
      }
    } catch {
      try {
        await replicateRequest(token, "/account");
      } catch { throw new Error("Failed to connect to Replicate API"); }
    }

    const services: ServiceUsage[] = [{
      serviceName: "replicate:predictions",
      metrics: [
        { name: "Predictions Today", value: predictions, unit: "predictions", thresholdKey: "replicatePredictionsPerDay" },
        { name: "GPU Hours Today", value: Math.round(gpuHours * 100) / 100, unit: "hours", thresholdKey: "replicateGpuHoursPerDay" },
      ],
      estimatedDailyCostUSD: totalCost,
    }];

    const violations = evaluateViolations(services, thresholds, totalCost);
    return {
      provider: "replicate", accountId: "replicate",
      checkedAt: Date.now(), services, totalEstimatedDailyCostUSD: totalCost,
      violations, securityEvents: [],
    };
  },

  async executeKillSwitch(credential, serviceName, action) {
    if (action === "rotate-creds") {
      return { success: false, action, serviceName, details: "API token rotation requires manual action. Revoke tokens at https://replicate.com/account/api-tokens" };
    }
    return { success: false, action, serviceName, details: `Action ${action} not supported for Replicate` };
  },

  async validateCredential(credential) {
    if (!credential.replicateApiToken) return { valid: false, error: "Missing Replicate API token" };
    try {
      const account = await replicateRequest(credential.replicateApiToken, "/account");
      return {
        valid: true, accountId: account.username || "replicate",
        accountName: `Replicate (${account.username || "unknown"})`,
      };
    } catch (err: any) {
      return { valid: false, error: err.message };
    }
  },

  getDefaultThresholds() {
    return { replicatePredictionsPerDay: 100, replicateGpuHoursPerDay: 4, replicateDailyCostUSD: 25, monthlySpendLimitUSD: 750 };
  },
};
