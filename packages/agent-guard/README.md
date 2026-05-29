# @kill-switch/agent-guard

**Kill Switch for coding agents.** Stop a runaway Claude Code / Cursor / Aider session
from racking up an LLM bill — before it becomes a $4,200 weekend, an $87k month, or a
[$500M month](https://www.axios.com/) "after failing to put usage limits on Claude
licenses for employees."

A coding agent runs a reasoning loop — read, edit, validate, re-check — and **re-sends its
entire accumulated context on every tool call**. Cost compounds silently. agent-guard puts
a hard ceiling on that loop with two complementary surfaces that share one budget:

| Surface | What it is | Stops | Works with |
|---|---|---|---|
| **Hook** | A Claude Code `PreToolUse` / `UserPromptSubmit` / `Stop` hook that reads the live transcript, prices real token usage, warns at the soft cap and **denies the next tool call** at the hard cap | A single Claude Code session, gracefully | Claude Code |
| **Proxy** | A local metering reverse-proxy on the agent's API base URL that counts usage from real responses and returns **HTTP 402** at the cap | *Any* agent — the API literally stops answering | Claude Code, Cursor, Aider, raw scripts |

The hook is the friendly, native stop. The proxy is the dumb hard wall that can't be argued
past. Both feed one ledger with **two budget scopes**:

- **Per-session** — catches a single runaway run.
- **Daily rolling 24h** — catches many small sessions quietly adding up.

…each with a **soft cap** (warn + alert) and a **hard cap** (block).

## Install

```sh
npm i -g @kill-switch/agent-guard   # provides `agent-guard` and `ksg`
```

Or use it through the main Kill Switch CLI as `ks guard …` (same engine, one
shared ledger/budget) — see [`packages/cli`](../cli).

### Developing from this monorepo

The hook is wired into Claude Code by **absolute path to `dist/cli.js`**, so it
must be built before `install`, and the bare `agent-guard` / `ksg` commands only
land on your `PATH` after a link or publish:

```sh
# from the repo root
npm run build:agent-guard          # compile src → dist (required before install/link)
npm run test:agent-guard           # 21 unit tests

# put `agent-guard` / `ksg` on PATH for local dev
cd packages/agent-guard && npm link
agent-guard --help                 # now resolves

# unlink when done
npm rm -g @kill-switch/agent-guard
```

> ⚠️ If `agent-guard` reports `command not found` (e.g. when a runaway session
> hits the cap and the recovery command won't run), it just means the package
> isn't linked/published yet. The block message always prints an **absolute-path**
> fallback so recovery works regardless, and `ks guard …` works whenever the
> `ks` CLI is installed. You can also always pause with zero tooling:
> `touch ~/.kill-switch/agent-guard/PAUSED`.

## Quick start — Claude Code (hook)

```sh
# Wire the hook into ./.claude/settings.json (use --global for ~/.claude)
agent-guard install

# Set your caps (USD)
agent-guard config --session-soft 5 --session-hard 20 --daily-soft 25 --daily-hard 100

# See where you stand any time
agent-guard status
```

That's it. On every tool call the hook recomputes the session's real spend from the
transcript. Cross the soft cap → Claude sees a warning and you get an alert. Hit the hard
cap → the next tool call is **denied** with a reason, halting the agent.

## Quick start — any other agent (proxy)

```sh
agent-guard proxy                      # listens on :8787, meters Anthropic by default
# point your agent at it:
ANTHROPIC_BASE_URL=http://localhost:8787 claude      # (if NOT using the hook — see caveat)
OPENAI_BASE_URL=http://localhost:8787/v1 aider       # agent-guard proxy --flavor openai
```

At the hard cap the proxy returns `402 kill_switch_budget_exceeded` instead of forwarding —
the agent can't spend another token.

> ⚠️ **Don't run Claude Code through *both* the hook and the proxy** — they'd each meter the
> same dollars and double-count. Hook for Claude Code; proxy for everything else.

## Budgets

Resolution order (later wins): built-in defaults → `~/.kill-switch/agent-guard/config.json`
→ environment variables. Env override lets you tighten a single risky run:

```sh
AGENT_GUARD_SESSION_HARD=10 claude          # one-off $10 ceiling
```

| Env var | Meaning | Default |
|---|---|---|
| `AGENT_GUARD_SESSION_SOFT` | per-session warn (USD) | 5 |
| `AGENT_GUARD_SESSION_HARD` | per-session block (USD) | 20 |
| `AGENT_GUARD_DAILY_SOFT` | rolling-24h warn (USD) | 25 |
| `AGENT_GUARD_DAILY_HARD` | rolling-24h block (USD) | 100 |

A cap of `0` disables that check.

## Alerts

On the first soft/hard trip per scope, agent-guard:

1. appends an event to `~/.kill-switch/agent-guard/events.jsonl` (local audit trail),
2. posts to Slack if `KILL_SWITCH_SLACK_WEBHOOK` (or `config --slack-webhook`) is set,
3. reports to the Kill Switch dashboard if `KILL_SWITCH_API_KEY` is set, so agent kills sit
   alongside your cloud-account kills.

All network alerts are best-effort with a short timeout — a down endpoint never delays the
agent.

## Pricing

Built-in rates for current Claude and OpenAI models (USD/1M tokens), including Anthropic
cache multipliers (cache write = input × 1.25, cache read = input × 0.10) — the buckets a
context-replaying agent loop hits hardest. Unknown models fall back to premium Sonnet-class
rates so the guard never *under*-counts. Override any model in
`~/.kill-switch/agent-guard/pricing.json`.

## Commands

```
agent-guard install [--global] [--command <cmd>]   wire the Claude Code hook
agent-guard proxy   [--port 8787] [--flavor anthropic|openai] [--upstream URL]
agent-guard status  [--json]                        spend vs budget
agent-guard config  [--session-hard N ...]          view/set caps
agent-guard reset   [--all|--today|--session <id>]  clear the ledger
agent-guard hook                                    (internal) Claude Code entrypoint
```

## How it fails

By design, **the hook fails open**: any internal error → exit 0, the agent proceeds. A buggy
guard must never brick your session. The proxy fails open too (on a metering error it still
relays the response) but the *budget check itself* fails closed at the 402 wall.

MIT · part of [Cloud Kill Switch](https://kill-switch.net)
