/**
 * Database Connections
 *
 * Sets up MongoDB and PostgreSQL connections for the Guardian API.
 * Follows the same patterns as the main Divinci server-globals.
 */

import mongoose from "mongoose";
import type { RuleEvent } from "../providers/types.js";

let mongoConnected = false;

export async function connectMongoDB(): Promise<void> {
  if (mongoConnected) return;

  const uri = process.env.GUARDIAN_MONGODB_URI || process.env.MONGO_CONNECTION_URL;
  if (!uri) {
    console.warn("[guardian] No MongoDB URI configured — using in-memory models only");
    return;
  }

  try {
    await mongoose.connect(uri, {
      maxPoolSize: 10,
      serverSelectionTimeoutMS: 5000,
      socketTimeoutMS: 45000,
    });
    mongoConnected = true;
    console.error("[guardian] Connected to MongoDB");
  } catch (error: any) {
    console.error("[guardian] MongoDB connection failed:", error.message);
    throw error;
  }
}

// PostgreSQL connection for time-series data
// Uses the pg library directly (same as NanoUSDWallet pattern)

import { Pool, type PoolClient } from "pg";

let pgPool: Pool | null = null;

export function getPostgresPool(): Pool {
  if (!pgPool) {
    const connectionString = process.env.GUARDIAN_POSTGRES_URL || process.env.POSTGRES_URL;
    if (!connectionString) {
      throw new Error("No PostgreSQL connection URL configured (GUARDIAN_POSTGRES_URL)");
    }

    pgPool = new Pool({
      connectionString,
      max: 3,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 30000,
    });

    pgPool.on("error", (err) => {
      console.error("[guardian] PostgreSQL pool error:", err.message);
    });
  }
  return pgPool;
}

/**
 * Initialize PostgreSQL tables for usage tracking
 */
export async function initPostgresTables(): Promise<void> {
  const pool = getPostgresPool();

  await pool.query(`
    CREATE TABLE IF NOT EXISTS guardian_usage_snapshots (
      id BIGSERIAL PRIMARY KEY,
      cloud_account_id TEXT NOT NULL,
      guardian_account_id TEXT NOT NULL,
      provider TEXT NOT NULL,
      checked_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      metrics JSONB NOT NULL,
      violations TEXT[],
      actions_taken TEXT[],
      estimated_daily_cost_usd NUMERIC(10,2),
      total_services INTEGER
    );
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_usage_cloud_account
    ON guardian_usage_snapshots(cloud_account_id, checked_at DESC);
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_usage_guardian_account
    ON guardian_usage_snapshots(guardian_account_id, checked_at DESC);
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS guardian_alerts (
      id BIGSERIAL PRIMARY KEY,
      cloud_account_id TEXT NOT NULL,
      guardian_account_id TEXT NOT NULL,
      severity TEXT NOT NULL,
      summary TEXT NOT NULL,
      details JSONB,
      channels_sent TEXT[],
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_alerts_guardian_account
    ON guardian_alerts(guardian_account_id, created_at DESC);
  `);

  // Activity log for audit trail
  await pool.query(`
    CREATE TABLE IF NOT EXISTS activity_log (
      id BIGSERIAL PRIMARY KEY,
      org_id TEXT NOT NULL,
      actor_user_id TEXT NOT NULL,
      actor_email TEXT,
      action TEXT NOT NULL,
      resource_type TEXT NOT NULL,
      resource_id TEXT,
      details JSONB,
      ip_address TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_activity_org
    ON activity_log(org_id, created_at DESC);
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_activity_actor
    ON activity_log(actor_user_id, created_at DESC);
  `);

  // Rule-evaluation telemetry. One row per decision point (evaluated, matched,
  // action_taken, action_skipped). The point isn't to log fire-events — it's
  // to make *non*-fires observable too, so silent rules become a queryable
  // signal rather than a vacuum. Background: KILL_SWITCH_SDK_FEEDBACK_2026_05_01.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS guardian_rule_events (
      id BIGSERIAL PRIMARY KEY,
      guardian_account_id TEXT NOT NULL,
      cloud_account_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      rule_id TEXT,
      rule_name TEXT,
      action_type TEXT,
      target TEXT,
      reason TEXT,
      success BOOLEAN,
      details TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_rule_events_guardian
    ON guardian_rule_events(guardian_account_id, created_at DESC);
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_rule_events_rule
    ON guardian_rule_events(rule_id, created_at DESC);
  `);

  console.error("[guardian] PostgreSQL tables initialized");
}

/**
 * Record a structured rule-evaluation event. Failures are swallowed (logged
 * to stderr) so that telemetry outages never break the monitoring loop.
 */
export async function recordRuleEvent(event: RuleEvent): Promise<void> {
  try {
    const pool = getPostgresPool();
    await pool.query(
      `INSERT INTO guardian_rule_events
       (guardian_account_id, cloud_account_id, kind, rule_id, rule_name, action_type, target, reason, success, details)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        event.guardianAccountId,
        event.cloudAccountId,
        event.kind,
        event.ruleId ?? null,
        event.ruleName ?? null,
        event.actionType ?? null,
        event.target ?? null,
        event.reason ?? null,
        event.success ?? null,
        event.details ?? null,
      ]
    );
  } catch (err: any) {
    console.warn("[guardian] recordRuleEvent failed:", err.message);
  }
}

