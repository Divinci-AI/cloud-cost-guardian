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
import { requirePermission } from "../../middleware/permissions.js";
import { logActivity } from "../../services/activity-logger.js";
import { KillSwitchRuleModel } from "../../models/kill-switch-rule/schema.js";
import type { KillSwitchRule } from "../../providers/types.js";

export const rulesRouter = Router();

/**
 * GET /rules — List all rules for the account
 */
rulesRouter.get("/", requirePermission("rules:read"), async (req, res, next) => {
  try {
    const accountId = (req as any).guardianAccountId;
    const docs = await KillSwitchRuleModel.find({ guardianAccountId: accountId }).lean();
    const rules: KillSwitchRule[] = docs.map(docToRule);
    res.json({ rules });
  } catch (e) { next(e); }
});

/**
 * GET /rules/presets — List available preset rule templates
 */
rulesRouter.get("/presets", (_req, res) => {
  res.json({
    presets: [
      { id: "ddos",             name: "DDoS Protection",             description: "Kill services getting excessive request volume",                         category: "security" },
      { id: "brute-force",      name: "Brute Force Protection",      description: "Rotate credentials on mass auth failures",                               category: "security" },
      { id: "cost-runaway",     name: "Cost Runaway Protection",     description: "Disconnect workers exceeding daily cost limit",                          category: "cost" },
      { id: "error-storm",      name: "Error Storm Protection",      description: "Scale down on sustained high error rate",                                category: "reliability" },
      { id: "exfiltration",     name: "Data Exfiltration Detection", description: "Isolate services with unusual egress",                                   category: "security" },
      { id: "gpu-runaway",      name: "GPU Instance Runaway",        description: "Stop unexpected GPU instances (crypto mining, leaked keys)",             category: "cost" },
      { id: "lambda-loop",      name: "Lambda Recursive Loop",       description: "Throttle Lambda functions with runaway concurrency",                     category: "cost" },
      { id: "aws-cost-runaway", name: "AWS Daily Cost Runaway",      description: "Emergency stop when daily AWS spend spikes",                             category: "cost" },
    ],
  });
});

/**
 * POST /rules/presets/:presetId — Apply a preset rule with optional customization
 */
rulesRouter.post("/presets/:presetId", requirePermission("rules:write"), async (req, res, next) => {
  try {
    const accountId = (req as any).guardianAccountId;
    const { presetId } = req.params;
    const customValues = req.body;

    let rule: KillSwitchRule;
    switch (presetId) {
      case "ddos":             rule = PRESET_RULES.ddosProtection(customValues?.requestsPerMinute); break;
      case "brute-force":      rule = PRESET_RULES.bruteForceProtection(customValues?.failuresPerMinute); break;
      case "cost-runaway":     rule = PRESET_RULES.costRunaway(customValues?.dailyCostUSD); break;
      case "error-storm":      rule = PRESET_RULES.errorStorm(customValues?.errorRatePercent); break;
      case "exfiltration":     rule = PRESET_RULES.dataExfiltration(customValues?.egressGBPerHour); break;
      case "gpu-runaway":      rule = PRESET_RULES.gpuRunaway(customValues?.maxGPUInstances); break;
      case "lambda-loop":      rule = PRESET_RULES.lambdaLoop(customValues?.maxConcurrency); break;
      case "aws-cost-runaway": rule = PRESET_RULES.awsCostRunaway(customValues?.dailyCostUSD); break;
      default: return res.status(404).json({ error: `Unknown preset: ${presetId}` });
    }

    await KillSwitchRuleModel.findOneAndUpdate(
      { guardianAccountId: accountId, id: rule.id },
      { ...rule, guardianAccountId: accountId },
      { upsert: true, new: true }
    );

    logActivity({
      orgId: accountId, actorUserId: (req as any).userId, actorEmail: (req as any).auth?.email,
      action: "rule.create", resourceType: "rule", resourceId: rule.id,
      details: { preset: presetId, name: rule.name }, ipAddress: req.ip,
    });

    res.status(201).json({ rule });
  } catch (e) { next(e); }
});

/**
 * POST /rules — Create a custom rule
 */
rulesRouter.post("/", requirePermission("rules:write"), async (req, res, next) => {
  try {
    const accountId = (req as any).guardianAccountId;
    const rule = req.body as KillSwitchRule;

    if (!rule.id || !rule.name || !rule.conditions?.length || !rule.actions?.length) {
      return res.status(400).json({ error: "Rule must have id, name, conditions, and actions" });
    }

    await KillSwitchRuleModel.findOneAndUpdate(
      { guardianAccountId: accountId, id: rule.id },
      { ...rule, guardianAccountId: accountId },
      { upsert: true, new: true }
    );

    logActivity({
      orgId: accountId, actorUserId: (req as any).userId, actorEmail: (req as any).auth?.email,
      action: "rule.create", resourceType: "rule", resourceId: rule.id,
      details: { name: rule.name }, ipAddress: req.ip,
    });

    res.status(201).json({ rule });
  } catch (e) { next(e); }
});

