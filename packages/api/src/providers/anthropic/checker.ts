/**
 * Anthropic Provider
 *
 * Monitors Anthropic API usage: token consumption and costs.
 * Kill actions: rotate-creds (manual).
 */

import type {
  CloudProvider, DecryptedCredential, ThresholdConfig,
  UsageResult, ActionResult, ValidationResult, ServiceUsage, Violation,
} from "../types.js";

const ANTHROPIC_BASE = "https://api.anthropic.com/v1";

async function anthropicRequest(apiKey: string, path: string): Promise<any> {
  const resp = await fetch(`${ANTHROPIC_BASE}${path}`, {
    method: "GET",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "Content-Type": "application/json",
    },
  });
  if (!resp.ok) {
    console.error(`[guardian] Anthropic API error: ${resp.status}`);
    throw new Error(`Anthropic API error: ${resp.status}`);
  }
  return resp.json();
}

const MODEL_PRICING: Record<string, { input: number; output: number }> = {
  "claude-3.5-sonnet": { input: 3.00, output: 15.00 },
  "claude-3-5-sonnet-20241022": { input: 3.00, output: 15.00 },
  "claude-3-haiku": { input: 0.25, output: 1.25 },
  "claude-3-5-haiku-20241022": { input: 0.80, output: 4.00 },
  "claude-3-opus": { input: 15.00, output: 75.00 },
  "claude-3-sonnet": { input: 3.00, output: 15.00 },
};

function estimateCost(model: string, inputTokens: number, outputTokens: number): number {
  const pricing = MODEL_PRICING[model] || MODEL_PRICING["claude-3.5-sonnet"];
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
  if (thresholds.anthropicDailyCostUSD && totalDailyCost > thresholds.anthropicDailyCostUSD) {
    violations.push({
      serviceName: "anthropic-billing", metricName: "Daily Cost",
      currentValue: totalDailyCost, threshold: thresholds.anthropicDailyCostUSD, unit: "USD",
      severity: totalDailyCost > thresholds.anthropicDailyCostUSD * 2 ? "critical" : "warning",
    });
  }
  return violations;
}

export const anthropicProvider: CloudProvider = {
  id: "anthropic",
  name: "Anthropic",

  async checkUsage(credential, thresholds) {
    const key = credential.anthropicApiKey!;
    let totalTokens = 0;
    let totalCost = 0;

    try {
      const usage = await anthropicRequest(key, "/usage");
      for (const entry of usage.data || []) {
        const input = entry.input_tokens || 0;
        const output = entry.output_tokens || 0;
        totalTokens += input + output;
        totalCost += estimateCost(entry.model || "claude-3.5-sonnet", input, output);
      }
    } catch {
      try {
        await anthropicRequest(key, "/models");
      } catch { throw new Error("Failed to connect to Anthropic API"); }
    }

    const services: ServiceUsage[] = [{
      serviceName: "anthropic:api",
      metrics: [
        { name: "Tokens Today", value: totalTokens, unit: "tokens", thresholdKey: "anthropicTokensPerDay" },
      ],
      estimatedDailyCostUSD: totalCost,
    }];

    const violations = evaluateViolations(services, thresholds, totalCost);
    return {
      provider: "anthropic", accountId: credential.anthropicWorkspaceId || "anthropic",
      checkedAt: Date.now(), services, totalEstimatedDailyCostUSD: totalCost,
      violations, securityEvents: [],
    };
  },

  async executeKillSwitch(credential, serviceName, action) {
    if (action === "rotate-creds") {
      return { success: false, action, serviceName, details: "API key rotation requires manual action in the Anthropic console. Revoke keys at https://console.anthropic.com/settings/keys" };
    }
    return { success: false, action, serviceName, details: `Action ${action} not supported for Anthropic` };
  },

  async validateCredential(credential) {
    if (!credential.anthropicApiKey) return { valid: false, error: "Missing Anthropic API key" };
    try {
      const models = await anthropicRequest(credential.anthropicApiKey, "/models");
      return {
        valid: true,
        accountId: credential.anthropicWorkspaceId || "anthropic",
        accountName: `Anthropic (${(models.data || []).length} models available)`,
      };
    } catch (err: any) {
      return { valid: false, error: err.message };
    }
  },

  getDefaultThresholds() {
    return { anthropicTokensPerDay: 1_000_000, anthropicDailyCostUSD: 50, monthlySpendLimitUSD: 1500 };
  },
};
