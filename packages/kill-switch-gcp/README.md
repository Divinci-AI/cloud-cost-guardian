# GCP Billing Kill Switch

**Selectively disable GCP Cloud Run services when spending exceeds budget thresholds.**

A Cloud Function triggered by GCP Budget Alerts via Pub/Sub. When your monthly spend exceeds the configured threshold, it scales down non-protected Cloud Run services and pages PagerDuty.

Unlike "nuclear" approaches that disable all billing (killing everything including free-tier services), this selectively targets Cloud Run while preserving your infrastructure.

## How It Works

```
GCP Budget ($500/mo) → 50%/80%/100% alerts
    ↓
Pub/Sub topic: billing-alerts
    ↓
Cloud Function: gcp-billing-kill-switch
    ↓ (when cost > 80% of budget)
    ├── Scale down non-protected Cloud Run services (max instances → 0)
    ├── Page PagerDuty (critical — calls until acknowledged)
    └── At 50%: Warning alert only (no action)
```

## Quick Start

### 1. Enable required APIs

```bash
gcloud services enable \
  billingbudgets.googleapis.com \
  cloudfunctions.googleapis.com \
  pubsub.googleapis.com \
  eventarc.googleapis.com \
  run.googleapis.com \
  --project=YOUR_PROJECT_ID
```

### 2. Create Pub/Sub topic

```bash
gcloud pubsub topics create billing-alerts --project=YOUR_PROJECT_ID
```

### 3. Create budget with alerts

```bash
gcloud billing budgets create \
  --billing-account=YOUR_BILLING_ACCOUNT_ID \
  --display-name="GCP Kill Switch Budget" \
  --budget-amount=500 \
  --threshold-rule=percent=0.5,basis=current-spend \
  --threshold-rule=percent=0.8,basis=current-spend \
  --threshold-rule=percent=1.0,basis=current-spend \
  --notifications-rule-pubsub-topic=projects/YOUR_PROJECT_ID/topics/billing-alerts \
  --filter-projects="projects/YOUR_PROJECT_ID"
```

### 4. Deploy the Cloud Function

```bash
gcloud functions deploy gcp-billing-kill-switch \
  --gen2 \
  --runtime=nodejs22 \
  --region=us-central1 \
  --source=. \
  --entry-point=killSwitch \
  --trigger-topic=billing-alerts \
  --set-env-vars="GCP_PROJECT_ID=YOUR_PROJECT_ID,GCP_REGION=us-central1,KILL_THRESHOLD=0.8,NUCLEAR_MODE=false,PAGERDUTY_ROUTING_KEY=YOUR_PD_KEY,PROTECTED_SERVICES=my-critical-api" \
  --memory=256MB \
  --timeout=120s \
  --project=YOUR_PROJECT_ID
```

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `GCP_PROJECT_ID` | Required | Your GCP project ID |
| `GCP_REGION` | `us-central1` | Cloud Run region to monitor |
| `KILL_THRESHOLD` | `0.8` | Cost ratio (0-1) at which to take action |
| `NUCLEAR_MODE` | `false` | If `true`, disables all billing (kills everything). If `false`, selectively scales down Cloud Run. |
| `PROTECTED_SERVICES` | (empty) | Semicolon-separated Cloud Run services to never scale down |
| `PAGERDUTY_ROUTING_KEY` | (empty) | PagerDuty Events API v2 integration key for phone alerts |

## What It Does at Each Threshold

| Budget % | Action |
|----------|--------|
| 50% | PagerDuty warning alert (no action) |
| 80%+ | Scale down non-protected Cloud Run services + PagerDuty critical alert |
| Nuclear mode | Disable billing entirely (not recommended) |

## Protected Services

Services listed in `PROTECTED_SERVICES` will never be scaled down, even when the budget is exceeded. Use semicolons as separators:

```bash
PROTECTED_SERVICES=my-api;my-webhook-handler
```

## Daily-Rate Watcher (sibling Cloud Function)

