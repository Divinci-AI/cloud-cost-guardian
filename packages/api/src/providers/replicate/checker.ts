/**
 * Replicate Provider
 *
 * Monitors Replicate usage: predictions, GPU hours, and costs.
 * Kill actions: cancel-predictions (cancel all running/queued), rotate-creds (manual).
 */

import type { CloudProvider, ServiceUsage } from "../types.js";
import { evaluateViolations, providerFetch } from "../shared.js";

const REPLICATE_BASE = "https://api.replicate.com/v1";

function authHeaders(token: string) {
  return { "Authorization": `Token ${token}` };
}

export const replicateProvider: CloudProvider = {
  id: "replicate",
  name: "Replicate",

  async checkUsage(credential, thresholds) {
    const token = credential.replicateApiToken!;
    const headers = authHeaders(token);
    let predictions = 0;
    let gpuHours = 0;
    let totalCost = 0;

    try {
      const result = await providerFetch(REPLICATE_BASE, "/predictions?order=desc&limit=100", headers, "Replicate");
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
        await providerFetch(REPLICATE_BASE, "/account", headers, "Replicate");
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

    const violations = evaluateViolations(services, thresholds, totalCost, "replicateDailyCostUSD", "replicate-billing", {
      replicateGpuHoursPerDay: "load",
      replicatePredictionsPerDay: "load",
    });
    return {
      provider: "replicate", accountId: "replicate",
      checkedAt: Date.now(), services, totalEstimatedDailyCostUSD: totalCost,
      violations, securityEvents: [],
    };
  },

  async executeKillSwitch(credential, serviceName, action) {
    const token = credential.replicateApiToken!;
    const headers = authHeaders(token);

    // Cancel all running and queued predictions
    if (action === "scale-down" || action === "disconnect" || action === "stop-pod") {
      try {
        // Fetch up to 100 predictions; cancel those in a cancellable state
        const result = await providerFetch(REPLICATE_BASE, "/predictions?order=desc&limit=100", headers, "Replicate");
        const cancellable = (result.results || []).filter(
          (p: any) => p.status === "starting" || p.status === "processing"
        );

        if (cancellable.length === 0) {
          return { success: true, action, serviceName, details: "No running predictions to cancel" };
        }

        const outcomes = await Promise.allSettled(
          cancellable.map((p: any) =>
            fetch(`${REPLICATE_BASE}/predictions/${p.id}/cancel`, {
              method: "POST",
              headers: { ...headers, "Content-Type": "application/json" },
            })
          )
        );

        const cancelled = outcomes.filter(o => o.status === "fulfilled" && (o as PromiseFulfilledResult<Response>).value.ok).length;
        const failed = cancellable.length - cancelled;

        return {
          success: cancelled > 0 || cancellable.length === 0,
          action,
          serviceName,
          details: `Cancelled ${cancelled} prediction(s)${failed > 0 ? `, ${failed} failed` : ""}`,
        };
      } catch (err: any) {
        return { success: false, action, serviceName, details: `Failed to cancel predictions: ${err.message}` };
      }
    }

    if (action === "rotate-creds") {
      return { success: false, action, serviceName, details: "API token rotation requires manual action. Revoke tokens at https://replicate.com/account/api-tokens" };
    }

    return { success: false, action, serviceName, details: `Action ${action} not supported for Replicate` };
  },

  async validateCredential(credential) {
    if (!credential.replicateApiToken) return { valid: false, error: "Missing Replicate API token" };
    try {
      const account = await providerFetch(REPLICATE_BASE, "/account", authHeaders(credential.replicateApiToken), "Replicate");
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
