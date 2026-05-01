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
import { PRESET_RULES, evaluateRules } from "../../services/rule-engine.js";
import { requirePermission } from "../../middleware/permissions.js";
import { logActivity } from "../../services/activity-logger.js";
import { KillSwitchRuleModel } from "../../models/kill-switch-rule/schema.js";
import { CloudAccountModel } from "../../models/cloud-account/schema.js";
import { getCredential } from "../../models/encrypted-credential/schema.js";
import { getProvider } from "../../providers/index.js";
import type { KillSwitchRule, UsageResult, ServiceUsage } from "../../providers/types.js";

export const rulesRouter = Router();

/**
 * POST /rules/preflight — Simulate a rule against current usage
 *
 * Pure read: no DB writes, no kill actions. Walks every cloud account in the
 * org, runs a fresh checkUsage against each, evaluates the candidate rule,
 * resolves target services, projects cost saved, and surfaces:
 *   - protected-service collisions ("rule would target a protected resource")
 *   - provider-health warnings ("we'd refuse to fire because cloud API is degraded")
 *   - cooldown state ("rule recently fired and is still cooling")
 *
 * Why: the user's KILL_SWITCH_SDK_FEEDBACK_2026_05_01 doc — "before flipping a
 * kill-switch, the SDK should auto-run probes ... and refuse to flip if the
 * baseline already failed." The preflight is the equivalent here.
 *
 * Body: { rule: KillSwitchRule } OR { ruleId: string } (load from DB)
 */
rulesRouter.post("/preflight", requirePermission("rules:read"), async (req, res, next) => {
  try {
    const accountId = (req as any).guardianAccountId;
    let rule: KillSwitchRule | null = null;

    if (req.body?.ruleId) {
      const doc = await KillSwitchRuleModel.findOne({ guardianAccountId: accountId, id: req.body.ruleId }).lean();
      if (!doc) return res.status(404).json({ error: `Rule not found: ${req.body.ruleId}` });
      rule = docToRule(doc);
    } else if (req.body?.rule) {
      rule = req.body.rule as KillSwitchRule;
    }

    if (!rule || !rule.conditions?.length || !rule.actions?.length) {
      return res.status(400).json({ error: "Body must contain rule (or ruleId) with conditions and actions" });
    }

    const cloudAccounts = await CloudAccountModel.find({ guardianAccountId: accountId, status: "active" }).lean();
    // The rule may be disabled in the DB; preflight is a "what-if" so we
    // force enabled+no-cooldown to bypass evaluator filters. We separately
    // surface the saved cooldown state so the operator can see whether a
    // real fire would actually run.
    const wasDisabled = rule.enabled === false;
    const cooldownActive = rule.cooldownMinutes > 0
      && rule.lastFiredAt !== undefined
      && (Date.now() < rule.lastFiredAt + rule.cooldownMinutes * 60 * 1000);
    const cooldownExpiresAt = (rule.lastFiredAt && rule.cooldownMinutes)
      ? rule.lastFiredAt + rule.cooldownMinutes * 60 * 1000
      : undefined;
    const sim: KillSwitchRule = { ...rule, enabled: true, lastFiredAt: undefined };
    const ruleClosure = rule;

    // Run accounts in parallel (bounded concurrency) — sequential was bursting
    // past the Cloud Run 60s timeout for orgs with >5 accounts since each
    // checkUsage can take 5-30s.
    const CONCURRENCY = 5;
    const perAccount: any[] = [];
    for (let i = 0; i < cloudAccounts.length; i += CONCURRENCY) {
      const batch = cloudAccounts.slice(i, i + CONCURRENCY);
      const settled = await Promise.allSettled(batch.map(ca => simulateOneAccount(ca, sim, ruleClosure, cooldownActive)));
      for (let j = 0; j < settled.length; j++) {
        const outcome = settled[j];
        if (outcome.status === "fulfilled") {
          perAccount.push(outcome.value);
        } else {
          perAccount.push({
            cloudAccountId: (batch[j] as any)._id.toString(),
            accountName: (batch[j] as any).name,
            provider: (batch[j] as any).provider,
            error: outcome.reason?.message || String(outcome.reason),
          });
        }
      }
    }

    let totalSavings = 0;
    let triggeredCount = 0;
    let wouldFireCount = 0;
    let collisionCount = 0;
    let degradedCount = 0;
    for (const a of perAccount) {
      if (a.triggered) triggeredCount++;
      if (a.wouldFire) wouldFireCount++;
      if (a.providerHealth && !a.providerHealth.healthy) degradedCount++;
      for (const act of a.actions || []) {
        if (a.wouldFire) totalSavings += act.estimatedDailySavingsUSD;
        collisionCount += (act.protectedCollisions?.length ?? 0);
      }
    }

    res.json({
      rule: { id: rule.id, name: rule.name, wasDisabled, cooldownActive, cooldownExpiresAt },
      perAccount,
      summary: {
        accountsConsidered: cloudAccounts.length,
        accountsTriggered: triggeredCount,
        accountsWouldFire: wouldFireCount,
        totalEstimatedDailySavingsUSD: Math.round(totalSavings * 100) / 100,
        protectedCollisions: collisionCount,
        degradedProviders: degradedCount,
      },
    });
  } catch (e) { next(e); }
});