The monthly-budget kill switch above only fires when **monthly** spend crosses a threshold. That misses **runaway daily spikes** — a 24-hour incident can burn thousands while the monthly total is still in the safe zone, so the kill switch never fires until many days later.

The `daily-rate.js` Cloud Function closes that gap. It:

1. Runs on a **Cloud Scheduler** trigger (recommended: hourly).
2. Queries the **BigQuery billing export** for past-24h spend by service.
3. If spend exceeds `DAILY_RATE_THRESHOLD_USD`, publishes to the **same `billing-alerts` Pub/Sub topic** the existing kill switch listens on — so the existing handler runs the usual scale-down + PagerDuty flow.

```
Cloud Scheduler (hourly) → daily-rate watcher → BigQuery billing export
                                ↓ (if past-24h ≥ threshold)
                          Pub/Sub: billing-alerts
                                ↓
                          gcp-billing-kill-switch (existing handler)
                                ↓
                          Scale down + PagerDuty
```

### Prerequisites

You must have **BigQuery billing export** enabled. If you don't:

```bash
# Enable in the Cloud Console:
# https://console.cloud.google.com/billing → Billing account → Billing export
# Create a "Detailed usage cost" export to a BigQuery dataset (e.g. `billing_export`).
# After enabling, the standard table name format is:
#   gcp_billing_export_resource_v1_<billingAccountId-with-dashes-replaced>
```

### Deploy the daily-rate watcher

```bash
# From this package directory:
gcloud functions deploy daily-rate-watcher \
  --gen2 \
  --runtime=nodejs22 \
  --region=us-central1 \
  --source=. \
  --entry-point=dailyRateWatcher \
  --trigger-http \
  --no-allow-unauthenticated \
  --set-env-vars="\
GCP_PROJECT_ID=YOUR_PROJECT_ID,\
BILLING_EXPORT_DATASET=billing_export,\
BILLING_EXPORT_TABLE=gcp_billing_export_resource_v1_01ABCD_234567_8901AB,\
BILLING_ALERTS_TOPIC=billing-alerts,\
DAILY_RATE_THRESHOLD_USD=50" \
  --memory=256MB \
  --timeout=120s \
  --project=YOUR_PROJECT_ID
```

The function's service account needs **`roles/bigquery.dataViewer`** + **`roles/bigquery.jobUser`** on the project that owns the export dataset, plus **`roles/pubsub.publisher`** on the `billing-alerts` topic.

### Wire up Cloud Scheduler

```bash
# Get the function's HTTPS URL
FUNCTION_URL=$(gcloud functions describe daily-rate-watcher \
  --gen2 --region=us-central1 \
  --project=YOUR_PROJECT_ID \
  --format="value(serviceConfig.uri)")

# Create a service account for the scheduler to invoke the function
gcloud iam service-accounts create daily-rate-scheduler \
  --display-name="Daily Rate Scheduler" \
  --project=YOUR_PROJECT_ID

# Grant it permission to invoke the function
gcloud functions add-invoker-policy-binding daily-rate-watcher \
  --gen2 --region=us-central1 \
  --member="serviceAccount:daily-rate-scheduler@YOUR_PROJECT_ID.iam.gserviceaccount.com" \
  --project=YOUR_PROJECT_ID

# Schedule it hourly
gcloud scheduler jobs create http daily-rate-watcher-hourly \
  --location=us-central1 \
  --schedule="0 * * * *" \
  --uri="$FUNCTION_URL" \
  --http-method=POST \
  --max-retry-attempts=3 \
  --max-retry-duration=300s \
  --oidc-service-account-email="daily-rate-scheduler@YOUR_PROJECT_ID.iam.gserviceaccount.com" \
  --project=YOUR_PROJECT_ID
```

> Without `--max-retry-attempts`, Cloud Scheduler defaults to **0 retries** — a single transient BigQuery hiccup silently loses that hour's check.

### ⚠ Self-protection (REQUIRED)

