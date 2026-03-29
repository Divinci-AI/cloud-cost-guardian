/**
 * OpenAI Provider
 *
 * Monitors OpenAI API usage: token consumption, request counts, and costs.
 * Kill actions: rotate-creds (revoke API keys).
 */

import type {
  CloudProvider, DecryptedCredential, ThresholdConfig,
  UsageResult, ActionResult, ValidationResult, ServiceUsage, Violation,
} from "../types.js";

const OPENAI_BASE = "https://api.openai.com/v1";

async function openaiRequest(apiKey: string, path: string, method = "GET", body?: any): Promise<any> {
  const headers: Record<string, string> = {
    "Authorization": `Bearer ${apiKey}`,
    "Content-Type": "application/json",
  };
  const resp = await fetch(`${OPENAI_BASE}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  if (!resp.ok) {
    console.error(`[guardian] OpenAI API error: ${resp.status}`);
    throw new Error(`OpenAI API error: ${resp.status}`);
  }
  return resp.json();
}

// Token pricing (per 1M tokens, approximate)
const MODEL_PRICING: Record<string, { input: number; output: number }> = {
  "gpt-4o": { input: 2.50, output: 10.00 },
  "gpt-4o-mini": { input: 0.15, output: 0.60 },
  "gpt-4-turbo": { input: 10.00, output: 30.00 },
  "gpt-4": { input: 30.00, output: 60.00 },
  "gpt-3.5-turbo": { input: 0.50, output: 1.50 },
  "o1": { input: 15.00, output: 60.00 },
  "o1-mini": { input: 3.00, output: 12.00 },
};

function estimateCost(model: string, inputTokens: number, outputTokens: number): number {
  const pricing = MODEL_PRICING[model] || MODEL_PRICING["gpt-4o-mini"];
  return (inputTokens * pricing.input + outputTokens * pricing.output) / 1_000_000;
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
  if (thresholds.openaiDailyCostUSD && totalDailyCost > thresholds.openaiDailyCostUSD) {
    violations.push({
      serviceName: "openai-billing", metricName: "Daily Cost",
      currentValue: totalDailyCost, threshold: thresholds.openaiDailyCostUSD, unit: "USD",
      severity: totalDailyCost > thresholds.openaiDailyCostUSD * 2 ? "critical" : "warning",
    });
  }
  return violations;
}

export const openaiProvider: CloudProvider = {
  id: "openai",
  name: "OpenAI",

  async checkUsage(credential, thresholds) {
    const key = credential.openaiApiKey!;
    let totalTokens = 0;
    let totalRequests = 0;
    let totalCost = 0;

    // Try to get usage data from the organization API
    try {
      const today = new Date().toISOString().split("T")[0];
      const usage = await openaiRequest(key, `/organization/usage?date=${today}`);
      for (const entry of usage.data || []) {
        const input = entry.n_context_tokens_total || 0;
        const output = entry.n_generated_tokens_total || 0;
        totalTokens += input + output;
        totalRequests += entry.n_requests || 0;
        totalCost += estimateCost(entry.snapshot_id || "gpt-4o-mini", input, output);
      }
    } catch {
      // Organization usage endpoint may not be available — try models listing as fallback
      try {
        await openaiRequest(key, "/models");
        // Can't get usage without org API, return zero metrics
      } catch { throw new Error("Failed to connect to OpenAI API"); }
    }

    const services: ServiceUsage[] = [{
      serviceName: "openai:api",
      metrics: [
        { name: "Tokens Today", value: totalTokens, unit: "tokens", thresholdKey: "openaiTokensPerDay" },
        { name: "Requests Today", value: totalRequests, unit: "requests", thresholdKey: "openaiRequestsPerDay" },
      ],
      estimatedDailyCostUSD: totalCost,
    }];

    const violations = evaluateViolations(services, thresholds, totalCost);
    return {
      provider: "openai", accountId: credential.openaiOrgId || "openai",
      checkedAt: Date.now(), services, totalEstimatedDailyCostUSD: totalCost,
      violations, securityEvents: [],
    };
  },

  async executeKillSwitch(credential, serviceName, action) {
    if (action === "rotate-creds") {
      return { success: false, action, serviceName, details: "API key rotation requires manual action in the OpenAI dashboard. Revoke keys at https://platform.openai.com/api-keys" };
    }
    return { success: false, action, serviceName, details: `Action ${action} not supported for OpenAI` };
  },

  async validateCredential(credential) {
    if (!credential.openaiApiKey) return { valid: false, error: "Missing OpenAI API key" };
    try {
      const models = await openaiRequest(credential.openaiApiKey, "/models");
      return {
        valid: true,
        accountId: credential.openaiOrgId || "openai",
        accountName: `OpenAI (${(models.data || []).length} models available)`,
      };
    } catch (err: any) {
      return { valid: false, error: err.message };
    }
  },

  getDefaultThresholds() {
    return { openaiTokensPerDay: 1_000_000, openaiRequestsPerDay: 10_000, openaiDailyCostUSD: 50, monthlySpendLimitUSD: 1500 };
  },
};
