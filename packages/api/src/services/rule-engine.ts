/**
 * Kill Switch Rule Engine
 *
 * Evaluates configurable rules against usage metrics and security events.
 * Supports:
 * - Programmable rules (API-created)
 * - Agent-triggered rules (AI agent detects anomaly)
 * - Compound conditions (AND/OR logic)
 * - Cooldown periods (don't re-fire within N minutes)
 * - Grace periods (delay action for human review)
 * - Forensic snapshots on trigger
 *
 * Rules can be created via API, dashboard, or by an AI security agent.
 */

import type {
  KillSwitchRule,
  RuleCondition,
  UsageResult,
  SecurityEvent,
  KillAction,
  ForensicSnapshot,
  CloudProvider,
  DecryptedCredential,
} from "../providers/types.js";

export interface RuleEvaluationResult {
  ruleId: string;
  ruleName: string;
  triggered: boolean;
  conditionsMatched: string[];
  actionsToExecute: ExecutableAction[];
  cooldownActive: boolean;
}

export interface ExecutableAction {
  type: KillAction;
  target: string;
  requiresApproval: boolean;
  delaySeconds: number;
  status: "pending" | "approved" | "executed" | "rejected" | "delayed";
}

/**
 * Evaluate all rules against current usage data
 */
export function evaluateRules(
  rules: KillSwitchRule[],
  usage: UsageResult,
  now: number = Date.now()
): RuleEvaluationResult[] {
  return rules
    .filter(r => r.enabled)
    .map(rule => evaluateSingleRule(rule, usage, now));
}

function evaluateSingleRule(
  rule: KillSwitchRule,
  usage: UsageResult,
  now: number
): RuleEvaluationResult {
  // Check cooldown
  if (rule.lastFiredAt && rule.cooldownMinutes > 0) {
    const cooldownEnd = rule.lastFiredAt + rule.cooldownMinutes * 60 * 1000;
    if (now < cooldownEnd) {
      return {
        ruleId: rule.id,
        ruleName: rule.name,
        triggered: false,
        conditionsMatched: [],
        actionsToExecute: [],
        cooldownActive: true,
      };
    }
  }

  // Build metrics map from usage data
  const metricsMap = buildMetricsMap(usage);

  // Evaluate conditions
  const conditionResults = rule.conditions.map(condition => ({
    condition,
    matched: evaluateCondition(condition, metricsMap),
  }));

  const matchedConditions = conditionResults.filter(r => r.matched);
  const triggered = rule.conditionLogic === "all"
    ? matchedConditions.length === rule.conditions.length
    : matchedConditions.length > 0;

  // Build executable actions
  const actionsToExecute: ExecutableAction[] = triggered
    ? rule.actions.map(action => ({
        type: action.type,
        target: action.target || "*",
        requiresApproval: action.requireApproval || false,
        delaySeconds: action.delay || 0,
        status: action.requireApproval ? "pending" as const : "approved" as const,
      }))
    : [];

  return {
    ruleId: rule.id,
    ruleName: rule.name,
    triggered,
    conditionsMatched: matchedConditions.map(r =>
      `${r.condition.metric} ${r.condition.operator} ${r.condition.value}`
    ),
    actionsToExecute,
    cooldownActive: false,
  };
}

function buildMetricsMap(usage: UsageResult): Map<string, number> {
  const map = new Map<string, number>();

  // Aggregate across all services
  let totalRequests = 0;
  let totalErrors = 0;
  let totalCost = usage.totalEstimatedDailyCostUSD;

  for (const service of usage.services) {
    for (const metric of service.metrics) {
      // Per-service metric: "worker-name.DO Requests"
      map.set(`${service.serviceName}.${metric.thresholdKey}`, metric.value);
      // Aggregate metric
      const existing = map.get(metric.thresholdKey) || 0;
      map.set(metric.thresholdKey, existing + metric.value);
    }
    totalRequests += service.metrics.find(m => m.thresholdKey === "workerRequestsPerDay")?.value || 0;
  }

  // Security event counts
  for (const event of usage.securityEvents || []) {
    const key = `security.${event.type}`;
    map.set(key, (map.get(key) || 0) + 1);
    for (const [k, v] of Object.entries(event.metrics)) {
      map.set(`security.${event.type}.${k}`, v);
    }
  }

  map.set("totalEstimatedDailyCostUSD", totalCost);
  map.set("totalRequests", totalRequests);
  map.set("violationCount", usage.violations.length);
  map.set("securityEventCount", (usage.securityEvents || []).length);

  return map;
}

function evaluateCondition(condition: RuleCondition, metrics: Map<string, number>): boolean {
  const value = metrics.get(condition.metric);
  if (value === undefined) return false;

  switch (condition.operator) {
    case "gt": return value > condition.value;
    case "lt": return value < condition.value;
    case "gte": return value >= condition.value;
    case "lte": return value <= condition.value;
    case "eq": return value === condition.value;
    default: return false;
  }
}

// ─── Prebuilt Security Rules ────────────────────────────────────────────────

/**
 * Factory functions for common security kill switch rules
 */
