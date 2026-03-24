# Kill Switch

**Monitor cloud spending, auto-kill runaway services, protect your infrastructure.**

Born from a **$91,316 Cloudflare Durable Objects bill**. Cloudflare has no spending cap. Neither does GCP. Neither does AWS. This is your safety net.

## Supported Cloud Providers

| Provider | Services Monitored | Kill Actions |
|----------|-------------------|--------------|
| **Cloudflare** | Workers, Durable Objects, R2, D1, Queues, Stream, Zones, Argo | Disconnect routes, delete workers, delete R2/D1/queues, disable live inputs, pause zones |
| **Google Cloud** | Cloud Run, Compute Engine, GKE, BigQuery, Cloud Functions, Cloud Storage | Scale down, stop instances, set quotas, disable APIs, disable billing |
| **Amazon Web Services** | EC2, Lambda, RDS, ECS, EKS, SageMaker, Cost Explorer | Stop/terminate instances, throttle Lambda, scale ECS/EKS, deny S3 policies, delete endpoints |

## Packages

| Package | Description | Deployment |
|---------|-------------|------------|
| [`packages/api`](packages/api) | Guardian API — Express server with monitoring engine, rule engine, billing | GCP Cloud Run |
| [`packages/web`](packages/web) | Dashboard — React SPA with Auth0 | Cloudflare Pages |
| [`packages/kill-switch-cf`](packages/kill-switch-cf) | Cloudflare Kill Switch — self-hosted cron Worker | Cloudflare Workers |
| [`packages/kill-switch-gcp`](packages/kill-switch-gcp) | GCP Kill Switch — Cloud Function triggered by budget alerts | GCP Cloud Functions |
| [`packages/kill-switch-aws`](packages/kill-switch-aws) | AWS Kill Switch — Lambda triggered by Budget alerts via SNS | AWS Lambda |
| [`packages/agent`](packages/agent) | Edge Agent — deploys to customer's CF account, reports to Guardian API | Customer's Cloudflare |
| [`site`](site) | Landing page with VEO3 videos | Static / CF Pages |

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                     Kill Switch                          │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  Dashboard (React)  ──→  Guardian API (Cloud Run)               │
│                          ├── Monitoring Engine (5-min cron)      │
│                          ├── Rule Engine (programmable)          │
│                          ├── Alerting (PD/Discord/Slack)         │
│                          ├── Database Kill Switch                │
│                          ├── Forensic Snapshots                  │
│                          └── Stripe Billing                      │
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
└─────────────────────────────────────────────────────────────────┘
```

## Quick Start

```bash
# Clone
git clone https://github.com/AiExpanse/kill-switch.git
cd kill-switch

# Run the API locally
cd packages/api
npm install
npm run dev

# Run the dashboard locally
cd packages/web
npm install
npm run dev

# Deploy the self-hosted kill switches
cd packages/kill-switch-cf && npm install && npx wrangler deploy  # Cloudflare
cd packages/kill-switch-gcp && npm install && gcloud functions deploy  # GCP
cd packages/kill-switch-aws && npm install && npm run deploy  # AWS Lambda
```

## Rule Presets

| Preset | Trigger | Action |
|--------|---------|--------|
| DDoS Protection | >50K requests/min | Block traffic + snapshot |
| Brute Force Protection | >100 auth failures/min | Rotate credentials + snapshot |
| Cost Runaway | >$100/day | Disconnect services + snapshot |
| Error Storm | >50% error rate | Scale down (60s grace + approval) |
| Data Exfiltration | >10 GB/hr egress | Isolate + snapshot |
| GPU Instance Runaway | Any unexpected GPU | Stop instances + snapshot |
| Lambda Recursive Loop | >500 concurrent | Throttle Lambda + snapshot |
| AWS Daily Cost Runaway | >$100/day AWS | Stop EC2 + throttle Lambda |

## Tests

```bash
cd packages/api
npm test
# 139+ tests across 9 files
```

## License

MIT — Use it, fork it, protect your wallet.
