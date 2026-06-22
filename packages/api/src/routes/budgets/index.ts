/**
 * Usage Budget Routes
 *
 * CRUD for per-account spend budgets plus a live status endpoint.
 * Budget checks are driven by the monitoring engine after each cycle.
 */

import { Router } from "express";
import { UserBudgetModel } from "../../models/user-budget/schema.js";
import { requirePermission } from "../../middleware/permissions.js";
import { getBudgetStatuses } from "../../services/budget-checker.js";

export const budgetsRouter = Router();

const VALID_PERIODS = new Set(["hour", "day", "week", "month", "year"]);

const BUDGET_LIMITS: Record<string, number> = {
  free: 2, pro: 10, team: 25, enterprise: Infinity,
};

/** GET /budgets — list all budgets for this account */
budgetsRouter.get("/", requirePermission("settings:read"), async (req, res, next) => {
  try {
    const guardianAccountId = (req as any).guardianAccountId;
    const budgets = await UserBudgetModel.find({ guardianAccountId }).sort({ createdAt: 1 }).lean();
    res.json({ budgets: budgets.map(stripInternals) });
  } catch (e) { next(e); }
});

/** GET /budgets/status — live period spend vs. each budget */
budgetsRouter.get("/status", requirePermission("settings:read"), async (req, res, next) => {
  try {
    const guardianAccountId = (req as any).guardianAccountId;
    const statuses = await getBudgetStatuses(guardianAccountId);
    res.json({ budgets: statuses });
  } catch (e) { next(e); }
});

/** POST /budgets — create a budget */
budgetsRouter.post("/", requirePermission("settings:write"), async (req, res, next) => {
  try {
    const guardianAccountId = (req as any).guardianAccountId;

    // Tier limit check
    const { GuardianAccountModel } = await import("../../models/guardian-account/schema.js");
    const account = await GuardianAccountModel.findById(guardianAccountId).lean();
    if (!account) return res.status(404).json({ error: "Account not found" });
    const limit = BUDGET_LIMITS[(account as any).tier] ?? 2;
    const existing = await UserBudgetModel.countDocuments({ guardianAccountId });
    if (existing >= limit) {
      return res.status(403).json({
        error: `Your ${(account as any).tier} plan allows ${limit} budget(s). Upgrade to add more.`,
        currentTier: (account as any).tier,
        limit,
      });
    }

    const { name, period, budgetAmountUsd, thresholdPcts, channels } = req.body;
    if (!name || typeof name !== "string") return res.status(400).json({ error: "name is required" });
    if (!VALID_PERIODS.has(period)) return res.status(400).json({ error: "period must be one of: hour, day, week, month, year" });
    if (typeof budgetAmountUsd !== "number" || budgetAmountUsd <= 0 || budgetAmountUsd > 10_000_000) {
      return res.status(400).json({ error: "budgetAmountUsd must be between $0.01 and $10,000,000" });
    }

    const parsedThresholds = Array.isArray(thresholdPcts)
      ? thresholdPcts.filter((n: unknown) => typeof n === "number" && n >= 1 && n <= 200)
      : [75, 90, 100];

    const { getPeriodStart } = await import("../../services/budget-checker.js");
    const budget = await UserBudgetModel.create({
      guardianAccountId,
      name: String(name).trim().slice(0, 80),
      period,
      budgetAmountUsd,
      thresholdPcts: parsedThresholds,
      channels: channels === "all" || !Array.isArray(channels) ? "all" : channels.map(String),
      enabled: true,
      notifiedThresholds: [],
      periodStartedAt: getPeriodStart(period),
    });

    res.status(201).json({ budget: stripInternals(budget.toObject()) });
  } catch (e) { next(e); }
});

/** PATCH /budgets/:id — update a budget */
budgetsRouter.patch("/:id", requirePermission("settings:write"), async (req, res, next) => {
  try {
    const guardianAccountId = (req as any).guardianAccountId;
    const budget = await UserBudgetModel.findOne({ id: req.params.id, guardianAccountId });
    if (!budget) return res.status(404).json({ error: "Budget not found" });

    const { name, period, budgetAmountUsd, thresholdPcts, channels, enabled } = req.body;
    if (name !== undefined) budget.name = String(name).trim().slice(0, 80);
    if (period !== undefined) {
      if (!VALID_PERIODS.has(period)) return res.status(400).json({ error: "Invalid period" });
      budget.period = period;
    }
    if (budgetAmountUsd !== undefined) {
      if (typeof budgetAmountUsd !== "number" || budgetAmountUsd <= 0) return res.status(400).json({ error: "Invalid budgetAmountUsd" });
      budget.budgetAmountUsd = budgetAmountUsd;
    }
    if (Array.isArray(thresholdPcts)) {
      budget.thresholdPcts = thresholdPcts.filter((n: unknown) => typeof n === "number" && n > 0 && n <= 200);
    }
    if (channels !== undefined) {
      budget.channels = channels === "all" || !Array.isArray(channels) ? "all" : channels.map(String);
    }
    if (typeof enabled === "boolean") budget.enabled = enabled;

    await budget.save();
    res.json({ budget: stripInternals(budget.toObject()) });
  } catch (e) { next(e); }
});

/** DELETE /budgets/:id — delete a budget */
budgetsRouter.delete("/:id", requirePermission("settings:write"), async (req, res, next) => {
  try {
    const guardianAccountId = (req as any).guardianAccountId;
    const deleted = await UserBudgetModel.deleteOne({ id: req.params.id, guardianAccountId });
    if (deleted.deletedCount === 0) return res.status(404).json({ error: "Budget not found" });
    res.json({ deleted: true });
  } catch (e) { next(e); }
});

function stripInternals(b: any) {
  const { _id, __v, notifiedThresholds: _n, ...rest } = b;
  return rest;
}
