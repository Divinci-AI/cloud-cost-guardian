/**
 * Usage Budget Checker
 *
 * After every monitoring cycle, checks whether any user-defined spend budgets
 * have crossed a threshold in the current period. Fires alerts (email, Slack,
 * PagerDuty, Web Push) at each threshold crossing — edge-triggered so each
 * threshold fires at most once per period. Resets automatically when a new
 * period begins.
 */

import webpush from "web-push";
import { UserBudgetModel, type BudgetPeriod } from "../models/user-budget/schema.js";
import { PushSubscriptionModel } from "../models/push-subscription/schema.js";
import { GuardianAccountModel } from "../models/guardian-account/schema.js";
import { sendAlerts } from "./alerting.js";
import { getPostgresPool } from "../globals/index.js";
import type { AlertChannel } from "../models/guardian-account/schema.js";

const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY?.trim();
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY?.trim();
const VAPID_EMAIL = (process.env.VAPID_EMAIL || "admin@kill-switch.net").trim();

if (VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY) {
  webpush.setVapidDetails(`mailto:${VAPID_EMAIL}`, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
}

/** Returns the start-of-period timestamp (ms) for the current clock period */
export function getPeriodStart(period: BudgetPeriod): number {
  const now = new Date();
  switch (period) {
    case "hour": {
      const d = new Date(now);
      d.setMinutes(0, 0, 0);
      return d.getTime();
    }
    case "day": {
      const d = new Date(now);
      d.setHours(0, 0, 0, 0);
      return d.getTime();
    }
    case "week": {
      const d = new Date(now);
      d.setHours(0, 0, 0, 0);
      d.setDate(d.getDate() - d.getDay()); // back to Sunday
      return d.getTime();
    }
    case "month": {
      return new Date(now.getFullYear(), now.getMonth(), 1).getTime();
    }
    case "year": {
      return new Date(now.getFullYear(), 0, 1).getTime();
    }
  }
}

/** Returns the end-of-period timestamp (ms) */
export function getPeriodEnd(period: BudgetPeriod, periodStart: number): number {
  const d = new Date(periodStart);
  switch (period) {
    case "hour":  d.setHours(d.getHours() + 1); break;
    case "day":   d.setDate(d.getDate() + 1); break;
    case "week":  d.setDate(d.getDate() + 7); break;
    case "month": d.setMonth(d.getMonth() + 1); break;
    case "year":  d.setFullYear(d.getFullYear() + 1); break;
  }
  return d.getTime();
}

/**
 * Estimate total spend (USD) across all cloud accounts for this guardian
 * account since `periodStartMs`. For hourly budgets, scales the latest
 * daily-rate reading to elapsed hours. For longer periods, sums the maximum
 * daily cost per account per day.
 */
async function getPeriodSpend(
  guardianAccountId: string,
  period: BudgetPeriod,
  periodStartMs: number,
): Promise<number> {
  const pool = getPostgresPool();

  if (period === "hour") {
    // Get the most recent daily rate across all accounts and scale to elapsed time.
    const result = await pool.query(
      `SELECT COALESCE(SUM(latest_cost), 0) AS daily_rate
       FROM (
         SELECT cloud_account_id, MAX(estimated_daily_cost_usd) AS latest_cost
         FROM guardian_usage_snapshots
         WHERE guardian_account_id = $1
           AND checked_at >= NOW() - INTERVAL '2 hours'
         GROUP BY cloud_account_id
       ) latest`,
      [guardianAccountId],
    );
    const dailyRate = parseFloat(result.rows[0]?.daily_rate) || 0;
    const hoursElapsed = (Date.now() - periodStartMs) / (1000 * 60 * 60);
    return dailyRate * (hoursElapsed / 24);
  }

  // day/week/month/year: sum MAX daily cost per account per calendar day in the period
  const result = await pool.query(
    `SELECT COALESCE(SUM(account_cost), 0) AS total
     FROM (
       SELECT cloud_account_id, DATE(checked_at) AS day, MAX(estimated_daily_cost_usd) AS account_cost
       FROM guardian_usage_snapshots
       WHERE guardian_account_id = $1
         AND checked_at >= $2
       GROUP BY cloud_account_id, DATE(checked_at)
     ) daily`,
    [guardianAccountId, new Date(periodStartMs).toISOString()],
  );
  return parseFloat(result.rows[0]?.total) || 0;
}

function channelsForBudget(budgetChannels: "all" | string[], allChannels: AlertChannel[]): AlertChannel[] {
  const enabled = allChannels.filter(c => c.enabled);
  if (budgetChannels === "all") return enabled;
  const names = new Set(Array.isArray(budgetChannels) ? budgetChannels : []);
  return enabled.filter(c => names.has(c.name));
}

/** Send a Web Push notification to every registered subscription for this account. */
export async function sendPushToAccount(
  guardianAccountId: string,
  payload: { title: string; body: string; tag?: string; url?: string },
): Promise<void> {
  if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) return;

  const subscriptions = await PushSubscriptionModel.find({ guardianAccountId }).lean();
  if (subscriptions.length === 0) return;

  await Promise.allSettled(
    subscriptions.map(sub =>
      webpush
        .sendNotification(
          { endpoint: sub.endpoint, keys: sub.keys },
          JSON.stringify(payload),
        )
        .catch(async (err: any) => {
          // 410 Gone = subscription expired, clean it up
          if (err.statusCode === 410) {
            await PushSubscriptionModel.deleteOne({ _id: sub._id });
          } else {
            console.warn("[guardian:push] Send failed:", err.message);
          }
        }),
    ),
  );
}

