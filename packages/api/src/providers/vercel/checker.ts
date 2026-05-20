/**
 * Vercel Provider
 *
 * Monitors Vercel usage: function invocations, bandwidth, builds.
 * Kill actions: scale-down (cancel all BUILDING/QUEUED deployments).
 */

import type { CloudProvider, ServiceUsage } from "../types.js";
import { evaluateViolations, providerFetch } from "../shared.js";

const VERCEL_BASE = "https://api.vercel.com";

function authHeaders(token: string) {
  return { "Authorization": `Bearer ${token}` };
}

function buildPath(path: string, teamId?: string): string {
  if (!teamId) return path;
  const sep = path.includes("?") ? "&" : "?";
  return `${path}${sep}teamId=${teamId}`;
}

export const vercelProvider: CloudProvider = {
  id: "vercel",
  name: "Vercel",

  async checkUsage(credential, thresholds) {
    const token = credential.vercelApiToken!;
    const teamId = credential.vercelTeamId;
    const headers = authHeaders(token);
    let invocations = 0;
    let bandwidthGB = 0;
    let totalCost = 0;

    try {
      const now = new Date();
      const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
      const usage = await providerFetch(VERCEL_BASE, buildPath(`/v1/usage?since=${startOfDay}`, teamId), headers, "Vercel");
      invocations = usage?.functionInvocations || usage?.metrics?.functionInvocations || 0;
      const bandwidthBytes = usage?.bandwidth || usage?.metrics?.bandwidth || 0;
      bandwidthGB = bandwidthBytes / (1024 ** 3);
      if (!isFinite(bandwidthGB)) bandwidthGB = 0;
      // Vercel Pro: ~$0.000018/invocation, $0.15/GB bandwidth
      totalCost = invocations * 0.000018 + bandwidthGB * 0.15;
      if (!isFinite(totalCost)) totalCost = 0;
    } catch {
      try {
        await providerFetch(VERCEL_BASE, buildPath("/v2/user", teamId), headers, "Vercel");
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

    const violations = evaluateViolations(services, thresholds, totalCost, "vercelDailyCostUSD", "vercel-billing", {
      vercelBandwidthGBPerDay: "load",
      vercelFunctionInvocationsPerDay: "load",
    });
    return {
      provider: "vercel", accountId: teamId || "vercel",
      checkedAt: Date.now(), services, totalEstimatedDailyCostUSD: totalCost,
      violations, securityEvents: [],
    };
  },

  async executeKillSwitch(credential, serviceName, action) {
    const token = credential.vercelApiToken!;
    const teamId = credential.vercelTeamId;
    const headers = { ...authHeaders(token), "Content-Type": "application/json" };

    if (action === "scale-down" || action === "disconnect") {
      try {
        // List all BUILDING and QUEUED deployments
        const listPath = buildPath("/v6/deployments?state=BUILDING,QUEUED&limit=50", teamId);
        const { deployments = [] } = await providerFetch(VERCEL_BASE, listPath, headers, "Vercel");

        const cancellable = deployments.filter((d: any) => d.state === "BUILDING" || d.state === "QUEUED");
        if (cancellable.length === 0) {
          return { success: true, action, serviceName, details: "No active builds to cancel" };
        }

        const outcomes = await Promise.allSettled(
          cancellable.map((d: any) =>
            fetch(`${VERCEL_BASE}/v12/deployments/${d.uid}/cancel${teamId ? `?teamId=${teamId}` : ""}`, {
              method: "PATCH", headers,
            })
          )
        );

        const cancelled = outcomes.filter(o => o.status === "fulfilled" && (o as PromiseFulfilledResult<Response>).value.ok).length;
        const failed = cancellable.length - cancelled;
        return {
          success: cancelled > 0 || cancellable.length === 0,
          action, serviceName,
          details: `Cancelled ${cancelled} build(s)${failed > 0 ? `, ${failed} failed` : ""}`,
        };
      } catch (err: any) {
        return { success: false, action, serviceName, details: `Failed to cancel builds: ${err.message}` };
      }
    }

    if (action === "rotate-creds") {
      return { success: false, action, serviceName, details: "Token rotation requires manual action. Manage tokens at https://vercel.com/account/tokens" };
    }

    return { success: false, action, serviceName, details: `Action ${action} not supported for Vercel` };
  },

  async validateCredential(credential) {
    if (!credential.vercelApiToken) return { valid: false, error: "Missing Vercel API token" };
    try {
      const user = await providerFetch(VERCEL_BASE, "/v2/user", authHeaders(credential.vercelApiToken), "Vercel");
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
