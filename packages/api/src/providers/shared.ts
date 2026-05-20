/**
 * Shared Provider Utilities
 *
 * Common functions used across multiple kill-switch providers.
 */

import type { ServiceUsage, Violation, ThresholdConfig, KillContext, ActionResult, MetricCategory } from "./types.js";

/**
 * Sentinel prefix for ActionResult.details. Lets future investigators answer
 * "why is this resource dead?" by reading a single line — without chasing
 * timestamps back through a check cycle. Idempotent: a re-applied prefix is
 * a no-op so double-wrapping is safe.
 */
export function formatKillSentinel(context?: KillContext): string {
  if (!context) return "";
  const parts: string[] = [];
  if (context.ruleId) parts.push(`rule=${context.ruleId}`);
  if (context.ruleName) parts.push(`name=${context.ruleName.replace(/[\|\]]/g, "_")}`);
  if (context.reason) parts.push(`reason=${context.reason}`);
  parts.push(`at=${context.triggeredAt ?? Date.now()}`);
  return parts.length ? `[ks:${parts.join("|")}] ` : "";
}

/**
 * Idempotently prefix an ActionResult's `details` with the sentinel token.
 * If the details string already starts with `[ks:`, leave it alone.
 */
export function withSentinel(result: ActionResult, context?: KillContext): ActionResult {
  if (!context) return result;
  if (result.details.startsWith("[ks:")) return result;
  const sentinel = formatKillSentinel(context);
  return sentinel ? { ...result, details: sentinel + result.details } : result;
}

/**
 * Build cloud-native label/tag values from a KillContext. Keys are lowercase
 * dashed for GCP-label compatibility (which forbids uppercase + most punct).
 * AWS tag keys allow more characters but match these for cross-cloud parity.
 */
export function killContextToLabels(context: KillContext): Record<string, string> {
  const labels: Record<string, string> = { "kill-switch-killed": "true" };
  if (context.ruleId)   labels["kill-switch-rule-id"] = sanitizeLabelValue(context.ruleId);
  if (context.ruleName) labels["kill-switch-rule-name"] = sanitizeLabelValue(context.ruleName);
  if (context.reason)   labels["kill-switch-reason"] = sanitizeLabelValue(context.reason);
  labels["kill-switch-killed-at"] = String(context.triggeredAt ?? Date.now());
  return labels;
}

/** GCP labels: lowercase, [a-z0-9-_], max 63 chars. AWS tags are looser but accept this subset. */
function sanitizeLabelValue(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9_-]/g, "-").slice(0, 63);
}

/**
 * Evaluate threshold violations across services and daily cost.
 * Used by all providers — avoids duplicating this logic per checker.
 *
 * `categories` is a per-provider lookup mapping each metric.thresholdKey to
 * its high-level MetricCategory. The monitoring engine reads this to decide
 * whether a violation is auto-killable ("cost") or alert-only ("storage" /
 * "load" / "count" / "security"). Pass an empty map for legacy providers
 * not yet migrated — their violations land with category=undefined, which
 * preserves the pre-categorization "kill on any violation" behavior.
 */
export function evaluateViolations(
  services: ServiceUsage[],
  thresholds: ThresholdConfig,
  totalDailyCost: number,
  dailyCostThresholdKey: string,
  billingServiceName: string,
  categories: Record<string, MetricCategory> = {},
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
          category: categories[metric.thresholdKey],
        });
      }
    }
  }
  const costThreshold = thresholds[dailyCostThresholdKey];
  if (costThreshold && totalDailyCost > costThreshold) {
    // Daily-cost violations are by definition cost-category — no lookup needed.
    violations.push({
      serviceName: billingServiceName,
      metricName: "Daily Cost",
      currentValue: totalDailyCost,
      threshold: costThreshold,
      unit: "USD",
      severity: totalDailyCost >= costThreshold * 2 ? "critical" : "warning",
      category: "cost",
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
