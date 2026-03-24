import { describe, it, expect } from "vitest";
import { evaluateRules, PRESET_RULES } from "../../src/services/rule-engine.js";
import type { KillSwitchRule, UsageResult } from "../../src/providers/types.js";

function makeUsageResult(overrides: Partial<UsageResult> = {}): UsageResult {
  return {
    provider: "cloudflare",
    accountId: "test",
    checkedAt: Date.now(),
    services: [],
    totalEstimatedDailyCostUSD: 0,
    violations: [],
    securityEvents: [],
    ...overrides,
  };
}

function makeRule(overrides: Partial<KillSwitchRule> = {}): KillSwitchRule {
  return {
    id: "test-rule",
    name: "Test Rule",
    enabled: true,
    trigger: "cost",
    conditions: [],
    conditionLogic: "any",
    actions: [{ type: "disconnect" }],
    cooldownMinutes: 0,
    forensicsEnabled: false,
    ...overrides,
  };
}

describe("Rule Engine", () => {
  describe("evaluateRules", () => {
    it("returns empty results for no rules", () => {
      const results = evaluateRules([], makeUsageResult());
      expect(results).toHaveLength(0);
    });

    it("skips disabled rules", () => {
      const rule = makeRule({ enabled: false, conditions: [{ metric: "doRequestsPerDay", operator: "gt", value: 0 }] });
      const results = evaluateRules([rule], makeUsageResult());
      expect(results).toHaveLength(0);
    });

    it("triggers rule when condition met (gt operator)", () => {
      const rule = makeRule({
        conditions: [{ metric: "totalEstimatedDailyCostUSD", operator: "gt", value: 50 }],
      });

      const usage = makeUsageResult({ totalEstimatedDailyCostUSD: 100 });
      const results = evaluateRules([rule], usage);

      expect(results[0].triggered).toBe(true);
      expect(results[0].conditionsMatched).toHaveLength(1);
      expect(results[0].actionsToExecute).toHaveLength(1);
      expect(results[0].actionsToExecute[0].type).toBe("disconnect");
    });

    it("does not trigger when condition not met", () => {
      const rule = makeRule({
        conditions: [{ metric: "totalEstimatedDailyCostUSD", operator: "gt", value: 500 }],
      });

      const usage = makeUsageResult({ totalEstimatedDailyCostUSD: 10 });
      const results = evaluateRules([rule], usage);

      expect(results[0].triggered).toBe(false);
      expect(results[0].actionsToExecute).toHaveLength(0);
    });

    it("respects AND logic (all conditions must match)", () => {
      const rule = makeRule({
        conditionLogic: "all",
        conditions: [
          { metric: "totalEstimatedDailyCostUSD", operator: "gt", value: 50 },
          { metric: "violationCount", operator: "gt", value: 0 },
        ],
      });

      // Only cost exceeds, no violations
      const usage = makeUsageResult({ totalEstimatedDailyCostUSD: 100, violations: [] });
      const results = evaluateRules([rule], usage);
      expect(results[0].triggered).toBe(false); // AND: both must match

      // Both conditions met
      const usage2 = makeUsageResult({
        totalEstimatedDailyCostUSD: 100,
        violations: [{ serviceName: "x", metricName: "y", currentValue: 1, threshold: 0, unit: "x", severity: "warning" }],
      });
      const results2 = evaluateRules([rule], usage2);
      expect(results2[0].triggered).toBe(true);
    });

    it("respects OR logic (any condition triggers)", () => {
      const rule = makeRule({
        conditionLogic: "any",
        conditions: [
          { metric: "totalEstimatedDailyCostUSD", operator: "gt", value: 1000 }, // Not met
          { metric: "violationCount", operator: "gt", value: 0 }, // Met
        ],
      });

      const usage = makeUsageResult({
        totalEstimatedDailyCostUSD: 10,
        violations: [{ serviceName: "x", metricName: "y", currentValue: 1, threshold: 0, unit: "x", severity: "warning" }],
      });

      const results = evaluateRules([rule], usage);
      expect(results[0].triggered).toBe(true); // OR: one is enough
    });

    it("respects cooldown period", () => {
      const now = Date.now();
      const rule = makeRule({
        cooldownMinutes: 60,
        lastFiredAt: now - 30 * 60 * 1000, // Fired 30 min ago
        conditions: [{ metric: "totalEstimatedDailyCostUSD", operator: "gt", value: 0 }],
      });

      const usage = makeUsageResult({ totalEstimatedDailyCostUSD: 100 });
      const results = evaluateRules([rule], usage, now);

      expect(results[0].triggered).toBe(false);
      expect(results[0].cooldownActive).toBe(true);
    });

    it("fires after cooldown expires", () => {
      const now = Date.now();
      const rule = makeRule({
        cooldownMinutes: 60,
        lastFiredAt: now - 90 * 60 * 1000, // Fired 90 min ago (cooldown expired)
        conditions: [{ metric: "totalEstimatedDailyCostUSD", operator: "gt", value: 0 }],
      });

      const usage = makeUsageResult({ totalEstimatedDailyCostUSD: 100 });
      const results = evaluateRules([rule], usage, now);

      expect(results[0].triggered).toBe(true);
      expect(results[0].cooldownActive).toBe(false);
    });

    it("marks actions as pending when requireApproval is set", () => {
      const rule = makeRule({
        conditions: [{ metric: "totalEstimatedDailyCostUSD", operator: "gt", value: 0 }],
        actions: [{ type: "disconnect", requireApproval: true }],
      });

      const usage = makeUsageResult({ totalEstimatedDailyCostUSD: 100 });
      const results = evaluateRules([rule], usage);

      expect(results[0].actionsToExecute[0].status).toBe("pending");
      expect(results[0].actionsToExecute[0].requiresApproval).toBe(true);
    });

    it("evaluates per-service metrics", () => {
      const rule = makeRule({
        conditions: [{ metric: "bad-worker.doRequestsPerDay", operator: "gt", value: 1_000_000 }],
      });

      const usage = makeUsageResult({
        services: [{
          serviceName: "bad-worker",
          metrics: [{ name: "DO Requests", value: 5_000_000, unit: "requests", thresholdKey: "doRequestsPerDay" }],
          estimatedDailyCostUSD: 10,
        }],
      });

      const results = evaluateRules([rule], usage);
      expect(results[0].triggered).toBe(true);
    });

    it("evaluates security event counts", () => {
      const rule = makeRule({
        trigger: "security",
        conditions: [{ metric: "securityEventCount", operator: "gt", value: 0 }],
      });

      const usage = makeUsageResult({
        securityEvents: [{
          type: "request_spike",
          severity: "critical",
          serviceName: "api",
          description: "50K req/min spike",
          metrics: { requestsPerMinute: 50000 },
          detectedAt: Date.now(),
        }],
      });

      const results = evaluateRules([rule], usage);
      expect(results[0].triggered).toBe(true);
    });

    it("supports all operators (gt, lt, gte, lte, eq)", () => {
      const usage = makeUsageResult({ totalEstimatedDailyCostUSD: 50 });

      const test = (op: string, value: number, expected: boolean) => {
        const rule = makeRule({ conditions: [{ metric: "totalEstimatedDailyCostUSD", operator: op as any, value }] });
        return evaluateRules([rule], usage)[0].triggered === expected;
      };

      expect(test("gt", 40, true)).toBe(true);   // 50 > 40
      expect(test("gt", 60, false)).toBe(true);   // 50 > 60
      expect(test("lt", 60, true)).toBe(true);    // 50 < 60
      expect(test("lt", 40, false)).toBe(true);   // 50 < 40
      expect(test("gte", 50, true)).toBe(true);   // 50 >= 50
      expect(test("gte", 51, false)).toBe(true);  // 50 >= 51
      expect(test("lte", 50, true)).toBe(true);   // 50 <= 50
      expect(test("lte", 49, false)).toBe(true);  // 50 <= 49
      expect(test("eq", 50, true)).toBe(true);    // 50 == 50
      expect(test("eq", 51, false)).toBe(true);   // 50 == 51
    });
  });

  describe("Preset Rules", () => {
    it("DDoS Protection preset has correct defaults", () => {
      const rule = PRESET_RULES.ddosProtection();
      expect(rule.conditions[0].metric).toBe("requestsPerMinute");
      expect(rule.conditions[0].value).toBe(50000);
      expect(rule.actions[0].type).toBe("block-traffic");
      expect(rule.forensicsEnabled).toBe(true);
    });

    it("DDoS Protection accepts custom threshold", () => {
      const rule = PRESET_RULES.ddosProtection(10000);
      expect(rule.conditions[0].value).toBe(10000);
    });

    it("Brute Force preset rotates credentials", () => {
      const rule = PRESET_RULES.bruteForceProtection();
      expect(rule.actions[0].type).toBe("rotate-creds");
      expect(rule.conditions[0].metric).toBe("authFailuresPerMinute");
    });

    it("Cost Runaway preset disconnects workers", () => {
      const rule = PRESET_RULES.costRunaway(200);
      expect(rule.conditions[0].value).toBe(200);
      expect(rule.actions[0].type).toBe("disconnect");
      expect(rule.actions[0].target).toBe("*");
    });

    it("Error Storm preset requires approval with delay", () => {
      const rule = PRESET_RULES.errorStorm();
      expect(rule.actions[0].requireApproval).toBe(true);
      expect(rule.actions[0].delay).toBe(60);
    });

    it("Data Exfiltration preset isolates service", () => {
      const rule = PRESET_RULES.dataExfiltration();
      expect(rule.actions[0].type).toBe("isolate");
      expect(rule.cooldownMinutes).toBe(60);
    });

    it("GPU Runaway preset stops instances on any GPU", () => {
      const rule = PRESET_RULES.gpuRunaway();
      expect(rule.conditions[0].metric).toBe("ec2GPUInstanceCount");
      expect(rule.conditions[0].value).toBe(0);
      expect(rule.conditions[1].metric).toBe("computeGPUCount");
      expect(rule.actions[0].type).toBe("stop-instances");
      expect(rule.forensicsEnabled).toBe(true);
    });

    it("GPU Runaway preset accepts custom threshold", () => {
      const rule = PRESET_RULES.gpuRunaway(4);
      expect(rule.conditions[0].value).toBe(4);
      expect(rule.conditions[1].value).toBe(4);
    });

    it("Lambda Loop preset throttles on high concurrency", () => {
      const rule = PRESET_RULES.lambdaLoop();
      expect(rule.conditions[0].metric).toBe("lambdaConcurrentExecutions");
      expect(rule.conditions[0].value).toBe(500);
      expect(rule.actions[0].type).toBe("throttle-lambda");
    });

    it("Lambda Loop preset accepts custom concurrency", () => {
      const rule = PRESET_RULES.lambdaLoop(100);
      expect(rule.conditions[0].value).toBe(100);
    });

    it("AWS Cost Runaway preset stops instances and throttles lambdas", () => {
      const rule = PRESET_RULES.awsCostRunaway();
      expect(rule.conditions[0].metric).toBe("awsDailyCostUSD");
      expect(rule.conditions[0].value).toBe(100);
      expect(rule.actions[0].type).toBe("stop-instances");
      expect(rule.actions[1].type).toBe("throttle-lambda");
      expect(rule.actions[2].type).toBe("snapshot");
    });

    it("AWS Cost Runaway preset accepts custom daily limit", () => {
      const rule = PRESET_RULES.awsCostRunaway(500);
      expect(rule.conditions[0].value).toBe(500);
    });

    it("All presets have forensics enabled", () => {
      expect(PRESET_RULES.ddosProtection().forensicsEnabled).toBe(true);
      expect(PRESET_RULES.bruteForceProtection().forensicsEnabled).toBe(true);
      expect(PRESET_RULES.costRunaway().forensicsEnabled).toBe(true);
      expect(PRESET_RULES.errorStorm().forensicsEnabled).toBe(true);
      expect(PRESET_RULES.dataExfiltration().forensicsEnabled).toBe(true);
      expect(PRESET_RULES.gpuRunaway().forensicsEnabled).toBe(true);
      expect(PRESET_RULES.lambdaLoop().forensicsEnabled).toBe(true);
      expect(PRESET_RULES.awsCostRunaway().forensicsEnabled).toBe(true);
    });

    it("All presets include a snapshot action", () => {
      const hasSnapshot = (rule: KillSwitchRule) => rule.actions.some(a => a.type === "snapshot");
      expect(hasSnapshot(PRESET_RULES.ddosProtection())).toBe(true);
      expect(hasSnapshot(PRESET_RULES.bruteForceProtection())).toBe(true);
      expect(hasSnapshot(PRESET_RULES.costRunaway())).toBe(true);
      expect(hasSnapshot(PRESET_RULES.errorStorm())).toBe(true);
      expect(hasSnapshot(PRESET_RULES.dataExfiltration())).toBe(true);
      expect(hasSnapshot(PRESET_RULES.gpuRunaway())).toBe(true);
      expect(hasSnapshot(PRESET_RULES.lambdaLoop())).toBe(true);
      expect(hasSnapshot(PRESET_RULES.awsCostRunaway())).toBe(true);
    });
  });
});
