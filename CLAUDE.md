# Cloud Kill Switch

## Tools & CLI
- Use `wrangler` directly (globally installed), NOT `npx wrangler`
- Use `ks` (alias for `kill-switch`) CLI for monitoring setup
- Cloudflare account ID: 14a6fa23390363382f378b5bd4a0f849

## Wrangler Deploy Trick (Secrets Store auth workaround)
The `CLOUDFLARE_API_TOKEN` env var (set in zshrc) overrides the Wrangler OAuth session and may
lack certain permissions (e.g. Secrets Store). Always deploy CF workers by stripping it:
```sh
# One-time login (if not already logged in):
unset CLOUDFLARE_API_TOKEN CLOUDFLARE_EMAIL CLOUDFLARE_ACCOUNT_ID && wrangler logout && wrangler login

# Every wrangler deploy (web, kill-switch, site, agent):
env -u CLOUDFLARE_API_TOKEN -u CLOUDFLARE_EMAIL -u CLOUDFLARE_ACCOUNT_ID wrangler deploy
```
Symptoms: `failed to fetch secrets store binding [code: 10021]` or any wrangler auth error.

## Project Structure
- `site/` — Marketing landing page (CF Worker: `cloud-switch-site`)
- `packages/web` — React SPA dashboard (CF Worker: `kill-switch-app`)
- `packages/api` — Express.js API (GCP Cloud Run)
- `packages/cli` — Kill Switch CLI (`ks` / `kill-switch`)
- `packages/agent-guard` — Kill Switch for coding agents (`agent-guard` / `ksg`): Claude Code hook + token-metering proxy that cap per-session & daily-rolling LLM spend
- `packages/kill-switch-cf` — Cloudflare kill-switch worker (cron)
- `packages/kill-switch-gcp` — GCP kill-switch
- `packages/kill-switch-aws` — AWS kill-switch
- `packages/agent` — Edge agent worker (cron)

## Domains (kill-switch.net)
- `kill-switch.net` / `www.kill-switch.net` → cloud-switch-site (CF Worker, custom domains)
- `app.kill-switch.net` → kill-switch-app (CF Worker, custom domain)
- `api.kill-switch.net` → CNAME to guardian-api GCP Cloud Run

## Deploy
- `npm run deploy:site` — deploy marketing site
- `npm run deploy:web` — build + deploy web app (sets VITE_API_URL)
- `npm run deploy:api` — deploy API to GCP Cloud Run
- `npm run deploy:kill-switch` — deploy CF kill-switch worker
- `npm run deploy:agent` — deploy edge agent worker
- `npm run dogfood` — set up self-monitoring (kill switch for the kill switch)

## Kill Switch CLI (`ks`)
The CLI is at `packages/cli`. Build with `npm run build`, link with `npm link`.

### Quick Reference
```sh
# Authenticate
ks auth login --api-key ks_live_YOUR_KEY

# One-command setup (connect + shields + PagerDuty alerts)
ks onboard --provider cloudflare \
  --account-id CF_ACCOUNT_ID \
  --token CF_API_TOKEN \
  --name "Production" \
  --shields cost-runaway,ddos \
  --alert-pagerduty ROUTING_KEY

# Alert channels
ks alerts list
ks alerts add --type pagerduty --routing-key KEY
ks alerts add --type slack --webhook-url URL
ks alerts add --type github --token PAT --repo-owner ORG --repo-name REPO
ks alerts remove "PagerDuty"
ks alerts test

# Check all accounts
ks check --json

# List accounts
ks accounts list

# Get credential help
ks onboard --help-provider cloudflare
```

### For AI Agent Setup
When setting up Kill Switch for another project:
1. User needs a `ks_live_` API key from https://app.kill-switch.net (Settings > API Keys)
2. Set `KILL_SWITCH_API_KEY` env var or run `ks auth login --api-key KEY`
3. Run `ks onboard --help-provider <provider>` to learn what credentials are needed
4. Run `ks onboard --provider <provider> --token ... --account-id ... --shields cost-runaway,ddos --alert-pagerduty KEY --json`
5. Verify with `ks check --json`
6. Optionally add more alert channels: `ks alerts add --type slack --webhook-url URL`

