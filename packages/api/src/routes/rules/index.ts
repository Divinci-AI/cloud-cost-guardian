/**
 * Kill Switch Rules API
 *
 * CRUD for programmable kill switch rules.
 * Rules can be created via:
 * - Dashboard UI (human-configured)
 * - API (programmatic, CI/CD integration)
 * - Agent (AI security agent detects pattern, creates rule)
 *
 * Includes preset templates for common security scenarios.
 */

import { Router } from "express";
import { PRESET_RULES } from "../../services/rule-engine.js";
import type { KillSwitchRule } from "../../providers/types.js";

export const rulesRouter = Router();

// In-memory rule storage for MVP (move to MongoDB later)
const ruleStore = new Map<string, Map<string, KillSwitchRule>>();

function getAccountRules(accountId: string): Map<string, KillSwitchRule> {
  if (!ruleStore.has(accountId)) {
    ruleStore.set(accountId, new Map());
  }
  return ruleStore.get(accountId)!;
}

/**
 * GET /rules — List all rules for the account
 */
rulesRouter.get("/", (req, res) => {
  const accountId = (req as any).guardianAccountId;
  const rules = Array.from(getAccountRules(accountId).values());
  res.json({ rules });
});

/**
 * GET /rules/presets — List available preset rule templates
 */
rulesRouter.get("/presets", (_req, res) => {
  res.json({
    presets: [
      { id: "ddos", name: "DDoS Protection", description: "Kill services getting excessive request volume", category: "security" },
      { id: "brute-force", name: "Brute Force Protection", description: "Rotate credentials on mass auth failures", category: "security" },
      { id: "cost-runaway", name: "Cost Runaway Protection", description: "Disconnect workers exceeding daily cost limit", category: "cost" },
      { id: "error-storm", name: "Error Storm Protection", description: "Scale down on sustained high error rate", category: "reliability" },
      { id: "exfiltration", name: "Data Exfiltration Detection", description: "Isolate services with unusual egress", category: "security" },
      { id: "gpu-runaway", name: "GPU Instance Runaway", description: "Stop unexpected GPU instances (crypto mining, leaked keys)", category: "cost" },
      { id: "lambda-loop", name: "Lambda Recursive Loop", description: "Throttle Lambda functions with runaway concurrency", category: "cost" },
      { id: "aws-cost-runaway", name: "AWS Daily Cost Runaway", description: "Emergency stop when daily AWS spend spikes", category: "cost" },
    ],
  });
});

/**
 * POST /rules/presets/:presetId — Apply a preset rule with optional customization
 */
rulesRouter.post("/presets/:presetId", (req, res) => {
  const accountId = (req as any).guardianAccountId;
  const { presetId } = req.params;
  const customValues = req.body; // Optional threshold overrides

  let rule: KillSwitchRule;

  switch (presetId) {
    case "ddos":
      rule = PRESET_RULES.ddosProtection(customValues?.requestsPerMinute);
      break;
    case "brute-force":
      rule = PRESET_RULES.bruteForceProtection(customValues?.failuresPerMinute);
      break;
    case "cost-runaway":
      rule = PRESET_RULES.costRunaway(customValues?.dailyCostUSD);
      break;
    case "error-storm":
      rule = PRESET_RULES.errorStorm(customValues?.errorRatePercent);
      break;
    case "exfiltration":
      rule = PRESET_RULES.dataExfiltration(customValues?.egressGBPerHour);
      break;
    case "gpu-runaway":
      rule = PRESET_RULES.gpuRunaway(customValues?.maxGPUInstances);
      break;
    case "lambda-loop":
      rule = PRESET_RULES.lambdaLoop(customValues?.maxConcurrency);
      break;
    case "aws-cost-runaway":
      rule = PRESET_RULES.awsCostRunaway(customValues?.dailyCostUSD);
      break;
    default:
      return res.status(404).json({ error: `Unknown preset: ${presetId}` });
  }

  getAccountRules(accountId).set(rule.id, rule);
  res.status(201).json({ rule });
});

/**
 * POST /rules — Create a custom rule
 */
rulesRouter.post("/", (req, res) => {
  const accountId = (req as any).guardianAccountId;
  const rule = req.body as KillSwitchRule;

  if (!rule.id || !rule.name || !rule.conditions?.length || !rule.actions?.length) {
    return res.status(400).json({ error: "Rule must have id, name, conditions, and actions" });
  }

  getAccountRules(accountId).set(rule.id, rule);
  res.status(201).json({ rule });
});

/**
 * PUT /rules/:ruleId — Update a rule
 */
rulesRouter.put("/:ruleId", (req, res) => {
  const accountId = (req as any).guardianAccountId;
  const rules = getAccountRules(accountId);
  const existing = rules.get(req.params.ruleId);

  if (!existing) {
    return res.status(404).json({ error: "Rule not found" });
  }

  const updated = { ...existing, ...req.body, id: existing.id };
  rules.set(updated.id, updated);
  res.json({ rule: updated });
});

/**
 * DELETE /rules/:ruleId — Delete a rule
 */
rulesRouter.delete("/:ruleId", (req, res) => {
  const accountId = (req as any).guardianAccountId;
  const deleted = getAccountRules(accountId).delete(req.params.ruleId);
  res.json({ deleted });
});

/**
 * POST /rules/:ruleId/toggle — Enable/disable a rule
 */
rulesRouter.post("/:ruleId/toggle", (req, res) => {
  const accountId = (req as any).guardianAccountId;
  const rule = getAccountRules(accountId).get(req.params.ruleId);

  if (!rule) {
    return res.status(404).json({ error: "Rule not found" });
  }

  rule.enabled = !rule.enabled;
  res.json({ rule });
});

/**
 * POST /agent/trigger — Agent-initiated kill switch
 *
 * Called by an AI security agent that detected an anomaly.
 * Accepts a description of the threat and recommended actions.
 * Can create a temporary rule or execute immediate actions.
 */
rulesRouter.post("/agent/trigger", async (req, res, next) => {
  try {
    const accountId = (req as any).guardianAccountId;
    const {
      agentId,
      threatDescription,
      severity,
      recommendedActions,
      evidence,
      autoExecute = false,
    } = req.body;

    if (!threatDescription || !recommendedActions) {
      return res.status(400).json({ error: "Missing threatDescription or recommendedActions" });
    }

    // Create an ephemeral rule from the agent's recommendation
    const rule: KillSwitchRule = {
      id: `agent-${Date.now()}`,
      name: `Agent Detection: ${threatDescription.substring(0, 50)}`,
      enabled: autoExecute,
      trigger: "agent",
      conditions: [], // Agent already evaluated conditions
      conditionLogic: "any",
      actions: recommendedActions.map((action: any) => ({
        type: action.type || "disconnect",
        target: action.target || "*",
        delay: action.delay || 0,
        requireApproval: !autoExecute,
      })),
      cooldownMinutes: 60,
      forensicsEnabled: true,
    };

    getAccountRules(accountId).set(rule.id, rule);

    res.status(201).json({
      ruleId: rule.id,
      status: autoExecute ? "executing" : "pending_approval",
      message: autoExecute
        ? "Agent-triggered kill switch is executing"
        : "Rule created and awaiting human approval",
      rule,
      evidence,
    });
  } catch (e) {
    next(e);
  }
});
