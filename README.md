# Kill Switch

**Monitor cloud spending, auto-kill runaway services, protect your infrastructure.**

Born from a **$91,316 Cloudflare Durable Objects bill**. Cloudflare has no spending cap. Neither does GCP. Neither does AWS. This is your safety net.

**Website:** [kill-switch.net](https://kill-switch.net) | **Dashboard:** [app.kill-switch.net](https://app.kill-switch.net) | **CLI:** `npm i -g @kill-switch/cli`

## Quick Start

```bash
# Install the CLI
npm install -g @kill-switch/cli

# Authenticate (opens browser to create API key)
ks auth setup

# Connect your cloud provider
ks onboard --provider cloudflare \
  --account-id YOUR_ACCOUNT_ID \
  --token YOUR_API_TOKEN \
  --name "Production" \
  --shields cost-runaway,ddos

# Run a monitoring check
ks check
```

## Kill Switch for Coding Agents

Cloud bills aren't the only runaway anymore. A coding agent (Claude Code, Cursor,
Aider) runs a reasoning loop that **re-sends its entire accumulated context on
every tool call**, so LLM spend compounds silently — the failure mode behind the
$4,200-weekend, $87k-month, and reported $500M-month "after failing to put usage
limits on Claude licenses" stories.

[`agent-guard`](packages/agent-guard) caps that loop with **two surfaces sharing one
budget** (per-session **and** daily-rolling, each with a soft warn + hard block):

```bash
# Through the main CLI:
ks guard install                                  # wire the Claude Code hook
ks guard config --session-hard 30 --daily-hard 150
ks guard status                                   # spend vs budget

# …or the standalone binary, for any agent:
npm i -g @kill-switch/agent-guard
agent-guard proxy   # ANTHROPIC_BASE_URL/OPENAI_BASE_URL → hard 402 wall at the cap
```

- **Hook** (Claude Code) — reads the live transcript, prices real token usage, warns
  at the soft cap, **denies the next tool call** at the hard cap. Fails *open* on any
  error, so a buggy guard never bricks your session.
- **Proxy** (any agent) — a local metering reverse-proxy that returns **HTTP 402** at
  the cap. The API literally stops answering — a wall the agent can't argue past.

This works against **any** coding agent *by design*: the hook is the friendly native
stop for Claude Code; the proxy is the dumb hard backstop for everything else
(Cursor, Aider, raw scripts). An **escape hatch** (`ks guard pause`, or
`touch ~/.kill-switch/agent-guard/PAUSED`) always belongs to the human, never the agent.

**On a Claude Code Pro/Max subscription**, dollars are the wrong currency — you pay a
flat fee, so the scarce resource is your plan's **rate-limit quota** (5-hour + weekly
windows). Run Claude Code through the proxy and agent-guard reads Anthropic's own
`anthropic-ratelimit-unified-*` headers, paces your burn rate, and warns *before* you
lock out (`ks guard config --plan max5`). This mode is **alert-only** — it never blocks
a plan you've already paid for.

## Supported Providers (15)

| Provider | Services Monitored | Kill Actions |
|----------|-------------------|--------------|
| **Cloudflare** | Workers, Durable Objects, R2, D1, Queues, Stream, Zones | Disconnect routes, delete workers, pause zones |
| **Google Cloud** | Cloud Run, Compute Engine, GKE, BigQuery, Cloud Functions, Cloud Storage | Scale down, stop instances, set quotas, disable billing |
| **AWS** | EC2, Lambda, RDS, ECS, EKS, S3, SageMaker, Cost Explorer | Stop/terminate instances, throttle Lambda, deny S3 policies |
| **RunPod** | GPU Pods (on-demand & spot), Serverless Endpoints, Network Volumes | Stop/terminate pods, scale endpoints |
| **Redis** | Redis Cloud, AWS ElastiCache, Self-hosted (memory, connections, ops/sec) | Kill connections, scale down, flush, pause cluster |
| **MongoDB** | Atlas clusters, Self-hosted (storage, connections, ops/sec) | Kill connections, isolate (IP whitelist), pause/scale cluster |
| **OpenAI** | GPT API token usage, request counts, daily cost | Rotate credentials |
| **Anthropic** | Claude API token usage, daily cost | Rotate credentials |
| **xAI (Grok)** | Grok API token usage, daily cost | Rotate credentials |
| **Replicate** | GPU predictions, model usage, daily cost | Rotate credentials |
| **Snowflake** | Warehouse credits, query costs, data scanning | Scale down warehouse, suspend warehouse |
| **Vercel** | Function invocations, bandwidth, build minutes | Scale down, disable service |
| **Datadog** | Host count, log ingestion, custom metrics | Rotate credentials, mute monitors |
| **Neon** | Compute hours, storage, data transfer costs | Scale down, pause project |
| **Neo4j Aura** | Graph DB instances, memory, storage, instance count | Pause instance, scale down, delete |

