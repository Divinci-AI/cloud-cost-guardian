# Cloudflare Billing Kill Switch

**Auto-disconnect runaway Cloudflare Workers before they generate surprise bills.**

Born from an **$80,000 Durable Objects bill**. Cloudflare has no native spending cap — if a Worker enters a feedback loop or a Durable Object runs away, there's nothing stopping it from draining your account. This Worker is your safety net.

## What It Does

Every 6 hours (configurable), this Worker:

1. Queries Cloudflare's GraphQL Analytics API for per-worker usage (in two batched
   requests — see [Coverage](#coverage) — to stay under the GraphQL rate limit)
2. Checks Durable Objects, Workers, R2, D1, **Workers AI (Neurons)**, **AI Gateway
   (upstream LLM $)**, and **Vectorize** against your thresholds
3. If any resource exceeds its **alert** threshold:
   - **Alerts** you via PagerDuty (phone call), Discord, Slack, or custom webhook
     (webhook alerts are de-duped within a cooldown window so a daily-cumulative
     breach doesn't re-fire every cron tick)
   - **Auto-disconnects** the offending worker — only if it also crosses the
     **kill** threshold (`DISCONNECT_THRESHOLD_MULTIPLIER`× the alert threshold) —
     by removing its zone routes, custom domains, and workers.dev subdomain
   - Worker code stays intact — just stops receiving traffic (reversible)

### Coverage

| Service | Dataset | Action |
|---------|---------|--------|
| Durable Objects | `durableObjectsInvocationsAdaptiveGroups` | alert + disconnect/delete |
| Workers | `workersInvocationsAdaptive` | alert + disconnect |
| R2 | `r2StorageAdaptiveGroups` | alert + delete (opt-in) |
| D1 | `d1AnalyticsAdaptiveGroups` | alert + delete (opt-in) |
| **Workers AI** | `aiInferenceAdaptiveGroups` (Neurons) | **alert only** — no CF throttle API; mitigate in-app |
| **AI Gateway** | `aiGatewayRequestsAdaptiveGroups` (`sum.cost`) | **alert only** — catches upstream OpenAI/Anthropic/Gemini $ |
| **Vectorize** | `vectorizeQueriesAdaptiveGroups` | **alert only** |

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
#   - Account > Account Analytics: Read   (monitoring — without it, the CF half reads EMPTY and you're silently blind)
#   - Account > Workers Scripts: Edit      (auto-disconnect: subdomain + custom domains)
#   - Zone > Workers Routes: Edit          (auto-disconnect: zone [[routes]] removal)
#   - Zone > Zone: Read                    (enumerate zones to find routes to remove)
wrangler secret put CLOUDFLARE_API_TOKEN

# Bearer token gating /check, /usage, /test-alert. REQUIRED — these endpoints
# FAIL CLOSED (refuse) if ADMIN_SECRET is unset, since /check can take destructive
# actions and /test-alert can be spammed.
wrangler secret put ADMIN_SECRET
```

### (Recommended) Enable alert de-dup + kill snapshots

```bash
# One-time: create the KV namespace, then paste the id into wrangler.toml
# under the commented-out [[kv_namespaces]] block (binding = "ALERT_STATE").
wrangler kv namespace create ALERT_STATE
```

Without this binding, webhook alerts cannot be de-duped and will re-fire on every
cron tick once a daily-cumulative threshold is crossed.

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
| `AI_NEURONS_THRESHOLD` | `500000` | Max Workers AI Neurons/day (~$5.50) — alert only |
| `AI_GATEWAY_COST_THRESHOLD` | `10` | Max AI Gateway upstream $/day — alert only |
| `VECTORIZE_DIMENSIONS_THRESHOLD` | `100000000` | Max Vectorize queried dimensions/day (~$1) — alert only |
| `DISCONNECT_THRESHOLD_MULTIPLIER` | `10` | Kill only above N× the alert threshold (set `1` for alert==kill) |
| `ALERT_COOLDOWN_SECONDS` | `21600` | Webhook alert de-dup window (needs `ALERT_STATE` KV) |
| `AUTO_DISCONNECT` | `true` | Auto-remove routes/domains when kill threshold exceeded (reversible) |
| `AUTO_DELETE` | `false` | Auto-delete worker script (nuclear, irreversible) |
| `PROTECTED_WORKERS` | `cloudflare-billing-kill-switch` | Comma-separated workers to never kill |

### Alert threshold vs. kill threshold

Alerts fire at **1×** the thresholds above. Auto-disconnect/delete only fire above
**`DISCONNECT_THRESHOLD_MULTIPLIER`×** (default 10×). This prevents a cheap-but-busy
service — e.g. a 1.5M-req/day voice-agent Durable Object that costs ~$0.23/day — from
being auto-killed off a low alert floor. A breach between 1× and the kill threshold is
reported as `[alert-only]`; above it as `[KILL-ELIGIBLE]`. Set the multiplier to `1`
to restore the old behavior where alerting and killing share one threshold.

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

When a worker crosses the **kill** threshold, the kill switch:

1. **Disables the workers.dev subdomain** — stops traffic via `*.workers.dev` URLs
2. **Removes custom domains** — detaches any custom domains bound to the worker
3. **Removes zone Workers Routes** — deletes `[[routes]]` patterns across the
   account's zones (requires `Zone: Read` + `Workers Routes: Edit`). A worker
   served only via a zone route would otherwise keep receiving traffic.

The worker script, Durable Objects, and KV data are **not** deleted. If `ALERT_STATE`
is bound, a forensic snapshot of what was removed (domains + routes) is written to KV
under `kill:<script>` (30-day TTL) so the disconnect can be reversed.

### Restoring a false positive

```bash
curl -H "Authorization: Bearer $ADMIN_SECRET" \
  "https://cloudflare-billing-kill-switch.<your-subdomain>.workers.dev/restore?worker=my-worker"
```

`/restore` re-enables the workers.dev subdomain and re-attaches every custom domain
and zone route from the snapshot, then clears the snapshot. (Requires `ALERT_STATE`;
cannot recover an auto-**deleted** worker — its code is gone.) You can also just
`wrangler deploy` to re-apply the routes/domains declared in your `wrangler.toml`.

## API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/` | GET | Health check with current config (public) |
| `/check` | GET | Run usage check now (triggers alerts if needed) — requires `ADMIN_SECRET` |
| `/usage` | GET | View current usage data + `analyticsAuth` health (no alerts) — requires `ADMIN_SECRET` |
| `/restore` | GET | Restore a disconnected worker from its kill snapshot (`?worker=NAME`) — requires `ADMIN_SECRET` + `ALERT_STATE` |
| `/test-alert` | GET | Send test alert to all configured destinations — requires `ADMIN_SECRET` |

All endpoints except `/` **fail closed**: if `ADMIN_SECRET` is unset they return
`403`; if set, they require `Authorization: Bearer <ADMIN_SECRET>`. The cron path
does not go through HTTP auth, so scheduled checks keep running regardless.

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

| Permission | Scope | Access | Why |
|------------|-------|--------|-----|
| Account Analytics | Account | Read | Query usage metrics via GraphQL (without it the CF half reads empty — you'd be silently blind) |
| Workers Scripts | Account | Edit | Disable workers.dev subdomain, remove custom domains, delete |
| Workers Routes | Zone | Edit | Remove zone `[[routes]]` patterns |
| Zone | Zone | Read | Enumerate zones to find routes to remove |

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

- [x] R2 storage monitoring (DOs aren't the only expensive thing)
- [x] D1 usage monitoring
- [x] Workers AI / AI Gateway / Vectorize (LLM) cost coverage
- [x] Alert threshold separated from kill threshold (`DISCONNECT_THRESHOLD_MULTIPLIER`)
- [x] Webhook alert de-dup / cooldown (KV)
- [x] Zone route removal on disconnect
- [ ] Queue usage monitoring
- [x] `restore <worker>` endpoint (auto-replay the KV kill snapshot)
- [ ] Daily cost estimate reports (email/Discord digest)
- [ ] Dashboard UI (Pages site with historical data)
- [ ] Hysteresis (trigger at 90%, recover at 85% to prevent oscillation)
- [ ] GCP Cloud Run integration (multi-cloud kill switch)

## License

MIT