/**
 * Main entry point — called after every monitoring cycle.
 * Checks all enabled budgets for the given guardian account and fires
 * alerts at threshold crossings (edge-triggered, once per period).
 */
export async function checkBudgets(guardianAccountId: string): Promise<void> {
  let budgets;
  try {
    budgets = await UserBudgetModel.find({ guardianAccountId, enabled: true }).lean();
  } catch (e: any) {
    console.warn("[guardian:budget] Failed to load budgets:", e.message);
    return;
  }
  if (budgets.length === 0) return;

  const guardianAccount = await GuardianAccountModel.findById(guardianAccountId).lean();
  if (!guardianAccount) return;

  for (const budget of budgets) {
    try {
      const periodStart = getPeriodStart(budget.period);

      // Period rolled over → reset notified thresholds
      if (periodStart > budget.periodStartedAt) {
        await UserBudgetModel.updateOne(
          { _id: budget._id },
          { $set: { notifiedThresholds: [], periodStartedAt: periodStart } },
        );
        budget.notifiedThresholds = [];
        budget.periodStartedAt = periodStart;
      }

      const spendUsd = await getPeriodSpend(guardianAccountId, budget.period, budget.periodStartedAt);
      const pctUsed = budget.budgetAmountUsd > 0 ? (spendUsd / budget.budgetAmountUsd) * 100 : 0;

      for (const threshold of budget.thresholdPcts) {
        if (pctUsed < threshold) continue;
        if (budget.notifiedThresholds.includes(threshold)) continue;

        const severity =
          threshold >= 100 ? "critical" : threshold >= 90 ? "error" : "warning";
        const periodLabel = budget.period === "hour" ? "hourly" : `${budget.period}ly`;
        const summary =
          `Budget "${budget.name}": ${Math.round(pctUsed)}% of ${periodLabel} budget used ` +
          `($${spendUsd.toFixed(2)} / $${budget.budgetAmountUsd.toFixed(2)})`;

        const channels = channelsForBudget(budget.channels, (guardianAccount as any).alertChannels ?? []);
        if (channels.length > 0) {
          await sendAlerts(channels, summary, severity, {
            budget: budget.name,
            period: budget.period,
            spendUsd: parseFloat(spendUsd.toFixed(2)),
            budgetAmountUsd: budget.budgetAmountUsd,
            pctUsed: Math.round(pctUsed),
            threshold,
          });
        }

        await sendPushToAccount(guardianAccountId, {
          title: `Kill Switch: Budget ${Math.round(pctUsed)}% used`,
          body: summary,
          tag: `budget-${budget.id}-${threshold}`,
          url: "/settings",
        });

        // Mark threshold as notified for this period
        await UserBudgetModel.updateOne(
          { _id: budget._id },
          { $addToSet: { notifiedThresholds: threshold } },
        );
        budget.notifiedThresholds.push(threshold);

        console.error(
          `[guardian:budget] Threshold fired: "${budget.name}" at ${threshold}% ` +
          `($${spendUsd.toFixed(2)} / $${budget.budgetAmountUsd})`,
        );
      }
    } catch (e: any) {
      console.warn(`[guardian:budget] Check failed for budget ${budget.id}:`, e.message);
    }
  }
}

/** Get current period status for all enabled budgets — used by the status API endpoint */
export async function getBudgetStatuses(guardianAccountId: string): Promise<Array<{
  id: string;
  name: string;
  period: string;
  budgetAmountUsd: number;
  thresholdPcts: number[];
  channels: "all" | string[];
  enabled: boolean;
  notifiedThresholds: number[];
  currentSpendUsd: number;
  pctUsed: number;
  periodStartMs: number;
  periodEndMs: number;
}>> {
  const budgets = await UserBudgetModel.find({ guardianAccountId }).lean();
  const statuses = await Promise.all(
    budgets.map(async budget => {
      const periodStart = budget.enabled ? getPeriodStart(budget.period) : budget.periodStartedAt;
      const currentSpendUsd = budget.enabled
        ? await getPeriodSpend(guardianAccountId, budget.period, periodStart)
        : 0;
      const pctUsed = budget.budgetAmountUsd > 0 ? (currentSpendUsd / budget.budgetAmountUsd) * 100 : 0;
      return {
        id: budget.id,
        name: budget.name,
        period: budget.period,
        budgetAmountUsd: budget.budgetAmountUsd,
        thresholdPcts: budget.thresholdPcts,
        channels: budget.channels,
        enabled: budget.enabled,
        notifiedThresholds: budget.notifiedThresholds,
        currentSpendUsd: parseFloat(currentSpendUsd.toFixed(2)),
        pctUsed: parseFloat(pctUsed.toFixed(1)),
        periodStartMs: periodStart,
        periodEndMs: getPeriodEnd(budget.period, periodStart),
      };
    }),
  );
  return statuses;
}
