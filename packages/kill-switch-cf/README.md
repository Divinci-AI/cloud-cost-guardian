# Cloudflare Billing Kill Switch

**Auto-disconnect runaway Cloudflare Workers before they generate surprise bills.**

Born from an **$80,000 Durable Objects bill**. Cloudflare has no native spending cap — if a Worker enters a feedback loop or a Durable Object runs away, there's nothing stopping it from draining your account. This Worker is your safety net.

## What It Does

Every 6 hours (configurable), this Worker:

1. Queries Cloudflare's GraphQL Analytics API for per-worker usage
2. Checks Durable Object requests, wall-time, and Worker request volume against your thresholds
3. If any worker exceeds limits:
   - **Alerts** you via PagerDuty (phone call), Discord, Slack, or custom webhook
   - **Auto-disconnects** the offending worker by removing its routes and custom domains
   - Worker code stays intact — just stops receiving traffic (reversible)

```
Normal:     Worker ← Traffic ← Routes/Domains
Kill switch: Worker    Traffic ✗ Routes removed
                       ↑ Code intact, re-enable anytime
```

## Quick Start

### 1. Clone and deploy

```bash
git clone https://github.com/divinci-ai/cloudflare-billing-kill-switch.git
cd cloudflare-billing-kill-switch
npm install
wrangler deploy
```

### 2. Set required secrets

```bash
# Your Cloudflare account ID (from dashboard URL or API)
wrangler secret put CLOUDFLARE_ACCOUNT_ID

# API token with these permissions:
#   - Account Analytics: Read
#   - Account Workers Scripts: Edit
#   - Account Workers Routes: Edit
wrangler secret put CLOUDFLARE_API_TOKEN
```

### 3. Set up alerting (at least one)

```bash
# PagerDuty (recommended for phone calls until acknowledged)
wrangler secret put PAGERDUTY_ROUTING_KEY
# → Get this from: PagerDuty → Services → Your Service → Integrations → Events API V2

# Discord (free, instant notifications)
wrangler secret put DISCORD_WEBHOOK_URL
# → Get this from: Discord → Channel Settings → Integrations → Webhooks → New Webhook

# Slack
wrangler secret put SLACK_WEBHOOK_URL

# Any custom HTTP endpoint
wrangler secret put CUSTOM_WEBHOOK_URL
```

### 4. Test it

```bash
# Verify deployment
curl https://cloudflare-billing-kill-switch.<your-subdomain>.workers.dev/

# View current usage (no alerts)
curl https://cloudflare-billing-kill-switch.<your-subdomain>.workers.dev/usage

# Send a test alert
curl https://cloudflare-billing-kill-switch.<your-subdomain>.workers.dev/test-alert

# Run a full check (will alert if thresholds exceeded)
curl https://cloudflare-billing-kill-switch.<your-subdomain>.workers.dev/check
```

## Configuration

All thresholds are set in `wrangler.toml` under `[vars]`:

| Variable | Default | Description |
|----------|---------|-------------|
| `DO_REQUEST_THRESHOLD` | `1000000` | Max Durable Object requests per day before alerting |
| `DO_WALLTIME_HOURS_THRESHOLD` | `100` | Max DO wall-time hours per day |
| `WORKER_REQUEST_THRESHOLD` | `10000000` | Max Worker requests per day (catches feedback loops) |
| `AUTO_DISCONNECT` | `true` | Auto-remove routes when threshold exceeded (reversible) |
| `AUTO_DELETE` | `false` | Auto-delete worker script (nuclear, irreversible) |
| `PROTECTED_WORKERS` | `cloudflare-billing-kill-switch` | Comma-separated workers to never kill |

### Cron Schedule

Default: every 6 hours. Change in `wrangler.toml`:

```toml
[triggers]
crons = ["*/5 * * * *"]   # Every 5 minutes (aggressive)
crons = ["0 * * * *"]     # Every hour
crons = ["0 */6 * * *"]   # Every 6 hours (default)
crons = ["0 0 * * *"]     # Once daily
```

### Protected Workers