export const PRESET_RULES = {
  /**
   * DDoS Protection: Kill services getting >50K requests/minute
   */
  ddosProtection(requestsPerMinute = 50000): KillSwitchRule {
    return {
      id: "preset-ddos",
      name: "DDoS Protection",
      enabled: true,
      trigger: "security",
      conditions: [
        { metric: "requestsPerMinute", operator: "gt", value: requestsPerMinute, windowMinutes: 5 },
      ],
      conditionLogic: "any",
      actions: [
        { type: "block-traffic", delay: 0 },
        { type: "snapshot" },
      ],
      cooldownMinutes: 15,
      forensicsEnabled: true,
    };
  },

  /**
   * Brute Force Protection: Block after >100 auth failures/minute
   */
  bruteForceProtection(failuresPerMinute = 100): KillSwitchRule {
    return {
      id: "preset-brute-force",
      name: "Brute Force Protection",
      enabled: true,
      trigger: "security",
      conditions: [
        { metric: "authFailuresPerMinute", operator: "gt", value: failuresPerMinute, windowMinutes: 5 },
      ],
      conditionLogic: "any",
      actions: [
        { type: "rotate-creds" },
        { type: "snapshot" },
      ],
      cooldownMinutes: 30,
      forensicsEnabled: true,
    };
  },

  /**
   * Cost Runaway: Kill when daily cost exceeds limit
   */
  costRunaway(dailyCostUSD = 100): KillSwitchRule {
    return {
      id: "preset-cost-runaway",
      name: "Cost Runaway Protection",
      enabled: true,
      trigger: "cost",
      conditions: [
        { metric: "totalEstimatedDailyCostUSD", operator: "gt", value: dailyCostUSD },
      ],
      conditionLogic: "any",
      actions: [
        { type: "disconnect", target: "*" },
        { type: "snapshot" },
      ],
      cooldownMinutes: 60,
      forensicsEnabled: true,
    };
  },

  /**
   * Error Storm: Kill when error rate exceeds 50%
   */
  errorStorm(errorRatePercent = 50): KillSwitchRule {
    return {
      id: "preset-error-storm",
      name: "Error Storm Protection",
      enabled: true,
      trigger: "security",
      conditions: [
        { metric: "errorRatePercent", operator: "gt", value: errorRatePercent, windowMinutes: 5 },
      ],
      conditionLogic: "any",
      actions: [
        { type: "scale-down", delay: 60, requireApproval: true }, // 60s grace + manual approval
        { type: "snapshot" },
      ],
      cooldownMinutes: 15,
      forensicsEnabled: true,
    };
  },

  /**
   * Data Exfiltration: Alert on unusual egress
   */
  dataExfiltration(egressGBPerHour = 10): KillSwitchRule {
    return {
      id: "preset-exfiltration",
      name: "Data Exfiltration Detection",
      enabled: true,
      trigger: "security",
      conditions: [
        { metric: "egressGBPerHour", operator: "gt", value: egressGBPerHour, windowMinutes: 60 },
      ],
      conditionLogic: "any",
      actions: [
        { type: "isolate" },
        { type: "snapshot" },
      ],
      cooldownMinutes: 60,
      forensicsEnabled: true,
    };
  },

  /**
   * GPU Runaway — detect unexpected GPU instances (crypto mining, leaked keys)
   * Default: alert on any GPU instance (threshold 0)
   */
  gpuRunaway(maxGPUInstances = 0): KillSwitchRule {
    return {
      id: "preset-gpu-runaway",
      name: "GPU Instance Runaway",
      enabled: true,
      trigger: "cost",
      conditions: [
        { metric: "ec2GPUInstanceCount", operator: "gt", value: maxGPUInstances },
        { metric: "computeGPUCount", operator: "gt", value: maxGPUInstances },
      ],
      conditionLogic: "any",
      actions: [
        { type: "stop-instances", target: "*" },
        { type: "snapshot" },
      ],
      cooldownMinutes: 30,
      forensicsEnabled: true,
    };
  },

  /**
   * Lambda Loop — detect recursive invocation spirals
   * Default: 500 concurrent executions
   */
  lambdaLoop(maxConcurrency = 500): KillSwitchRule {
    return {
      id: "preset-lambda-loop",
      name: "Lambda Recursive Loop Detection",
      enabled: true,
      trigger: "cost",
      conditions: [
        { metric: "lambdaConcurrentExecutions", operator: "gt", value: maxConcurrency },
      ],
      conditionLogic: "any",
      actions: [
        { type: "throttle-lambda", target: "*" },
        { type: "snapshot" },
      ],
      cooldownMinutes: 15,
      forensicsEnabled: true,
    };
  },

  /**
   * AWS Cost Runaway — emergency stop when daily cost spikes
   * Default: $100/day
   */
  awsCostRunaway(dailyCostUSD = 100): KillSwitchRule {
    return {
      id: "preset-aws-cost-runaway",
      name: "AWS Daily Cost Runaway",
      enabled: true,
      trigger: "cost",
      conditions: [
        { metric: "awsDailyCostUSD", operator: "gt", value: dailyCostUSD },
      ],
      conditionLogic: "any",
      actions: [
        { type: "stop-instances", target: "*" },
        { type: "throttle-lambda", target: "*" },
        { type: "snapshot" },
      ],
      cooldownMinutes: 60,
      forensicsEnabled: true,
    };
  },
};
