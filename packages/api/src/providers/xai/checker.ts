/**
 * xAI Provider
 *
 * Monitors xAI (Grok) API usage: token consumption and costs.
 * OpenAI-compatible API format.
 * Kill actions: rotate-creds (manual).
 */

import type {
  CloudProvider, DecryptedCredential, ThresholdConfig,
  UsageResult, ActionResult, ValidationResult, ServiceUsage, Violation,
} from "../types.js";

const XAI_BASE = "https://api.x.ai/v1";

async function xaiRequest(apiKey: string, path: string): Promise<any> {
  const resp = await fetch(`${XAI_BASE}${path}`, {
    method: "GET",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
  });
  if (!resp.ok) {
    console.error(`[guardian] xAI API error: ${resp.status}`);
    throw new Error(`xAI API error: ${resp.status}`);
  }
  return resp.json();
}

const MODEL_PRICING: Record<string, { input: number; output: number }> = {
  "grok-2": { input: 2.00, output: 10.00 },
  "grok-2-mini": { input: 0.30, output: 1.00 },
  "grok-1": { input: 5.00, output: 15.00 },
};

function estimateCost(model: string, inputTokens: number, outputTokens: number): number {
  const pricing = MODEL_PRICING[model] || MODEL_PRICING["grok-2"];
  const cost = (inputTokens * pricing.input + outputTokens * pricing.output) / 1_000_000;
  return isFinite(cost) ? cost : 0;
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
  if (thresholds.xaiDailyCostUSD && totalDailyCost > thresholds.xaiDailyCostUSD) {
    violations.push({
      serviceName: "xai-billing", metricName: "Daily Cost",
      currentValue: totalDailyCost, threshold: thresholds.xaiDailyCostUSD, unit: "USD",
      severity: totalDailyCost > thresholds.xaiDailyCostUSD * 2 ? "critical" : "warning",
    });
  }
  return violations;
}

export const xaiProvider: CloudProvider = {
  id: "xai",
  name: "xAI",

  async checkUsage(credential, thresholds) {
    const key = credential.xaiApiKey!;
    let totalTokens = 0;
    let totalCost = 0;

    try {
      const usage = await xaiRequest(key, "/usage");
      for (const entry of usage.data || []) {
        const input = entry.input_tokens || entry.n_context_tokens_total || 0;
        const output = entry.output_tokens || entry.n_generated_tokens_total || 0;
        totalTokens += input + output;
        totalCost += estimateCost(entry.model || "grok-2", input, output);
      }
    } catch {
      try {
        await xaiRequest(key, "/models");
      } catch { throw new Error("Failed to connect to xAI API"); }
    }

    const services: ServiceUsage[] = [{
      serviceName: "xai:api",
      metrics: [
        { name: "Tokens Today", value: totalTokens, unit: "tokens", thresholdKey: "xaiTokensPerDay" },
      ],
      estimatedDailyCostUSD: totalCost,
    }];

    const violations = evaluateViolations(services, thresholds, totalCost);
    return {
      provider: "xai", accountId: "xai",
      checkedAt: Date.now(), services, totalEstimatedDailyCostUSD: totalCost,
      violations, securityEvents: [],
    };
  },

  async executeKillSwitch(credential, serviceName, action) {
    if (action === "rotate-creds") {
      return { success: false, action, serviceName, details: "API key rotation requires manual action in the xAI console. Revoke keys at https://console.x.ai/api-keys" };
    }
    return { success: false, action, serviceName, details: `Action ${action} not supported for xAI` };
  },

  async validateCredential(credential) {
    if (!credential.xaiApiKey) return { valid: false, error: "Missing xAI API key" };
    try {
      const models = await xaiRequest(credential.xaiApiKey, "/models");
      return {
        valid: true, accountId: "xai",
        accountName: `xAI (${(models.data || []).length} models available)`,
      };
    } catch (err: any) {
      return { valid: false, error: err.message };
    }
  },

  getDefaultThresholds() {
    return { xaiTokensPerDay: 1_000_000, xaiDailyCostUSD: 50, monthlySpendLimitUSD: 1500 };
  },
};