/**
 * Record a usage snapshot after a monitoring check
 */
export async function recordUsageSnapshot(
  cloudAccountId: string,
  guardianAccountId: string,
  provider: string,
  metrics: Record<string, unknown>,
  violations: string[],
  actionsTaken: string[],
  estimatedDailyCostUSD: number,
  totalServices: number
): Promise<void> {
  const pool = getPostgresPool();
  await pool.query(
    `INSERT INTO guardian_usage_snapshots
     (cloud_account_id, guardian_account_id, provider, metrics, violations, actions_taken, estimated_daily_cost_usd, total_services)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [cloudAccountId, guardianAccountId, provider, JSON.stringify(metrics), violations, actionsTaken, estimatedDailyCostUSD, totalServices]
  );
}

/**
 * Record an alert for audit trail
 */
export async function recordAlert(
  cloudAccountId: string,
  guardianAccountId: string,
  severity: string,
  summary: string,
  details: Record<string, unknown>,
  channelsSent: string[]
): Promise<void> {
  const pool = getPostgresPool();
  await pool.query(
    `INSERT INTO guardian_alerts
     (cloud_account_id, guardian_account_id, severity, summary, details, channels_sent)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [cloudAccountId, guardianAccountId, severity, summary, JSON.stringify(details), channelsSent]
  );
}

/**
 * Get usage history for a cloud account (for dashboard charts)
 */
export async function getUsageHistory(
  cloudAccountId: string,
  days: number = 7
): Promise<any[]> {
  const pool = getPostgresPool();
  const result = await pool.query(
    `SELECT * FROM guardian_usage_snapshots
     WHERE cloud_account_id = $1
     AND checked_at >= NOW() - INTERVAL '1 day' * $2
     ORDER BY checked_at DESC
     LIMIT 500`,
    [cloudAccountId, days]
  );
  return result.rows;
}

/**
 * Get aggregate analytics across all cloud accounts for a guardian account.
 * Returns daily cost totals, projected monthly spend, and savings from kill switch actions.
 */
