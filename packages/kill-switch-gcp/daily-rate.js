/**
 * GCP Daily-Rate Spend Watcher
 *
 * Sibling Cloud Function to `index.js` (the monthly-budget kill switch).
 *
 * Why this exists:
 *   The monthly-budget kill switch fires when monthly spend crosses a
 *   threshold (typically 80% of budget). That misses **runaway daily
 *   spikes** — a 24-hour incident can burn $thousands while the monthly
 *   total is still in the safe zone, so the existing kill switch never
 *   fires until many days later.
 *
 *   This watcher closes that gap by querying the BigQuery billing export
 *   for the past 24h every hour. If past-24h spend exceeds
 *   DAILY_RATE_THRESHOLD_USD, it publishes to the same `billing-alerts`
 *   Pub/Sub topic the existing kill switch listens on, so the existing
 *   handler runs the usual scale-down + PagerDuty flow.
 *
 * Trigger:
 *   Cloud Scheduler → HTTP. Recommended cadence: hourly. The BigQuery
 *   billing export has ~12h latency at the row level, but the running
 *   total updates near-real-time, so hourly polling catches spikes
 *   within the hour they materialize in the export.
 *
 * Required env vars:
 *   GCP_PROJECT_ID                — project that owns the export dataset
 *   BILLING_EXPORT_DATASET        — BigQuery dataset name (e.g. "billing_export")
 *   BILLING_EXPORT_TABLE          — Full table name (e.g. "gcp_billing_export_resource_v1_01ABCD_234567_8901AB")
 *   BILLING_ALERTS_TOPIC          — Pub/Sub topic name (default: "billing-alerts")
 *
 * Optional env vars:
 *   DAILY_RATE_THRESHOLD_USD      — Past-24h spend ceiling (default: 50)
 *   DAILY_RATE_WINDOW_HOURS       — Lookback window (default: 24)
 *   DAILY_RATE_DRY_RUN            — "true" → log what would be published, don't actually publish
 *
 * Local invocation pattern (for testing):
 *   functions-framework --target=dailyRateWatcher --signature-type=http --port=8080
 *   curl http://localhost:8080
 *
 * @license MIT
 */

const { PubSub } = require("@google-cloud/pubsub");
const { queryCostBreakdown } = require("./bigquery-cost-query");

// ── Configuration ───────────────────────────────────────────────────────────

const PROJECT_ID = process.env.GCP_PROJECT_ID;
const BILLING_EXPORT_DATASET = process.env.BILLING_EXPORT_DATASET;
const BILLING_EXPORT_TABLE = process.env.BILLING_EXPORT_TABLE;
const BILLING_ALERTS_TOPIC = process.env.BILLING_ALERTS_TOPIC || "billing-alerts";

const DAILY_RATE_THRESHOLD_USD = parseFloat(process.env.DAILY_RATE_THRESHOLD_USD || "50");
const DAILY_RATE_WINDOW_HOURS = parseFloat(process.env.DAILY_RATE_WINDOW_HOURS || "24");
const DRY_RUN = process.env.DAILY_RATE_DRY_RUN === "true";

let cachedPubSub = null;
function getPubSub() {
  if (!cachedPubSub) cachedPubSub = new PubSub({ projectId: PROJECT_ID });
  return cachedPubSub;
}

// ── HTTP Handler ────────────────────────────────────────────────────────────

/**
 * Cloud Function HTTP entry point. Triggered by Cloud Scheduler.
 *
 * Returns 200 with a JSON summary in all cases (including no-breach +
 * config errors) so Cloud Scheduler doesn't keep retrying transient
 * problems. Real failures (e.g. BigQuery query throws) propagate and
 * Cloud Functions records them in error logs; Cloud Scheduler will
 * retry per its own backoff config.
 */
