/**
 * Datadog Provider
 *
 * Monitors Datadog usage: host count, log ingestion, custom metrics.
 * Kill actions: rotate-creds (manual), disable-service (mute monitors).
 */

import type { CloudProvider, ServiceUsage } from "../types.js";
import { evaluateViolations, providerFetch } from "../shared.js";

function ddBase(site?: "us" | "eu"): string {
  return site === "eu" ? "https://api.datadoghq.eu/api/v1" : "https://api.datadoghq.com/api/v1";
}

function ddHeaders(apiKey: string, applicationKey: string): Record<string, string> {
  return { "DD-API-KEY": apiKey, "DD-APPLICATION-KEY": applicationKey };
}

export const datadogProvider: CloudProvider = {
  id: "datadog",
  name: "Datadog",

  async checkUsage(credential, thresholds) {
    const base = ddBase(credential.datadogSite);
    const headers = ddHeaders(credential.datadogApiKey!, credential.datadogApplicationKey!);
    let hostCount = 0;
    let logIngestGB = 0;
    let totalCost = 0;

    try {
      const now = new Date();
      const month = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}`;
      const usage = await providerFetch(base, `/usage/summary?start_month=${month}`, headers, "Datadog");
      hostCount = usage?.host_count ?? usage?.usage?.[0]?.host_count ?? 0;
      // Monthly totals — divide by days elapsed to get daily average
      const dayOfMonth = Math.max(1, now.getDate());
      const monthlyLogBytes = usage?.usage?.[0]?.ingested_events_bytes_sum ?? 0;
      logIngestGB = (monthlyLogBytes / (1024 ** 3)) / dayOfMonth;
      if (!isFinite(logIngestGB)) logIngestGB = 0;
      // Datadog Pro: ~$23/host/month (~$0.77/day), logs ~$0.10/GB/day
      totalCost = hostCount * 0.77 + logIngestGB * 0.10;
      if (!isFinite(totalCost)) totalCost = 0;
    } catch {
      try {
        await providerFetch(base, "/validate", headers, "Datadog");
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

    const violations = evaluateViolations(services, thresholds, totalCost, "datadogDailyCostUSD", "datadog-billing");
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
      const base = ddBase(credential.datadogSite);
      const headers = ddHeaders(credential.datadogApiKey, credential.datadogApplicationKey);
      const result = await providerFetch(base, "/validate", headers, "Datadog");
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