export async function getAnalyticsOverview(
  guardianAccountId: string,
  days: number = 30
): Promise<{
  dailyCosts: { date: string; cost: number; services: number; violations: number }[];
  totalSpendPeriod: number;
  avgDailyCost: number;
  projectedMonthlyCost: number;
  savingsEstimate: number;
  killSwitchActions: number;
  accountBreakdown: { cloudAccountId: string; provider: string; totalCost: number; avgDailyCost: number }[];
}> {
  const pool = getPostgresPool();

  // Daily aggregated costs across all accounts.
  // Subquery deduplicates per account per day (MAX within each account)
  // so high-frequency checks (5-min intervals) don't inflate totals.
  const dailyResult = await pool.query(
    `SELECT date, SUM(account_cost) AS cost, SUM(account_services) AS services, SUM(account_violations) AS violations
     FROM (
       SELECT
         DATE(checked_at) AS date,
         cloud_account_id,
         MAX(estimated_daily_cost_usd) AS account_cost,
         MAX(total_services) AS account_services,
         COUNT(*) FILTER (WHERE array_length(violations, 1) > 0) AS account_violations
       FROM guardian_usage_snapshots
       WHERE guardian_account_id = $1
         AND checked_at >= NOW() - INTERVAL '1 day' * $2
       GROUP BY DATE(checked_at), cloud_account_id
     ) per_account
     GROUP BY date
     ORDER BY date ASC`,
    [guardianAccountId, days]
  );

  const dailyCosts = dailyResult.rows.map((r: any) => ({
    date: r.date,
    cost: parseFloat(r.cost) || 0,
    services: parseInt(r.services) || 0,
    violations: parseInt(r.violations) || 0,
  }));

  const totalSpendPeriod = dailyCosts.reduce((sum, d) => sum + d.cost, 0);
  const daysWithData = dailyCosts.length || 1;
  const avgDailyCost = totalSpendPeriod / daysWithData;
  const projectedMonthlyCost = avgDailyCost * 30;

  // Count kill switch actions and estimate savings.
  // Deduplicate per account per day to avoid inflating from high-frequency checks.
  const actionsResult = await pool.query(
    `SELECT
       COUNT(*) AS action_count,
       SUM(daily_cost_at_action) AS cost_at_action
     FROM (
       SELECT
         DATE(checked_at) AS date,
         cloud_account_id,
         MAX(estimated_daily_cost_usd) AS daily_cost_at_action
       FROM guardian_usage_snapshots
       WHERE guardian_account_id = $1
         AND checked_at >= NOW() - INTERVAL '1 day' * $2
         AND array_length(actions_taken, 1) > 0
       GROUP BY DATE(checked_at), cloud_account_id
     ) action_days`,
    [guardianAccountId, days]
  );

  const killSwitchActions = parseInt(actionsResult.rows[0]?.action_count) || 0;
  // Conservative savings estimate: daily cost at time of action × 3 days (would have continued)
  const costAtAction = parseFloat(actionsResult.rows[0]?.cost_at_action) || 0;
  const savingsEstimate = costAtAction * 3;

  // Per-account breakdown.
  // Deduplicate per day first so check frequency doesn't inflate totals.
  const breakdownResult = await pool.query(
    `SELECT
       cloud_account_id,
       provider,
       SUM(daily_cost) AS total_cost,
       AVG(daily_cost) AS avg_daily_cost
     FROM (
       SELECT
         cloud_account_id,
         provider,
         DATE(checked_at) AS date,
         MAX(estimated_daily_cost_usd) AS daily_cost
       FROM guardian_usage_snapshots
       WHERE guardian_account_id = $1
         AND checked_at >= NOW() - INTERVAL '1 day' * $2
       GROUP BY cloud_account_id, provider, DATE(checked_at)
     ) daily
     GROUP BY cloud_account_id, provider
     ORDER BY total_cost DESC`,
    [guardianAccountId, days]
  );

  const accountBreakdown = breakdownResult.rows.map((r: any) => ({
    cloudAccountId: r.cloud_account_id,
    provider: r.provider,
    totalCost: parseFloat(r.total_cost) || 0,
    avgDailyCost: parseFloat(r.avg_daily_cost) || 0,
  }));

  return {
    dailyCosts,
    totalSpendPeriod,
    avgDailyCost,
    projectedMonthlyCost,
    savingsEstimate,
    killSwitchActions,
    accountBreakdown,
  };
}

/**
 * Get alert history for a guardian account
 */
export async function getAlertHistory(
  guardianAccountId: string,
  limit: number = 50
): Promise<any[]> {
  const pool = getPostgresPool();
  const result = await pool.query(
    `SELECT * FROM guardian_alerts
     WHERE guardian_account_id = $1
     ORDER BY created_at DESC
     LIMIT $2`,
    [guardianAccountId, limit]
  );
  return result.rows;
}
