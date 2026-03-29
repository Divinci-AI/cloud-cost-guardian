/**
 * Vercel Provider
 *
 * Monitors Vercel usage: function invocations, bandwidth, builds.
 * Kill actions: scale-down (set function concurrency), disable-service.
 */

import type {
  CloudProvider, DecryptedCredential, ThresholdConfig,
  UsageResult, ActionResult, ValidationResult, ServiceUsage, Violation,
} from "../types.js";

const VERCEL_BASE = "https://api.vercel.com";

async function vercelRequest(token: string, path: string, teamId?: string): Promise<any> {
  const url = new URL(`${VERCEL_BASE}${path}`);
  if (teamId) url.searchParams.set("teamId", teamId);
  const resp = await fetch(url.toString(), {
    method: "GET",
    headers: { "Authorization": `Bearer ${token}`, "Content-Type": "application/json" },
  });
  if (!resp.ok) {
    console.error(`[guardian] Vercel API error: ${resp.status}`);
    throw new Error(`Vercel API error: ${resp.status}`);
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
  if (thresholds.vercelDailyCostUSD && totalDailyCost > thresholds.vercelDailyCostUSD) {
    violations.push({
      serviceName: "vercel-billing", metricName: "Daily Cost",
      currentValue: totalDailyCost, threshold: thresholds.vercelDailyCostUSD, unit: "USD",
      severity: totalDailyCost > thresholds.vercelDailyCostUSD * 2 ? "critical" : "warning",
    });
  }
  return violations;
}

export const vercelProvider: CloudProvider = {
  id: "vercel",
  name: "Vercel",

  async checkUsage(credential, thresholds) {
    const token = credential.vercelApiToken!;
    const teamId = credential.vercelTeamId;
    let invocations = 0;
    let bandwidthGB = 0;
    let totalCost = 0;

    try {
      const now = new Date();
      const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
      const usage = await vercelRequest(token, `/v1/usage?since=${startOfDay}`, teamId);
      invocations = usage?.functionInvocations || usage?.metrics?.functionInvocations || 0;
      const bandwidthBytes = usage?.bandwidth || usage?.metrics?.bandwidth || 0;
      bandwidthGB = bandwidthBytes / (1024 ** 3);
      if (!isFinite(bandwidthGB)) bandwidthGB = 0;
      // Vercel Pro: ~$0.000018/invocation, $0.15/GB bandwidth
      totalCost = invocations * 0.000018 + bandwidthGB * 0.15;
      if (!isFinite(totalCost)) totalCost = 0;
    } catch {
      try {
        await vercelRequest(token, "/v2/user");
      } catch { throw new Error("Failed to connect to Vercel API"); }
    }

    const services: ServiceUsage[] = [{
      serviceName: "vercel:platform",
      metrics: [
        { name: "Function Invocations", value: invocations, unit: "invocations", thresholdKey: "vercelFunctionInvocationsPerDay" },
        { name: "Bandwidth", value: Math.round(bandwidthGB * 100) / 100, unit: "GB", thresholdKey: "vercelBandwidthGBPerDay" },
      ],
      estimatedDailyCostUSD: totalCost,
    }];

    const violations = evaluateViolations(services, thresholds, totalCost);
    return {
      provider: "vercel", accountId: teamId || "vercel",
      checkedAt: Date.now(), services, totalEstimatedDailyCostUSD: totalCost,
      violations, securityEvents: [],
    };
  },

  async executeKillSwitch(credential, serviceName, action) {
    if (action === "scale-down") {
      return { success: false, action, serviceName, details: "Function concurrency scaling requires manual action in the Vercel dashboard. Visit https://vercel.com/dashboard" };
    }
    if (action === "disable-service") {
      return { success: false, action, serviceName, details: "Service disabling requires manual action in the Vercel dashboard. Visit https://vercel.com/dashboard" };
    }
    return { success: false, action, serviceName, details: `Action ${action} not supported for Vercel` };
  },

  async validateCredential(credential) {
    if (!credential.vercelApiToken) return { valid: false, error: "Missing Vercel API token" };
    try {
      const user = await vercelRequest(credential.vercelApiToken, "/v2/user");
      const name = user?.user?.username || user?.user?.name || "unknown";
      return {
        valid: true, accountId: credential.vercelTeamId || name,
        accountName: `Vercel (${name})`,
      };
    } catch (err: any) {
      return { valid: false, error: err.message };
    }
  },

  getDefaultThresholds() {
    return { vercelFunctionInvocationsPerDay: 100_000, vercelBandwidthGBPerDay: 100, vercelDailyCostUSD: 50, monthlySpendLimitUSD: 1500 };
  },
};