exports.dailyRateWatcher = async (req, res) => {
  try {
    if (!PROJECT_ID || !BILLING_EXPORT_DATASET || !BILLING_EXPORT_TABLE) {
      const msg = "missing required env: GCP_PROJECT_ID, BILLING_EXPORT_DATASET, BILLING_EXPORT_TABLE";
      console.error(`[daily-rate] ${msg}`);
      res.status(200).json({ status: "config-error", message: msg });
      return;
    }
    // A typo'd numeric env (e.g. DAILY_RATE_THRESHOLD_USD="abc") parses to NaN;
    // `total >= NaN` is always false, which silently disables the watcher.
    // Detect and return config-error instead.
    if (!Number.isFinite(DAILY_RATE_THRESHOLD_USD) || DAILY_RATE_THRESHOLD_USD <= 0) {
      const msg = `invalid DAILY_RATE_THRESHOLD_USD: ${process.env.DAILY_RATE_THRESHOLD_USD} (must be a positive number)`;
      console.error(`[daily-rate] ${msg}`);
      res.status(200).json({ status: "config-error", message: msg });
      return;
    }
    if (!Number.isFinite(DAILY_RATE_WINDOW_HOURS) || DAILY_RATE_WINDOW_HOURS <= 0) {
      const msg = `invalid DAILY_RATE_WINDOW_HOURS: ${process.env.DAILY_RATE_WINDOW_HOURS} (must be a positive number)`;
      console.error(`[daily-rate] ${msg}`);
      res.status(200).json({ status: "config-error", message: msg });
      return;
    }

    const breakdown = await queryCostBreakdown({
      projectId: PROJECT_ID,
      dataset: BILLING_EXPORT_DATASET,
      table: BILLING_EXPORT_TABLE,
      windowHours: DAILY_RATE_WINDOW_HOURS,
    });

    const { totalUSD, perService } = breakdown;
    const threshold = DAILY_RATE_THRESHOLD_USD;
    const breached = totalUSD >= threshold;

    console.log(
      `[daily-rate] window=${DAILY_RATE_WINDOW_HOURS}h total=$${totalUSD.toFixed(2)} ` +
      `threshold=$${threshold.toFixed(2)} breached=${breached} dry-run=${DRY_RUN}`,
    );
    if (perService.length > 0) {
      console.log(`[daily-rate] top 5 services: ${perService.slice(0, 5).map((s) => `${s.service}=$${s.costUSD}`).join(", ")}`);
    }

    if (!breached) {
      res.status(200).json({
        status: "ok",
        breached: false,
        totalUSD,
        thresholdUSD: threshold,
        windowHours: DAILY_RATE_WINDOW_HOURS,
        perService,
      });
      return;
    }

    // Breached — publish to the existing billing-alerts Pub/Sub topic so the
    // monthly-budget kill switch handler runs its usual flow. We shape the
    // payload to look like a budget-overrun event (costAmount + budgetAmount)
    // so the existing handler's threshold logic works without changes.
    const payload = {
      // Budget-shaped fields the existing handler reads:
      costAmount: totalUSD,
      budgetAmount: threshold,
      currencyCode: "USD",
      // Provenance fields so the handler/PagerDuty alert can distinguish
      // this from a real monthly-budget alert:
      source: "daily-rate-watcher",
      windowHours: DAILY_RATE_WINDOW_HOURS,
      perService,
      detectedAt: new Date().toISOString(),
    };

    if (DRY_RUN) {
      console.log(`[daily-rate] DRY RUN — would publish:`, JSON.stringify(payload));
      res.status(200).json({ status: "dry-run-breach", ...payload });
      return;
    }

    const messageBuffer = Buffer.from(JSON.stringify(payload));
    const messageId = await getPubSub()
      .topic(BILLING_ALERTS_TOPIC)
      .publishMessage({ data: messageBuffer });
    console.log(`[daily-rate] published breach to ${BILLING_ALERTS_TOPIC}, messageId=${messageId}`);

    res.status(200).json({
      status: "breach-published",
      messageId,
      ...payload,
    });
  } catch (err) {
    console.error("[daily-rate] handler error:", err);
    // Re-throw so Cloud Functions logs the stack and Scheduler retries per its config
    throw err;
  }
};
