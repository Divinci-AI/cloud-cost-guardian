# @kill-switch/cli

Stop runaway cloud bills from the terminal. Monitor Cloudflare, GCP, and AWS spending with automatic kill switches that shut down services before they drain your account.

Born from a [$91K Cloudflare bill](https://kill-switch.net).

## Install

```sh
npm install -g @kill-switch/cli
```

This gives you two commands: `kill-switch` and `ks` (short alias).

## Quick Start

```sh
# 1. Get an API key from https://app.kill-switch.net (Settings > API Keys)
ks auth login --api-key ks_live_your_key_here

# 2. Connect your cloud provider and apply protection
ks onboard --provider cloudflare \
  --account-id YOUR_ACCOUNT_ID \
  --token YOUR_API_TOKEN \
  --name "Production" \
  --shields cost-runaway,ddos

# 3. Check your accounts
ks check
```

## One-Command Setup

The `onboard` command connects a provider, applies shield presets, and configures alerts in one step:

```sh
# Cloudflare
ks onboard --provider cloudflare \
  --account-id YOUR_CF_ACCOUNT_ID \
  --token YOUR_CF_API_TOKEN \
  --name "Production" \
  --shields cost-runaway,ddos \
  --alert-pagerduty YOUR_ROUTING_KEY

# AWS
ks onboard --provider aws \
  --access-key AKIA... \
  --secret-key wJalr... \
  --region us-east-1 \
  --shields aws-cost-runaway,gpu-runaway

# GCP
ks onboard --provider gcp \
  --project-id my-project-123 \
  --service-account "$(cat key.json)" \
  --shields cost-runaway

# Interactive mode (prompts for everything)
ks onboard
```

Don't know where to find your credentials? Run:

```sh
ks onboard --help-provider cloudflare
ks onboard --help-provider aws
ks onboard --help-provider gcp
```

## Shields (Quick Protect)

Apply preset protection rules with one command:

```sh
ks shield cost-runaway        # Kill services exceeding daily cost limit
ks shield ddos                # Kill services getting excessive requests
ks shield gpu-runaway         # Stop unexpected GPU instances
ks shield lambda-loop         # Throttle recursive Lambda invocations
ks shield aws-cost-runaway    # Emergency stop on AWS daily spend spike
ks shield brute-force         # Rotate creds on mass auth failures
ks shield exfiltration        # Isolate on unusual egress
ks shield error-storm         # Scale down on sustained high error rate

# List all shields
ks shield --list
```

## Alert Channels

```sh
# List configured channels
ks alerts list

# Add PagerDuty (recommended — get routing key from PagerDuty > Service > Integrations)
ks alerts add --type pagerduty --routing-key YOUR_ROUTING_KEY

# Add Slack
ks alerts add --type slack --webhook-url https://hooks.slack.com/...

# Add Discord
ks alerts add --type discord --webhook-url https://discord.com/api/webhooks/...

# Add GitHub AI remediation (triggers Claude Code to open a fix PR on extreme violations)
ks alerts add --type github \
  --token ghp_YOUR_PAT \
  --repo-owner YOUR_ORG \
  --repo-name YOUR_REPO \
  --workflow kill-switch-remediate.yml \
  --branch main

# Add email or generic webhook
ks alerts add --type email --email you@example.com
ks alerts add --type webhook --webhook-url https://your-service.example.com/webhook

# Remove a channel by name
ks alerts remove "PagerDuty"

# Send a test alert to all channels
ks alerts test
```

## Agent Guard (`ks guard`)

Cap runaway **coding-agent** LLM spend (Claude Code, Cursor, Aider). Same engine as
[`@kill-switch/agent-guard`](https://www.npmjs.com/package/@kill-switch/agent-guard) — one
ledger, one budget.

```sh
# Wire the Claude Code hook (use --global for ~/.claude)
ks guard install

# Set caps (USD)
ks guard config --session-soft 5 --session-hard 20 --daily-soft 25 --daily-hard 100

# Check spend vs budget — and Claude Code plan limits
ks guard status

# Hard 402 wall for non-Claude-Code agents (Cursor, Aider, scripts)
ks guard proxy --flavor openai --port 8787

# Escape hatch — enforcement off until resume
ks guard pause --minutes 30
ks guard resume
```

| Command | Description |
|---------|-------------|
| `ks guard install` | Wire agent-guard hook into Claude Code settings |
| `ks guard usage` | Fetch REAL Claude Code limits (5h + weekly + per-model) from Anthropic |
| `ks guard status` | Session + daily spend vs budget, **and** Claude Code plan limits |
| `ks guard config` | View or set soft/hard caps **and plan limits** (`--plan`, thresholds) |
| `ks guard proxy` | Start token-metering proxy (HTTP 402 at hard cap; reads plan-limit headers) |
| `ks guard pause` / `resume` | Temporarily disable / re-arm enforcement |
| `ks guard reset` | Clear the spend ledger (`--limits` clears subscription state) |

### Two currencies: dollars and plan limits

API-key (pay-as-you-go) sessions are gated on **dollars** — the caps above block at the hard
cap. A **Claude Code Pro/Max subscription** is flat-fee, so dollars are meaningless; the scarce
resource is your plan's **rate-limit quota** in two rolling windows (5-hour + weekly).

Run Claude Code **through the proxy** and agent-guard reads Anthropic's own
`anthropic-ratelimit-unified-*` headers — exact 5h/weekly utilization + reset times — then
paces your burn rate and warns *before* you lock out. The pacing is **day-aware**: it measures
you against a daily budget (your weekly cap ÷ 7 ≈ 14%/day), so 60% of the weekly cap with two
days left stays quiet — it warns only when you're at/above that pace or projected to lock out.
Both soft and danger are pace-gated, so even 89% with hours left, under pace, stays calm (high
util under pace only happens near reset); a projected lockout still escalates. This is
**alert-only**: it never blocks a plan you've already
paid for. The dollar 402 is suppressed only for the anthropic proxy when you've pinned a
subscription `--plan` or seen fresh headers — a billed OpenAI/other agent sharing the proxy
keeps its hard wall.

**Where the numbers come from:** wire `ks guard statusline` as your Claude Code `statusLine` and
that's it — Claude Code pipes `rate_limits` (5h + weekly) on stdin, so the live numbers cost **no
network call, no credential read, and can't be rate-limited**. `ks guard usage` hits Anthropic's
undocumented `/api/oauth/usage` only as a fallback and to top up the **per-model** weekly that
stdin doesn't carry (at most hourly, honouring the endpoint's `429`/`retry-after` cooldown). If
the feed goes stale, the guard says `⚪ limits stale` rather than quoting an old number.

```sh
ks guard statusline                             # BEST: live 5h + weekly from Claude Code's statusLine stdin (no network)
ks guard usage                                  # fallback + per-model weekly (undocumented endpoint, backs off on 429/401)
ks guard proxy                                  # alt: ANTHROPIC_BASE_URL=http://localhost:8787 claude (in-flight headers)
ks guard config --plan max5                     # auto (detects tier from ~/.claude.json) | pro | max5 | max20
ks guard config --weekly-soft 0.6 --weekly-danger 0.85 --burn-ratio 1.5
ks guard reset --limits                         # clear detection latch + snapshot (re-arm the dollar wall)
ks guard status                                 # "weekly 62% used … ~38% left over 5.4d (~7%/day vs ~14%/day budget), burning 3.1× → lockout ~Thu"
```

Full docs: [kill-switch.net/docs/cli.html#guard](https://kill-switch.net/docs/cli.html#guard)

## Commands

| Command | Description |
|---------|-------------|
| `ks onboard` | One-command setup: connect + shields + alerts |
| `ks auth setup` | Authenticate via browser (device flow) |
| `ks auth login` | Authenticate with API key |
| `ks auth status` | Show auth status |
| `ks doctor` | Diagnose setup: config, auth, **active org**, connectivity, accounts, alerts |
| `ks status` | Dashboard: **active org**, accounts, alerts, 30-day spend summary |
| `ks accounts list` | List connected cloud accounts (shows the active org they belong to) |
| `ks accounts add <provider>` | Connect a provider — cloudflare, gcp, aws, runpod, **mongodb, redis, neo4j**, … |
| `ks accounts update <id>` | Update thresholds / auto-actions / `productionProtected` |
| `ks accounts check <id>` | Run manual check on an account |
| `ks apply -f <file>` | Apply a declarative integration config (account + thresholds + shields + alerts) |
| `ks check` | Check all accounts (shows violations with multiplier column e.g. 60x) |
| `ks shield <preset>` | Apply a protection preset |
| `ks rules list` | List active rules |
| `ks alerts list` | List alert channels |
| `ks alerts add` | Add an alert channel |
| `ks alerts remove <name>` | Remove an alert channel by name |
| `ks alerts test` | Send a test alert to all channels |
| `ks analytics` | Cost analytics: spend summary, 7-day table, per-account breakdown |
| `ks watch` | Continuously poll all accounts on an interval |
| `ks providers` | Provider info and credential validation |
| `ks guard` | Cap coding-agent LLM spend (hook + proxy) |
| `ks config list` | Show configuration |

## Databases & production protection

Connect managed databases (and any other provider) with `ks accounts add`:

```sh
# MongoDB Atlas
ks accounts add mongodb --name "Prod Atlas" \
  --atlas-public-key PUB --atlas-private-key PRIV --atlas-project-id PROJ \
  --atlas-cluster-name my-cluster

# MongoDB self-hosted / Redis / Neo4j
ks accounts add mongodb --name "Self-hosted" --mongodb-uri "mongodb+srv://…"
ks accounts add redis   --name "Redis Cloud"  --redis-cloud-key K --redis-cloud-secret S --redis-subscription-id ID
ks accounts add neo4j   --name "Aura"         --neo4j-client-id ID --neo4j-client-secret SECRET

# Any provider/field without a dedicated flag:
ks accounts add <provider> --name X --cred key=value --cred other=value
```

**Production protection (on by default).** Managed-database accounts are created with
`productionProtected: true`, which means destructive actions (`pause-cluster`, `delete`) are
**never auto-executed** — a breach is downgraded to a forensic snapshot + alert so a human
decides. Tune an account after connecting:

```sh
ks accounts update <id> --threshold mongodbDailyCostUSD=50 --threshold monthlySpendLimitUSD=1200
ks accounts update <id> --production-protected false   # opt in to auto-pause/delete (not recommended for prod)
ks accounts update <id> --autokill-categories cost     # which violation categories may auto-kill
```

## Integration-as-code (`ks apply`)

Declare an integration in a version-controlled YAML/JSON file and reconcile it idempotently —
no hand-rolled scripts. Secrets stay in the environment via `${ENV}` interpolation.

```yaml
# ks.yaml — apply with: ks apply -f ks.yaml   (preview with --dry-run)
account:
  provider: mongodb
  name: Production Atlas
  credential:                       # only needed to create; ${ENV} interpolated
    mongodbSubType: atlas
    atlasPublicKey: ${ATLAS_PUBLIC_KEY}
    atlasPrivateKey: ${ATLAS_PRIVATE_KEY}
    atlasProjectId: ${ATLAS_PROJECT_ID}
    atlasClusterName: prod-cluster0
  thresholds: { mongodbDailyCostUSD: 40, monthlySpendLimitUSD: 1200 }
  protectedServices: [prod-cluster0]
  productionProtected: true
shields: [cost-runaway]
alerts:
  - { type: pagerduty, routingKey: ${PD_ROUTING_KEY}, name: On-Call }
```

Re-running converges (find-or-create account → apply thresholds/flags → apply shields →
ensure alert channels); each change is reported as `+ create` / `~ update` / `= unchanged`.

## AI Agent Usage

The CLI is designed for AI coding agents (Claude Code, Cursor, Windsurf) to set up cloud monitoring on behalf of users without interactive prompts.

```sh
# Set API key via env var
export KILL_SWITCH_API_KEY=ks_live_your_key

# Non-interactive setup with JSON output
ks onboard \
  --provider cloudflare \
  --account-id CF_ACCOUNT_ID \
  --token CF_API_TOKEN \
  --name "Production" \
  --shields cost-runaway,ddos \
  --alert-pagerduty KEY \
  --json

# Add PagerDuty alerts
ks alerts add --type pagerduty --routing-key KEY --json

# Full status dashboard
ks status --json

# All commands support --json for machine-readable output
ks accounts list --json
ks check --json
ks analytics --json
```

### CLAUDE.md Integration

Add this to your project's `CLAUDE.md` so your AI agent knows how to manage Kill Switch:

```markdown
## Kill Switch (Cloud Cost Protection)
- CLI: `ks` (alias for `kill-switch`)
- Auth: KILL_SWITCH_API_KEY env var or `ks auth login --api-key KEY`
- Setup: `ks onboard --provider cloudflare --account-id ID --token TOKEN`
- Check: `ks check --json`
- Agent spend: `ks guard install` then `ks guard config --daily-hard 150`
- Docs: `ks onboard --help-provider cloudflare`
```

## Authentication

The CLI uses personal API keys (prefixed with `ks_live_`). Create one from [app.kill-switch.net](https://app.kill-switch.net) under Settings > API Keys.

**Auth resolution order:**
1. `KILL_SWITCH_API_KEY` environment variable (best for CI/CD and AI agents)
2. `--api-key` flag on any command
3. `~/.kill-switch/config.json` (set by `ks auth login`)

## Global Options

| Flag | Description |
|------|-------------|
| `--json` | Output raw JSON (for automation/scripting/AI agents) |
| `--api-key <key>` | Override API key for this command |
| `--api-url <url>` | Override API URL |
| `-V, --version` | Show version |
| `-h, --help` | Show help |

## Exit Codes

| Code | Meaning |
|------|---------|
| `0` | Success |
| `1` | Client error (bad arguments, API error) |
| `2` | Authentication error (invalid/missing API key) |

## Links

- [Website](https://kill-switch.net)
- [Dashboard](https://app.kill-switch.net)
- [API Docs](https://kill-switch.net/docs)
- [CLI Docs](https://kill-switch.net/docs/cli.html)
- [GitHub](https://github.com/divinci-ai/kill-switch)

## License

MIT