### Cloudflare API Token Requirements
The token must be an **API Token** (not Global API Key), created at:
https://dash.cloudflare.com/profile/api-tokens

Required permissions:
- Account > Account Analytics > Read
- Account > Workers Scripts > Edit
- Account > Workers R2 Storage > Read
- Account > D1 > Read
- Zone > Zone > Read

Or use the "Edit Cloudflare Workers" template.

### RunPod API Key Requirements
Create an API key at https://www.runpod.io/console/user/settings under "API Keys".

Required permissions:
- Read access to pods, serverless endpoints, and network volumes
- Write access for auto-kill actions (stop/terminate pods, scale endpoints)

## Supported Cloud Providers
- **Cloudflare** — Workers, Durable Objects, R2, D1, Queues, Stream, Zones
- **GCP** — Cloud Run, Compute Engine, GKE, BigQuery, Cloud Functions, Cloud Storage
- **AWS** — EC2, Lambda, RDS, ECS, EKS, S3, SageMaker, Cost Explorer
- **RunPod** — GPU Pods (on-demand & spot), Serverless Endpoints, Network Volumes
- **Redis** — Redis Cloud, AWS ElastiCache, Self-hosted (memory, connections, ops/sec, cost)
- **MongoDB** — MongoDB Atlas, Self-hosted (storage, connections, ops/sec, cost)
- **OpenAI** — Token usage, request counts, daily cost monitoring
- **Anthropic** — Claude API token usage and cost tracking
- **xAI (Grok)** — Grok API token usage and cost tracking
- **Replicate** — GPU prediction costs, model usage monitoring
- **Snowflake** — Warehouse credits, query costs, data scanning
- **Vercel** — Function invocations, bandwidth, build minutes
- **Neo4j** — Neo4j Aura graph database instances (memory, storage, instance count, cost)
- **Datadog** — Host count, log ingestion, custom metrics costs

## Organizations & Permissions
- Multi-org support: users can create/join multiple orgs (team/enterprise tier)
- Org switcher in web UI header; `X-Org-Id` header for API org selection
- Role-based permissions: owner > admin > member > viewer
- Permission middleware at `packages/api/src/middleware/permissions.ts`
- Activity logging: all mutations tracked in PostgreSQL `activity_log` table
- Activity page at `/activity` (team/enterprise only)

## Dogfooding
- `packages/api/src/dogfood/` — Self-monitoring config and setup script
- Protected workers (never killed): `kill-switch-cf`, `api-proxy`
- Expendable workers (can be killed): `cloud-switch-site`, `kill-switch-app`, `edge-agent`

### ⚠ GCP Self-Protection Constraint
The Kill Switch API (`guardian-api`) runs on **GCP Cloud Run** in project `openai-api-4375643`.
`getDefaultKillAction("gcp")` returns `"scale-down"`, which scales Cloud Run to 0 instances.

**If you connect the same GCP project that hosts the API**, add the bare service name
`"guardian-api"` to `protectedServices` on that cloud account — otherwise a GCP cost spike
could scale down the API itself, severing the kill switch from its own infrastructure.

GCP `serviceName` formats by resource type (this is what `protectedServices` matches against):
- **Cloud Run** — bare name, e.g. `"guardian-api"`
- **Compute Engine** — `"compute:<instance-name>:<zone>"`
- **GKE** — `"gke:<cluster-name>"`
- **BigQuery** — `"bq:<projectId>"`
- **Cloud Functions** — `"gcf:<function-name>"`
- **Cloud Storage** — `"gcs:<bucket-name>"`

(Older docs referenced `"gcp:cloud-run:<name>"` for Cloud Run — that prefix is **not** what
the checker emits, so it silently fails to match. The bare name is correct.)

The dogfood Cloudflare account is safe (it monitors CF workers, not GCP). This only affects
users who connect their own GCP account and happen to run the guardian API there.

## Auth
- Auth provider: Clerk (app_3Bb7YfBWlkNukk5VnyszOMcfWFv)
- Frontend: @clerk/clerk-react with VITE_CLERK_PUBLISHABLE_KEY
- API: Clerk JWT validation via JWKS, or ks_ API keys
- Email routing: admin@kill-switch.net → mikeumus@proton.me
