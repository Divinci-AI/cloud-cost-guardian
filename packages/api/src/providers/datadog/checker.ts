/**
 * Datadog Provider
 *
 * Monitors Datadog usage: host count, log ingestion, custom metrics.
 * Kill actions: rotate-creds (manual), disable-service (mute monitors).
 */

import type {
  CloudProvider, DecryptedCredential, ThresholdConfig,
  UsageResult, ActionResult, ValidationResult, ServiceUsage, Violation,
} from "../types.js";

function ddBase(site?: "us" | "eu"): string {
  return site === "eu" ? "https://api.datadoghq.eu/api/v1" : "https://api.datadoghq.com/api/v1";
}

async function ddRequest(cred: DecryptedCredential, path: string): Promise<any> {
  const base = ddBase(cred.datadogSite);
  const resp = await fetch(`${base}${path}`, {
    method: "GET",
    headers: {
      "DD-API-KEY": cred.datadogApiKey!,
      "DD-APPLICATION-KEY": cred.datadogApplicationKey!,
      "Content-Type": "application/json",
    },
  });
  if (!resp.ok) {
    console.error(`[guardian] Datadog API error: ${resp.status}`);
    throw new Error(`Datadog API error: ${resp.status}`);
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
  if (thresholds.datadogDailyCostUSD && totalDailyCost > thresholds.datadogDailyCostUSD) {
    violations.push({
      serviceName: "datadog-billing", metricName: "Daily Cost",
      currentValue: totalDailyCost, threshold: thresholds.datadogDailyCostUSD, unit: "USD",
      severity: totalDailyCost > thresholds.datadogDailyCostUSD * 2 ? "critical" : "warning",
    });
  }
  return violations;
}

export const datadogProvider: CloudProvider = {
  id: "datadog",
  name: "Datadog",

  async checkUsage(credential, thresholds) {
    let hostCount = 0;
    let logIngestGB = 0;
    let totalCost = 0;

    try {
      const now = new Date();
      const month = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}`;
      const usage = await ddRequest(credential, `/usage/summary?start_month=${month}`);
      hostCount = usage?.host_count || usage?.usage?.[0]?.host_count || 0;
      const logBytes = usage?.logs_indexed_events_count || usage?.usage?.[0]?.ingested_events_bytes_sum || 0;
      logIngestGB = logBytes / (1024 ** 3);
      if (!isFinite(logIngestGB)) logIngestGB = 0;
      // Datadog Pro: ~$23/host/month (~$0.77/day), logs ~$0.10/GB
      totalCost = hostCount * 0.77 + logIngestGB * 0.10;
      if (!isFinite(totalCost)) totalCost = 0;
    } catch {
      try {
        await ddRequest(credential, "/validate");
      } catch { throw new Error("Failed to connect to Datadog API"); }
    }

    const services: ServiceUsage[] = [{
      serviceName: "datadog:monitoring",
      metrics: [
        { name: "Host Count", value: hostCount, unit: "hosts", thresholdKey: "datadogHostCount" },
        { name: "Log Ingestion", value: Math.round(logIngestGB * 100) / 100, unit: "GB", thresholdKey: "datadogLogIngestGBPerDay" },
      ],
      estimatedDailyCostUSD: totalCost,
    }];

    const violations = evaluateViolations(services, thresholds, totalCost);
    return {
      provider: "datadog", accountId: credential.datadogSite === "eu" ? "datadog-eu" : "datadog-us",
      checkedAt: Date.now(), services, totalEstimatedDailyCostUSD: totalCost,
      violations, securityEvents: [],
    };
  },

  async executeKillSwitch(credential, serviceName, action) {
    if (action === "rotate-creds") {
      return { success: false, action, serviceName, details: "API key rotation requires manual action. Manage keys at https://app.datadoghq.com/organization-settings/api-keys" };
    }
    if (action === "disable-service") {
      return { success: false, action, serviceName, details: "Monitor muting requires manual action. Visit https://app.datadoghq.com/monitors/manage to mute all monitors." };
    }
    return { success: false, action, serviceName, details: `Action ${action} not supported for Datadog` };
  },

  async validateCredential(credential) {
    if (!credential.datadogApiKey || !credential.datadogApplicationKey) {
      return { valid: false, error: "Missing Datadog API key or Application key" };
    }
    try {
      const result = await ddRequest(credential, "/validate");
      return {
        valid: result.valid === true,
        accountId: credential.datadogSite === "eu" ? "datadog-eu" : "datadog-us",
        accountName: `Datadog (${credential.datadogSite === "eu" ? "EU" : "US"})`,
        error: result.valid === true ? undefined : "Invalid API key",
      };
    } catch (err: any) {
      return { valid: false, error: err.message };
    }
  },

  getDefaultThresholds() {
    return { datadogHostCount: 50, datadogLogIngestGBPerDay: 10, datadogDailyCostUSD: 100, monthlySpendLimitUSD: 3000 };
  },
};