## Packages

| Package | Description | Deployment |
|---------|-------------|------------|
| [`packages/cli`](packages/cli) | CLI (`ks` / `kill-switch`) — onboard, monitor, kill from the terminal | npm: `@kill-switch/cli` |
| [`packages/agent-guard`](packages/agent-guard) | Kill Switch for **coding agents** (`agent-guard` / `ksg`, also `ks guard`) — hook + token-metering proxy that cap per-session & daily LLM spend | npm: `@kill-switch/agent-guard` |
| [`packages/api`](packages/api) | Kill Switch API — monitoring engine, rule engine, billing | GCP Cloud Run |
| [`packages/web`](packages/web) | Dashboard — React SPA with Clerk auth | Cloudflare Workers |
| [`packages/kill-switch-cf`](packages/kill-switch-cf) | Cloudflare Kill Switch — self-hosted cron Worker | Cloudflare Workers |
| [`packages/kill-switch-gcp`](packages/kill-switch-gcp) | GCP Kill Switch — Cloud Function triggered by budget alerts | GCP Cloud Functions |
| [`packages/kill-switch-aws`](packages/kill-switch-aws) | AWS Kill Switch — Lambda triggered by Budget alerts via SNS | AWS Lambda |
| [`packages/agent`](packages/agent) | Edge Agent — deploys to customer's CF account, reports to API | Customer's Cloudflare |
| [`site`](site) | Marketing landing page | Cloudflare Workers |

## Architecture

```
┌──────────────────────────────────────────────────────────────────┐
│                        Kill Switch                               │
├──────────────────────────────────────────────────────────────────┤
│                                                                  │
│  CLI (ks)  ──→  Kill Switch API (Cloud Run)                     │
│  Dashboard ──→  ├── Monitoring Engine (5-min cron)              │
│                 ├── Rule Engine (programmable)                   │
│                 ├── Alerting (PD/Slack/Discord/Email/GitHub AI)  │
│                 ├── API Key Management                          │
│                 ├── Forensic Snapshots                          │
│                 └── Stripe Billing                               │
│                                                                  │
│  Model A: Managed        Model B: Edge Agent                    │
│  (we hold credentials)   (customer holds credentials)           │
│  API ──→ CF/GCP/AWS APIs Agent ──→ CF/GCP APIs locally         │
│                           Agent ──→ Reports to API              │
│                                                                  │
│  Kill Switches (self-hosted, open source)                       │
│  ├── CF Worker (cron, GraphQL, auto-disconnect)                 │
│  ├── GCP Cloud Function (budget alerts, multi-service shutdown) │
│  └── AWS Lambda (budget alerts via SNS, EC2/Lambda/ECS kill)    │
│                                                                  │
│  Agent Guard (coding-agent LLM spend, runs on the dev's box)    │
│  ├── Hook (Claude Code: transcript-priced, warn→deny tool use)  │
│  ├── Proxy (any agent: meters responses, HTTP 402 at the cap)   │
│  └── Reports trips ──→ API /agent-guard/events ──→ alerts + UI  │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘
```

## Rule Presets (Shields)

```bash
ks shield cost-runaway      # Kill services exceeding daily cost limit
ks shield ddos              # Kill services getting excessive requests
ks shield gpu-runaway       # Stop unexpected GPU instances
ks shield lambda-loop       # Throttle recursive Lambda invocations
ks shield aws-cost-runaway  # Emergency stop on AWS daily spend spike
ks shield brute-force       # Rotate creds on mass auth failures
ks shield exfiltration      # Isolate on unusual egress
ks shield error-storm       # Scale down on sustained high error rate
```

## Tests

```bash
cd packages/api
npm test                    # 587 unit + e2e tests (API), 42 (CLI), 47 (SDK)
SMOKE=1 npm test -- tests/smoke/live-api.test.ts  # 12 live API tests
```

## AI Agent Usage

The CLI is designed for AI coding agents (Claude Code, Cursor, Windsurf) to set up monitoring on behalf of users:

```bash
export KILL_SWITCH_API_KEY=ks_live_your_key
ks onboard --provider cloudflare --account-id ID --token TOKEN \
  --shields cost-runaway,ddos --alert-pagerduty ROUTING_KEY --json
ks status --json           # dashboard: accounts, alerts, 30-day spend
ks check --json            # violations with multiplier column (e.g. 60x)
ks alerts add --type slack --webhook-url URL --json
ks analytics --json        # spend summary + 7-day table + per-account
```

See [CLI docs](https://kill-switch.net/docs/cli.html) for the full reference.

## License

MIT — Use it, fork it, protect your wallet.
