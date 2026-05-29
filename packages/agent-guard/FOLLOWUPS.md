# agent-guard — Remaining Work (Gold Prompt)

> Paste the block below into a fresh Claude Code session at the repo root
> (`/Users/mikeumus/Documents/cloud-kill-switch`) to finish wiring `agent-guard`
> into the rest of the Kill Switch platform. It is self-contained: it states the
> context, the tasks, the acceptance criteria, and the guardrails.

---

## GOLD PROMPT

You are continuing work on **Cloud Kill Switch**. PR #4 added `packages/agent-guard`
(`@kill-switch/agent-guard`, bins `agent-guard` / `ksg`) — a kill switch for runaway coding
agents. It has two surfaces sharing one spend ledger + budget:

- **Hook** (`agent-guard hook`): a Claude Code `PreToolUse`/`UserPromptSubmit`/`Stop` hook
  that prices the session transcript, warns at a soft cap, denies tool calls at a hard cap,
  and fails open on error.
- **Proxy** (`agent-guard proxy`): a local metering reverse-proxy on `ANTHROPIC_BASE_URL` /
  `OPENAI_BASE_URL` that returns HTTP 402 at the hard cap for any agent.

Budgets are per-session + daily-rolling-24h, each soft (warn) + hard (block). There's an
escape hatch (`agent-guard pause [--minutes N]` / `resume`, or `touch ~/.kill-switch/agent-
guard/PAUSED`). The package builds clean (`tsc`) with 21 passing vitest tests.

`alert.ts` already POSTs breach events to `${apiUrl}/v1/agent-guard/events` with a
`Bearer ${KILL_SWITCH_API_KEY}` header, **but that endpoint does not exist server-side yet**,
and the package is not yet wired into the `ks` CLI or the web dashboard. Your job is to close
those gaps. Read `packages/agent-guard/README.md` and `src/alert.ts` first to confirm the
event payload shape (the `AlertEvent` interface).

Work on a new branch off `main` (do NOT push to PR #4's branch). Branch first; commit only
when each task is green; do not push or open a PR until I confirm.

### Task 1 — Server endpoint: `POST /agent-guard/events`
Add an authenticated route so agent kills land in the dashboard alongside cloud-account kills.
- Model the route after the existing edge-agent reporter `app.post("/agent/report", …)` in
  `packages/api/src/app.ts` (~line 426) and the router pattern in
  `packages/api/src/routes/alerts/index.ts`. Mount a new `agentGuardRouter` from
  `packages/api/src/routes/agent-guard/index.ts`.
- Auth: accept a `ks_live_` API key (same mechanism the SDK/CLI use). Reuse the existing
  auth + `resolveOrg` stack used by other authenticated routers; if API-key auth differs from
  Clerk JWT, follow whatever `/agent/report` or the CLI-auth path does.
- Add a rate limit consistent with the others in `app.ts` (e.g. `app.use("/agent-guard",
  rateLimit({ windowMs: 15*60*1000, max: 60, ... }))`).
- Persist events: add a small Mongoose model under `packages/api/src/models/` (follow an
  existing schema's conventions) storing `{ orgId/guardianAccountId, ts, source, sessionId,
  level, sessionUSD, dailyUSD, reasons, action, cwd }`. Validate the body; reject unknown
  levels. On a `block` event, fan out through the existing `sendAlerts` service so it reaches
  the org's configured PagerDuty/Slack/GitHub channels (the same path cloud kills use).
- The endpoint the client already calls is `/v1/agent-guard/events`. Decide: either mount at
  `/v1/agent-guard` server-side, OR change `alert.ts` to drop the `/v1` prefix to match the
  rest of the API (other routes have no `/v1`). Pick the one consistent with the codebase and
  update whichever side is wrong so client and server agree. Note the choice in the commit.
- Tests: add an API test under `packages/api/tests/` (follow `tests/providers/*.test.ts`
  style) covering: valid block event → 200 + persisted + alert fan-out invoked; bad/missing
  auth → 401; malformed body → 400.

### Task 2 — Wire into the `ks` CLI
Surface agent-guard through the main CLI so users don't need a second tool name.
- Add `packages/cli/src/commands/agent-guard.ts` with a `registerAgentGuardCommands(program,
  createClient)` following the exact pattern of the other command modules (see
  `packages/cli/src/commands/watch.ts` and `index.ts` for registration; use the `colors`/
  `outputJson`/`handleError` helpers from `output.ts`).
- Expose: `ks guard install`, `ks guard status`, `ks guard config`, `ks guard pause`,
  `ks guard resume`, `ks guard proxy`. These should call into the agent-guard package's
  exported functions (it already exports them from `src/index.ts`) rather than shelling out —
  add `@kill-switch/agent-guard` as a CLI dependency (workspace `*`).
- `ks guard status --json` must emit the same JSON shape as `agent-guard status --json`.
- Register the new command group in `packages/cli/src/index.ts`.
- Update the CLI README/help and the root `CLAUDE.md` "Kill Switch CLI" section.

### Task 3 — Web dashboard surface
Add a minimal read view so agent kills are visible in the app.
- Follow the existing page/component conventions in `packages/web/src` (look at how cloud
  accounts / activity are listed). Add an "Agent Guard" view that lists recent agent-guard
  events from Task 1's endpoint (GET side — add `GET /agent-guard/events` returning the
  org's recent events, paginated, secrets-free like the alerts router does).
- Keep it small: a table of {time, project (cwd), session $, daily $, level, action}. Reuse
  existing table/badge components; do not invent a new design system.

### Task 4 — Publish ergonomics
- Add a root `package.json` script `deploy`/`build` parity if relevant, and confirm
  `npm run build:agent-guard` + `npm run test:agent-guard` work from the root (already added).
- Document `npm link` (or the npm publish flow) so the bare `agent-guard`/`ksg` commands work
  on PATH — this was the gap that locked the agent out during dogfooding.

### Acceptance criteria (all must hold)
- `npm run build:agent-guard`, `npm run test:agent-guard`, and `cd packages/api && npm test`
  all pass. `tsc` is clean in every package you touch.
- The client→server event path works end-to-end (write a throwaway script or test that POSTs
  a sample `AlertEvent` and asserts persistence + alert fan-out). Remove the throwaway after.
- No secrets or machine-specific absolute paths are committed. Do NOT commit any
  `.claude/settings.json` or `dist/`.
- Each task is its own focused commit with a clear message; co-author trailer
  `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.

### Guardrails
- Match surrounding code style; don't introduce new deps without need.
- The agent-guard hook may be active in this repo and meter your session — if it blocks you,
  use the escape hatch (`agent-guard pause --minutes 60`) rather than removing the hook.
- Don't touch PR #4's branch. Don't push or open a PR until I say so.
