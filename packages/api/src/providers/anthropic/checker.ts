/**
 * Anthropic Provider
 *
 * Monitors Anthropic API usage: token consumption and costs.
 * Kill actions: rotate-creds (manual).
 */

import type { CloudProvider, ServiceUsage } from "../types.js";
import { evaluateViolations, estimateTokenCost, providerFetch } from "../shared.js";

const ANTHROPIC_BASE = "https://api.anthropic.com/v1";

function authHeaders(apiKey: string) {
  return { "x-api-key": apiKey, "anthropic-version": "2023-06-01" };
}

const MODEL_PRICING: Record<string, { input: number; output: number }> = {
  "claude-3.5-sonnet": { input: 3.00, output: 15.00 },
  "claude-3-5-sonnet-20241022": { input: 3.00, output: 15.00 },
  "claude-3-haiku": { input: 0.25, output: 1.25 },
  "claude-3-5-haiku-20241022": { input: 0.80, output: 4.00 },
  "claude-3-opus": { input: 15.00, output: 75.00 },
  "claude-3-sonnet": { input: 3.00, output: 15.00 },
};

export const anthropicProvider: CloudProvider = {
  id: "anthropic",
  name: "Anthropic",

  async checkUsage(credential, thresholds) {
    const key = credential.anthropicApiKey!;
    const headers = authHeaders(key);
    let totalTokens = 0;
    let totalCost = 0;

    try {
      const usage = await providerFetch(ANTHROPIC_BASE, "/usage", headers, "Anthropic");
      for (const entry of usage.data || []) {
        const input = entry.input_tokens || 0;
        const output = entry.output_tokens || 0;
        totalTokens += input + output;
        totalCost += estimateTokenCost(MODEL_PRICING, "claude-3.5-sonnet", entry.model || "claude-3.5-sonnet", input, output);
      }
    } catch {
      try {
        await providerFetch(ANTHROPIC_BASE, "/models", headers, "Anthropic");
      } catch { throw new Error("Failed to connect to Anthropic API"); }
    }

    const services: ServiceUsage[] = [{
      serviceName: "anthropic:api",
      metrics: [
        { name: "Tokens Today", value: totalTokens, unit: "tokens", thresholdKey: "anthropicTokensPerDay" },
      ],
      estimatedDailyCostUSD: totalCost,
    }];

    const violations = evaluateViolations(services, thresholds, totalCost, "anthropicDailyCostUSD", "anthropic-billing", {
      anthropicTokensPerDay: "load",
    });
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
      // Anthropic doesn't have a /models endpoint — validate by sending a minimal
      // count_tokens request which is free and verifies the API key works
      await providerFetch(ANTHROPIC_BASE, "/messages/count_tokens", authHeaders(credential.anthropicApiKey), "Anthropic", "POST", {
        model: "claude-3-haiku-20240307",
        messages: [{ role: "user", content: "test" }],
      });
      return {
        valid: true,
        accountId: credential.anthropicWorkspaceId || "anthropic",
        accountName: "Anthropic Claude API",
      };
    } catch (err: any) {
      // If count_tokens isn't available, a 401/403 means bad key, anything else means key works
      if (err.message?.includes("401") || err.message?.includes("403")) {
        return { valid: false, error: "Invalid API key" };
      }
      // 404 or other errors mean the key authenticated but endpoint isn't available — key is valid
      return {
        valid: true,
        accountId: credential.anthropicWorkspaceId || "anthropic",
        accountName: "Anthropic Claude API",
      };
    }
  },

  getDefaultThresholds() {
    return { anthropicTokensPerDay: 1_000_000, anthropicDailyCostUSD: 50, monthlySpendLimitUSD: 1500 };
  },
};