/**
 * PUT /rules/:ruleId — Update a rule
 */
rulesRouter.put("/:ruleId", requirePermission("rules:write"), async (req, res, next) => {
  try {
    const accountId = (req as any).guardianAccountId;
    const existing = await KillSwitchRuleModel.findOne({ guardianAccountId: accountId, id: req.params.ruleId });

    if (!existing) {
      return res.status(404).json({ error: "Rule not found" });
    }

    const updated = await KillSwitchRuleModel.findOneAndUpdate(
      { guardianAccountId: accountId, id: req.params.ruleId },
      { ...req.body, id: existing.id, updatedAt: Date.now() },
      { new: true }
    );

    logActivity({
      orgId: accountId, actorUserId: (req as any).userId, actorEmail: (req as any).auth?.email,
      action: "rule.update", resourceType: "rule", resourceId: req.params.ruleId,
      details: { name: updated?.name }, ipAddress: req.ip,
    });

    res.json({ rule: docToRule(updated!.toObject()) });
  } catch (e) { next(e); }
});

/**
 * DELETE /rules/:ruleId — Delete a rule
 */
rulesRouter.delete("/:ruleId", requirePermission("rules:delete"), async (req, res, next) => {
  try {
    const accountId = (req as any).guardianAccountId;
    const result = await KillSwitchRuleModel.deleteOne({ guardianAccountId: accountId, id: req.params.ruleId });

    logActivity({
      orgId: accountId, actorUserId: (req as any).userId, actorEmail: (req as any).auth?.email,
      action: "rule.delete", resourceType: "rule", resourceId: req.params.ruleId,
      ipAddress: req.ip,
    });

    res.json({ deleted: result.deletedCount > 0 });
  } catch (e) { next(e); }
});

/**
 * POST /rules/:ruleId/toggle — Enable/disable a rule
 */
rulesRouter.post("/:ruleId/toggle", requirePermission("rules:write"), async (req, res, next) => {
  try {
    const accountId = (req as any).guardianAccountId;
    const rule = await KillSwitchRuleModel.findOne({ guardianAccountId: accountId, id: req.params.ruleId });

    if (!rule) {
      return res.status(404).json({ error: "Rule not found" });
    }

    rule.enabled = !rule.enabled;
    await rule.save();

    logActivity({
      orgId: accountId, actorUserId: (req as any).userId, actorEmail: (req as any).auth?.email,
      action: "rule.toggle", resourceType: "rule", resourceId: req.params.ruleId,
      details: { enabled: rule.enabled }, ipAddress: req.ip,
    });

    res.json({ rule: docToRule(rule.toObject()) });
  } catch (e) { next(e); }
});

/**
 * POST /agent/trigger — Agent-initiated kill switch
 */
rulesRouter.post("/agent/trigger", requirePermission("kill_switch:trigger"), async (req, res, next) => {
  try {
    const accountId = (req as any).guardianAccountId;
    const { agentId, threatDescription, severity, recommendedActions, evidence, autoExecute = false } = req.body;

    if (!threatDescription || !recommendedActions) {
      return res.status(400).json({ error: "Missing threatDescription or recommendedActions" });
    }

    const rule: KillSwitchRule = {
      id: `agent-${Date.now()}`,
      name: `Agent Detection: ${threatDescription.substring(0, 50)}`,
      enabled: autoExecute,
      trigger: "agent",
      conditions: [],
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

    await KillSwitchRuleModel.create({ ...rule, guardianAccountId: accountId });

    logActivity({
      orgId: accountId, actorUserId: (req as any).userId, actorEmail: (req as any).auth?.email,
      action: "kill_switch.trigger", resourceType: "rule", resourceId: rule.id,
      details: { agentId, severity, autoExecute, threatDescription }, ipAddress: req.ip,
    });

    res.status(201).json({
      ruleId: rule.id,
      status: autoExecute ? "executing" : "pending_approval",
      message: autoExecute
        ? "Agent-triggered kill switch is executing"
        : "Rule created and awaiting human approval",
      rule,
      evidence,
    });
  } catch (e) { next(e); }
});

/** Strip MongoDB internals from rule documents */
function docToRule(doc: any): KillSwitchRule {
  const { _id, __v, guardianAccountId, createdAt, updatedAt, ...rule } = doc;
  return rule as KillSwitchRule;
}
