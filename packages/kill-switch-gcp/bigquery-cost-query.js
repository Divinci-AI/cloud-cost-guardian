/**
 * BigQuery Billing Export Cost Query
 *
 * Queries the standard GCP billing export tables for past-N-hours spend,
 * grouped by service. Returns total + per-service breakdown.
 *
 * Why BigQuery and not Cloud Billing Budgets API:
 *   - Budgets API only fires monthly-budget alerts and is opaque about
 *     daily-rate trends.
 *   - BigQuery billing export gives line-item, near-real-time data
 *     (typically <12h latency) and can be sliced by any time window.
 *
 * The standard export tables are named:
 *   <project>.<dataset>.gcp_billing_export_resource_v1_<billingAccountId>
 *   <project>.<dataset>.gcp_billing_export_v1_<billingAccountId>
 *
 * The `_resource_v1_` table includes per-resource metadata; the plain
 * `_v1_` is per-service. We default to `_resource_v1_` because it's
 * strictly more useful (it can answer "which Cloud Run service spiked").
 *
 * @license MIT
 */

const { BigQuery } = require("@google-cloud/bigquery");

let cachedClient = null;
function getClient() {
  if (!cachedClient) cachedClient = new BigQuery();
  return cachedClient;
}

/**
 * Build the SQL for a past-N-hours cost query.
 *
 * Exported separately from the runner so unit tests can verify the SQL
 * shape without touching BigQuery.
 *
 * @param {object} opts
 * @param {string} opts.projectId         — GCP project that owns the export dataset
 * @param {string} opts.dataset           — BigQuery dataset name (e.g. "billing_export")
 * @param {string} opts.table             — Full export table name
 * @param {number} opts.windowHours       — How many hours back to sum (e.g. 24)
 * @returns {string}                      — The parameterized SQL string
 */
function buildCostQuerySQL({ projectId, dataset, table, windowHours }) {
  if (!projectId || !dataset || !table) {
    throw new Error("buildCostQuerySQL: projectId, dataset, and table are required");
  }
  if (!Number.isFinite(windowHours) || windowHours <= 0) {
    throw new Error(`buildCostQuerySQL: windowHours must be a positive number, got ${windowHours}`);
  }
  // Backtick-quote identifiers; reject anything that isn't a safe identifier so
  // we don't accept accidental injection from env vars.
  for (const [field, value] of [["projectId", projectId], ["dataset", dataset], ["table", table]]) {
    if (!/^[A-Za-z0-9_\-]+$/.test(value)) {
      throw new Error(`buildCostQuerySQL: ${field} contains unsafe characters: ${value}`);
    }
  }
  return `
    SELECT
      service.description AS service,
      ROUND(SUM(cost), 2) AS cost_usd
    FROM \`${projectId}.${dataset}.${table}\`
    WHERE
      _PARTITIONTIME >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL ${windowHours} HOUR)
      AND usage_start_time >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL ${windowHours} HOUR)
    GROUP BY service
    ORDER BY cost_usd DESC
  `.trim();
}

/**
 * Run the cost query against BigQuery and return the breakdown.
 *
 * @param {object} opts                   — Same shape as buildCostQuerySQL
 * @param {object} [deps]                 — Test-only: inject a fake bq client
 * @returns {Promise<{totalUSD: number, perService: Array<{service: string, costUSD: number}>}>}
 */
async function queryCostBreakdown(opts, deps = {}) {
  const sql = buildCostQuerySQL(opts);
  const bq = deps.bigQueryClient || getClient();
  const [rows] = await bq.query({ query: sql, useLegacySql: false });
  const perService = rows.map((r) => ({
    service: r.service || "unknown",
    costUSD: Number(r.cost_usd) || 0,
  }));
  const totalUSD = perService.reduce((acc, r) => acc + r.costUSD, 0);
  return { totalUSD, perService };
}

module.exports = {
  buildCostQuerySQL,
  queryCostBreakdown,
};