The watcher is deployed as a **gen2** Cloud Function, which means it's also a Cloud Run service named `daily-rate-watcher`. When the watcher publishes a breach, the existing kill switch handler runs `scaleDownCloudRunServices()` against **every** Cloud Run service in the project — and `scaleDownCloudFunctions()` against every Cloud Function.

**If `daily-rate-watcher` is not in `PROTECTED_SERVICES` and `PROTECTED_FUNCTIONS`, it will silently disable itself on the first kill** — and subsequent spikes will go undetected until you manually scale it back up.

Update your existing kill switch deployment to add the watcher (and the kill switch itself) to both protection lists:

```bash
gcloud functions deploy gcp-billing-kill-switch \
  --gen2 --region=us-central1 --project=YOUR_PROJECT_ID \
  --update-env-vars="\
PROTECTED_SERVICES=daily-rate-watcher;gcp-billing-kill-switch;<your-other-protected>,\
PROTECTED_FUNCTIONS=daily-rate-watcher;gcp-billing-kill-switch"
```

### How the threshold interacts with the existing handler

The watcher publishes `costAmount = past-24h spend` and `budgetAmount = DAILY_RATE_THRESHOLD_USD`, then the existing handler computes `costRatio = costAmount / budgetAmount` and only kills if `costRatio >= KILL_THRESHOLD` (default `0.8`).

A daily-rate breach always sends `costRatio ≥ 1.0`, so kill always fires under default config. **But** if you've customized `KILL_THRESHOLD > 1.0`, a daily-rate breach will land in the warning bracket (PagerDuty page only, no scale-down). Keep `KILL_THRESHOLD ≤ 1.0` if you want daily-rate breaches to actually trigger the kill.

The watcher itself is **binary** — it doesn't have a warning level the way the monthly handler does (50% / 80%). It's silent below threshold and fully publishes at/above. If you want a warning-only tier, set a lower-threshold sibling watcher with `DAILY_RATE_DRY_RUN=true` (logs without publishing).

### Daily-rate watcher configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `GCP_PROJECT_ID` | Required | Project that owns the BigQuery billing export dataset |
| `BILLING_EXPORT_DATASET` | Required | BigQuery dataset name (e.g. `billing_export`) |
| `BILLING_EXPORT_TABLE` | Required | Full export table name (`gcp_billing_export_resource_v1_<billingAccountId>`) |
| `BILLING_ALERTS_TOPIC` | `billing-alerts` | Pub/Sub topic to publish breach events to |
| `DAILY_RATE_THRESHOLD_USD` | `50` | Past-24h spend ceiling. Breach when total ≥ threshold |
| `DAILY_RATE_WINDOW_HOURS` | `24` | Lookback window in hours |
| `DAILY_RATE_DRY_RUN` | (unset) | If `"true"`, log what would be published without actually publishing |

### Recommended threshold tuning

- Start at **2× your average daily spend**. Watch for a week. Adjust if it false-fires.
- For an idle / staging project: $25–$50 is a reasonable floor.
- For a busy production project: 1.5–2× p95 daily spend over the last 30 days.

### Local testing

```bash
npm install
npm test
```

The test suite uses [`node:test`](https://nodejs.org/api/test.html) (no extra dependencies) with stubbed BigQuery + Pub/Sub clients. Tests cover:
- BigQuery SQL builder (window-hours, identifier safety, aggregation shape)
- Cost breakdown aggregation (totals, per-service rollup, edge cases)
- Handler decision flow (no breach, breach + publish, dry-run, threshold equality)
- Config-error paths (missing required env, non-numeric / zero / negative threshold, invalid window)
- Failure propagation (BigQuery query errors, Pub/Sub publish errors, SQL identifier safety)

## Part of Kill Switch

This is the GCP component of the [Kill Switch](https://github.com/Divinci-AI/cloudflare-billing-kill-switch) project. See also:

- [Cloudflare Billing Kill Switch](https://github.com/Divinci-AI/cloudflare-billing-kill-switch) — auto-disconnect runaway Cloudflare Workers

## License

MIT
