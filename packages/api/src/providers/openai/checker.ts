/**
 * OpenAI Provider
 *
 * Monitors OpenAI API usage: token consumption, request counts, and costs.
 * Kill actions: rotate-creds (revoke API keys).
 */

import type { CloudProvider, ServiceUsage } from "../types.js";
import { evaluateViolations, estimateTokenCost, providerFetch } from "../shared.js";

const OPENAI_BASE = "https://api.openai.com/v1";

function authHeaders(apiKey: string) {
  return { "Authorization": `Bearer ${apiKey}` };
}

const MODEL_PRICING: Record<string, { input: number; output: number }> = {
  "gpt-4o": { input: 2.50, output: 10.00 },
  "gpt-4o-mini": { input: 0.15, output: 0.60 },
  "gpt-4-turbo": { input: 10.00, output: 30.00 },
  "gpt-4": { input: 30.00, output: 60.00 },
  "gpt-3.5-turbo": { input: 0.50, output: 1.50 },
  "o1": { input: 15.00, output: 60.00 },
  "o1-mini": { input: 3.00, output: 12.00 },
};

export const openaiProvider: CloudProvider = {
  id: "openai",
  name: "OpenAI",

  async checkUsage(credential, thresholds) {
    const key = credential.openaiApiKey!;
    const headers = authHeaders(key);
    let totalTokens = 0;
    let totalRequests = 0;
    let totalCost = 0;

    try {
      const today = new Date().toISOString().split("T")[0];
      const usage = await providerFetch(OPENAI_BASE, `/organization/usage?date=${today}`, headers, "OpenAI");
      for (const entry of usage.data || []) {
        const input = entry.n_context_tokens_total || 0;
        const output = entry.n_generated_tokens_total || 0;
        totalTokens += input + output;
        totalRequests += entry.n_requests || 0;
        totalCost += estimateTokenCost(MODEL_PRICING, "gpt-4o-mini", entry.snapshot_id || "gpt-4o-mini", input, output);
      }
    } catch {
      try {
        await providerFetch(OPENAI_BASE, "/models", headers, "OpenAI");
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

    const violations = evaluateViolations(services, thresholds, totalCost, "openaiDailyCostUSD", "openai-billing", {
      openaiRequestsPerDay: "load",
      openaiTokensPerDay: "load",
    });
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
      const models = await providerFetch(OPENAI_BASE, "/models", authHeaders(credential.openaiApiKey), "OpenAI");
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