Workers listed in `PROTECTED_WORKERS` will never be disconnected or deleted, even if they exceed thresholds. They'll still trigger alerts so you can investigate manually.

Always include the kill switch itself:

```toml
PROTECTED_WORKERS = "cloudflare-billing-kill-switch,my-critical-api,my-website"
```

## How Auto-Disconnect Works

When a worker exceeds thresholds, the kill switch:

1. **Disables the workers.dev subdomain** — stops traffic via `*.workers.dev` URLs
2. **Removes custom domains** — detaches any custom domains bound to the worker

The worker script, Durable Objects, and KV data are **not** deleted. To restore service:

1. Re-enable workers.dev: `wrangler deploy` (or via dashboard)
2. Re-add custom domains: `wrangler deploy` (routes in wrangler.toml are re-applied)

## API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/` | GET | Health check with current config |
| `/check` | GET | Run usage check now (triggers alerts if needed) |
| `/usage` | GET | View current usage data (no alerts) |
| `/test-alert` | GET | Send test alert to all configured destinations |

## Why This Exists

Cloudflare Workers have **no native spending cap**. Unlike AWS (budget actions) or GCP (billing disable), Cloudflare will happily bill you unlimited amounts with no circuit breaker.

Real incidents from the community:
- **$80,000** Durable Objects bill from runaway containers (us, the authors)
- **$5,000+** from a Worker-Queue feedback loop ([Cloudflare Community](https://community.cloudflare.com/t/worker-queue-feedback-loop-generated-5-000-bill-possibly-20-000/900297))
- **$20,000+** from uncontrolled KV writes ([Hacker News](https://news.ycombinator.com/item?id=47322794))

Cloudflare's only native protection is email-based "usage notifications" that alert you *after* the damage is done. This kill switch actively stops the bleeding.

## Cost

This Worker itself costs nearly nothing:
- 4 cron invocations/day = ~120/month
- Each invocation: 2 GraphQL queries + optional alert webhooks
- Well within the Workers free tier (100K requests/day)

## Required API Token Permissions

Create a [Cloudflare API token](https://dash.cloudflare.com/profile/api-tokens) with:

| Permission | Access | Why |
|------------|--------|-----|
| Account Analytics | Read | Query usage metrics via GraphQL |
| Account Workers Scripts | Edit | Disable workers.dev subdomain |
| Account Workers Routes | Edit | Remove custom domain routes |

If you only want alerting without auto-disconnect, `Account Analytics: Read` is sufficient.

## Alert Integrations

### PagerDuty (recommended for critical alerts)

PagerDuty will **phone call** and **SMS** the on-call person repeatedly until someone acknowledges the incident. Best for preventing $80K bills while you sleep.

1. Create a PagerDuty service → Add "Events API V2" integration
2. Copy the **Integration Key** (not the REST API key)
3. `wrangler secret put PAGERDUTY_ROUTING_KEY`

### Discord

Free, instant push notifications via the Discord mobile app.

1. Server Settings → Integrations → Webhooks → New Webhook
2. Copy webhook URL
3. `wrangler secret put DISCORD_WEBHOOK_URL`

### Slack

1. Create an [Incoming Webhook](https://api.slack.com/messaging/webhooks)
2. Copy webhook URL
3. `wrangler secret put SLACK_WEBHOOK_URL`

### Custom Webhook

Any HTTP endpoint that accepts POST with JSON body:

```json
{
  "summary": "Cloudflare cost alert: 1 worker(s) exceeded thresholds",
  "severity": "critical",
  "details": { "violations": [...], "actionsTaken": [...] },
  "timestamp": "2026-03-22T12:00:00Z",
  "source": "cloudflare-billing-kill-switch"
}
```

## Contributing

PRs welcome! Some ideas:

- [ ] R2 storage monitoring (DOs aren't the only expensive thing)
- [ ] KV/D1/Queue usage monitoring
- [ ] Daily cost estimate reports (email/Discord digest)
- [ ] Dashboard UI (Pages site with historical data)
- [ ] Hysteresis (trigger at 90%, recover at 85% to prevent oscillation)
- [ ] GCP Cloud Run integration (multi-cloud kill switch)

## License

MIT
