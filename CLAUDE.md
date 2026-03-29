# Cloud Kill Switch

## Tools & CLI
- Use `wrangler` directly (globally installed), NOT `npx wrangler`
- Use `ks` (alias for `kill-switch`) CLI for monitoring setup
- Cloudflare account ID: 14a6fa23390363382f378b5bd4a0f849

## Project Structure
- `site/` — Marketing landing page (CF Worker: `cloud-switch-site`)
- `packages/web` — React SPA dashboard (CF Worker: `kill-switch-app`)
- `packages/api` — Express.js API (GCP Cloud Run)
- `packages/cli` — Kill Switch CLI (`ks` / `kill-switch`)
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

# One-command setup (connect + shields + alerts)
ks onboard --provider cloudflare \
  --account-id CF_ACCOUNT_ID \
  --token CF_API_TOKEN \
  --name "Production" \
  --shields cost-runaway,ddos

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
4. Run `ks onboard --provider <provider> --token ... --account-id ... --shields cost-runaway,ddos --json`
5. Verify with `ks check --json`

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

## Dogfooding
- `packages/api/src/dogfood/` — Self-monitoring config and setup script
- Protected workers (never killed): `kill-switch-cf`, `api-proxy`
- Expendable workers (can be killed): `cloud-switch-site`, `kill-switch-app`, `edge-agent`

## Auth
- Auth provider: Clerk (app_3Bb7YfBWlkNukk5VnyszOMcfWFv)
- Frontend: @clerk/clerk-react with VITE_CLERK_PUBLISHABLE_KEY
- API: Clerk JWT validation via JWKS, or ks_ API keys
- Email routing: admin@kill-switch.net → mikeumus@proton.me