/**
 * Simulate one cloud account's preflight. Pulled out so the route can run
 * accounts in parallel — sequential was timing out on orgs with >5 accounts.
 */
async function simulateOneAccount(
  cloudAccount: any,
  simRule: KillSwitchRule,
  savedRule: KillSwitchRule,
  cooldownActive: boolean
): Promise<any> {
  const account: any = {
    cloudAccountId: cloudAccount._id.toString(),
    accountName: cloudAccount.name,
    provider: cloudAccount.provider,
  };

  const provider = getProvider(cloudAccount.provider);
  if (!provider) {
    account.error = `Unknown provider: ${cloudAccount.provider}`;
    return account;
  }

  try {
    const credential = await getCredential(cloudAccount.credentialId);
    if (!credential) {
      account.error = "Credential missing";
      return account;
    }

    // Fresh usage snapshot — preflight has to reflect *current* state, not
    // a stale cached snapshot, because the operator is about to make a
    // policy decision based on this output.
    const usage: UsageResult = await provider.checkUsage(credential, cloudAccount.thresholds);

    const [evalResult] = evaluateRules([simRule], usage);
    account.triggered = evalResult?.triggered ?? false;
    account.conditionsMatched = evalResult?.conditionsMatched ?? [];

    if (typeof provider.checkHealth === "function") {
      try {
        account.providerHealth = await provider.checkHealth(credential);
      } catch (e: any) {
        account.providerHealth = { healthy: false, reason: e.message };
      }
    } else {
      account.providerHealth = { healthy: true };
    }

    // Resolve target services per action and project cost saved
    const protectedServices: string[] = cloudAccount.protectedServices || [];
    let anyAwaitingApproval = false;
    account.actions = savedRule.actions.map(action => {
      const target = action.target || "*";
      let resolvedTargets: string[] = [];
      if (target === "*") {
        resolvedTargets = usage.services.map(s => s.serviceName);
      } else {
        const match = usage.services.find(s => s.serviceName === target);
        resolvedTargets = match ? [match.serviceName] : [];
      }
      const protectedCollisions = resolvedTargets.filter(t => protectedServices.includes(t));
      const billable = resolvedTargets.filter(t => !protectedCollisions.includes(t));
      const savings = billable.reduce(
        (sum, name) => sum + (usage.services.find((s: ServiceUsage) => s.serviceName === name)?.estimatedDailyCostUSD ?? 0),
        0
      );
      if (action.requireApproval) anyAwaitingApproval = true;
      return {
        type: action.type,
        target,
        resolvedTargets,
        protectedCollisions,
        estimatedDailySavingsUSD: Math.round(savings * 100) / 100,
        requiresApproval: action.requireApproval || false,
      };
    });

    // The headline number: would the rule, *as saved*, actually fire right
    // now? Triggered alone is misleading because cooldown / health / approval
    // all gate at runtime. Combining them gives the operator the answer they
    // want without having to mentally AND four fields.
    account.wouldFire = account.triggered
      && account.providerHealth.healthy
      && !cooldownActive
      && !anyAwaitingApproval;
    account.wouldNotFireReasons = [];
    if (!account.triggered) account.wouldNotFireReasons.push("conditions-not-matched");
    if (!account.providerHealth.healthy) account.wouldNotFireReasons.push("provider-degraded");
    if (cooldownActive) account.wouldNotFireReasons.push("cooldown-active");
    if (anyAwaitingApproval) account.wouldNotFireReasons.push("awaiting-approval");
  } catch (e: any) {
    account.error = e.message;
  }
  return account;
}

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
