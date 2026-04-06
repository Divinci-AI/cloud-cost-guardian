/**
 * Shared Provider Utilities
 *
 * Common functions used across multiple kill-switch providers.
 */

import type { ServiceUsage, Violation, ThresholdConfig } from "./types.js";

/**
 * Evaluate threshold violations across services and daily cost.
 * Used by all providers — avoids duplicating this logic per checker.
 */
export function evaluateViolations(
  services: ServiceUsage[],
  thresholds: ThresholdConfig,
  totalDailyCost: number,
  dailyCostThresholdKey: string,
  billingServiceName: string
): Violation[] {
  const violations: Violation[] = [];
  for (const service of services) {
    for (const metric of service.metrics) {
      if (!metric.thresholdKey) continue;
      const threshold = thresholds[metric.thresholdKey];
      if (threshold !== undefined && metric.value > threshold) {
        violations.push({
          serviceName: service.serviceName,
          metricName: metric.name,
          currentValue: metric.value,
          threshold,
          unit: metric.unit,
          severity: metric.value >= threshold * 2 ? "critical" : "warning",
        });
      }
    }
  }
  const costThreshold = thresholds[dailyCostThresholdKey];
  if (costThreshold && totalDailyCost > costThreshold) {
    violations.push({
      serviceName: billingServiceName,
      metricName: "Daily Cost",
      currentValue: totalDailyCost,
      threshold: costThreshold,
      unit: "USD",
      severity: totalDailyCost >= costThreshold * 2 ? "critical" : "warning",
    });
  }
  return violations;
}

/**
 * Token cost estimator for AI/LLM providers.
 * Looks up model pricing, falls back to default, and guards against NaN.
 */
export function estimateTokenCost(
  pricingTable: Record<string, { input: number; output: number }>,
  defaultModel: string,
  model: string,
  inputTokens: number,
  outputTokens: number
): number {
  const pricing = pricingTable[model] || pricingTable[defaultModel];
  if (!pricing) return 0;
  const cost = (Number(inputTokens) * pricing.input + Number(outputTokens) * pricing.output) / 1_000_000;
  return isFinite(cost) ? cost : 0;
}

/**
 * Authenticated fetch with timeout and sanitized errors.
 * Used by providers that call REST APIs.
 */
export async function providerFetch(
  baseUrl: string,
  path: string,
  headers: Record<string, string>,
  providerName: string,
  method = "GET",
  body?: any,
  timeoutMs = 30000
): Promise<any> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const resp = await fetch(`${baseUrl}${path}`, {
      method,
      headers: { "Content-Type": "application/json", ...headers },
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
    if (!resp.ok) {
      console.error(`[guardian] ${providerName} API error: ${resp.status}`);
      throw new Error(`${providerName} API error: ${resp.status}`);
    }
    return resp.json();
  } catch (err: any) {
    if (err.name === "AbortError") {
      throw new Error(`${providerName} API timeout after ${timeoutMs}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}
