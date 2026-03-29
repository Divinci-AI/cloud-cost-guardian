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

## Supported Providers (13)

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

## Packages

| Package | Description | Deployment |
|---------|-------------|------------|
| [`packages/cli`](packages/cli) | CLI (`ks` / `kill-switch`) — onboard, monitor, kill from the terminal | npm: `@kill-switch/cli` |
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
│                 ├── Alerting (PD/Discord/Slack/Email)            │
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
npm test                    # 350 unit + e2e tests
SMOKE=1 npm test -- tests/smoke/live-api.test.ts  # 12 live API tests
```

## AI Agent Usage

The CLI is designed for AI coding agents (Claude Code, Cursor, Windsurf) to set up monitoring on behalf of users:

```bash
export KILL_SWITCH_API_KEY=ks_live_your_key
ks onboard --provider cloudflare --account-id ID --token TOKEN --json
ks check --json
```

See [CLI docs](https://kill-switch.net/docs/cli.html) for the full reference.

## License

MIT — Use it, fork it, protect your wallet.
