/**
 * xAI Provider
 *
 * Monitors xAI (Grok) API usage: token consumption and costs.
 * OpenAI-compatible API format.
 * Kill actions: rotate-creds (manual).
 */

import type { CloudProvider, ServiceUsage } from "../types.js";
import { evaluateViolations, estimateTokenCost, providerFetch } from "../shared.js";

const XAI_BASE = "https://api.x.ai/v1";

function authHeaders(apiKey: string) {
  return { "Authorization": `Bearer ${apiKey}` };
}

const MODEL_PRICING: Record<string, { input: number; output: number }> = {
  "grok-2": { input: 2.00, output: 10.00 },
  "grok-2-mini": { input: 0.30, output: 1.00 },
  "grok-1": { input: 5.00, output: 15.00 },
};

export const xaiProvider: CloudProvider = {
  id: "xai",
  name: "xAI",

  async checkUsage(credential, thresholds) {
    const key = credential.xaiApiKey!;
    const headers = authHeaders(key);
    let totalTokens = 0;
    let totalCost = 0;

    try {
      const usage = await providerFetch(XAI_BASE, "/usage", headers, "xAI");
      for (const entry of usage.data || []) {
        const input = entry.input_tokens || entry.n_context_tokens_total || 0;
        const output = entry.output_tokens || entry.n_generated_tokens_total || 0;
        totalTokens += input + output;
        totalCost += estimateTokenCost(MODEL_PRICING, "grok-2", entry.model || "grok-2", input, output);
      }
    } catch {
      try {
        await providerFetch(XAI_BASE, "/models", headers, "xAI");
      } catch { throw new Error("Failed to connect to xAI API"); }
    }

    const services: ServiceUsage[] = [{
      serviceName: "xai:api",
      metrics: [
        { name: "Tokens Today", value: totalTokens, unit: "tokens", thresholdKey: "xaiTokensPerDay" },
      ],
      estimatedDailyCostUSD: totalCost,
    }];

    const violations = evaluateViolations(services, thresholds, totalCost, "xaiDailyCostUSD", "xai-billing", {
      xaiTokensPerDay: "load",
    });
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
      const models = await providerFetch(XAI_BASE, "/models", authHeaders(credential.xaiApiKey), "xAI");
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
