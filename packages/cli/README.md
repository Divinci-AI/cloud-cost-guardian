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
  --alert-email you@example.com

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

## Commands

| Command | Description |
|---------|-------------|
| `ks onboard` | One-command setup: connect + shields + alerts |
| `ks auth login` | Authenticate with API key |
| `ks auth status` | Show auth status |
| `ks accounts list` | List connected cloud accounts |
| `ks accounts add` | Connect a cloud provider |
| `ks accounts check <id>` | Run manual check on an account |
| `ks check` | Check all accounts |
| `ks shield <preset>` | Apply a protection preset |
| `ks rules list` | List active rules |
| `ks alerts list` | List alert channels |
| `ks analytics` | Cost analytics overview |
| `ks config list` | Show configuration |

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
  --json

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
- [GitHub](https://github.com/AiExpanse/kill-switch)

## License

MIT
