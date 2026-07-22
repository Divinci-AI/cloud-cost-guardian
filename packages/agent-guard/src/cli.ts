#!/usr/bin/env node
/**
 * agent-guard CLI — Kill Switch for coding agents.
 *
 *   agent-guard install            # wire the Claude Code hook into .claude/settings.json
 *   agent-guard proxy              # start the token-metering proxy (hard 402 wall)
 *   agent-guard status             # show current session + daily spend vs budget
 *   agent-guard config --session-hard 30
 *   agent-guard reset --today      # clear the ledger
 *   agent-guard hook               # (internal) invoked by Claude Code on each event
 */

import { Command } from "commander";
import { fileURLToPath } from "node:url";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runHook } from "./hook.js";
import { startProxy, resolveUpstream } from "./proxy.js";
import {
  loadConfig,
  configPath,
  isPaused,
  pauseExpiry,
  writePause,
  clearPause,
  pausePath,
  guardDir,
} from "./config.js";
import { loadLedger, rollingDailyCost } from "./ledger.js";
import { evaluate } from "./budget.js";
import { fmtUSD } from "./cost.js";
import { installHook, setBudget, setLimits, resetLedger } from "./ops.js";
import { buildStatusReport, formatLimitsLines, formatStatusline, formatStatusReport } from "./report.js";
import { refreshUsage, triggerBackgroundRefresh, EXTRAS_REFRESH_MS } from "./claude-usage.js";
import { parseStatuslineRateLimits, loadLimitsState, saveLimitsState } from "./limits.js";

const program = new Command();
program
  .name("agent-guard")
  .description("Kill Switch for coding agents — stop runaway Claude Code / Cursor / Aider sessions before they rack up a bill")
  .version("0.1.0");

// ── hook (internal) ────────────────────────────────────────────────────────
program
  .command("hook")
  .description("Claude Code hook entrypoint (reads hook JSON from stdin)")
  .action(async () => {
    await runHook();
  });

// ── install ────────────────────────────────────────────────────────────────
program
  .command("install")
  .description("Wire the kill-switch hook into Claude Code settings")
  .option("--global", "Install into ~/.claude/settings.json (default: project ./.claude/settings.json)")
  .option("--command <cmd>", "Override the hook command (default: absolute path to this binary)")
  .action((opts) => {
    const cliPath = fileURLToPath(import.meta.url);
    const { settingsPath, command, added } = installHook(cliPath, process.execPath, {
      global: opts.global,
      command: opts.command,
    });

    const cfg = loadConfig();
    console.log(`✅ Hook installed → ${settingsPath}`);
    console.log(`   Events: ${added.length ? added.join(", ") : "(already present — no change)"}`);
    console.log(`   Command: ${command}`);
    console.log("");
    console.log(`   Caps: session soft ${fmtUSD(cfg.budget.sessionSoftUSD)} / hard ${fmtUSD(cfg.budget.sessionHardUSD)}, ` +
      `daily soft ${fmtUSD(cfg.budget.dailySoftUSD)} / hard ${fmtUSD(cfg.budget.dailyHardUSD)}`);
    console.log(`   Change them: agent-guard config --session-hard 30 --daily-hard 150`);
    console.log("");
    console.log(`   For non-Claude-Code agents (Cursor/Aider/scripts), use the hard proxy instead:`);
    console.log(`     agent-guard proxy   →   ANTHROPIC_BASE_URL=http://localhost:8787 <your-agent>`);
    console.log(`   ⚠ Don't run Claude Code through BOTH the hook and the proxy (double counting).`);
  });

// ── status ───────────────────────────────────────────────────────────────────
program
  .command("status")
  .description("Show current session + daily spend, and real Claude Code plan limits")
  .option("--json", "Output as JSON")
  .action(async (opts) => {
    try {
      // foreground: authorizes background refresh; shorter timeout keeps status snappy.
      await refreshUsage(Date.now(), { foreground: true, timeoutMs: 4000 });
    } catch {
      /* offline / no token */
    }
    const now = Date.now();
    const report = buildStatusReport(now);
    if (opts.json) {
      console.log(JSON.stringify(report, null, 2));
      return;
    }
    console.log("");
    for (const line of formatStatusReport(report, now)) console.log(`  ${line}`);
    console.log("");
  });

// ── usage (real Claude Code plan limits) ─────────────────────────────────────
program
  .command("usage")
  .description("Fetch your REAL Claude Code plan limits (5h + weekly + per-model) from Anthropic")
  .option("--json", "Output as JSON")
  .action(async (opts) => {
    let snap;
    try {
      snap = await refreshUsage(Date.now(), { force: true, foreground: true });
    } catch {
      snap = null;
    }
    const report = buildStatusReport();
    if (opts.json) {
      console.log(JSON.stringify({ fetched: !!snap, limits: report.limits }, null, 2));
      return;
    }
    if (!snap && report.limits.source !== "headers") {
      console.log("Couldn't fetch usage — need a logged-in Claude Code (token in the macOS Keychain or ~/.claude/.credentials.json).");
      console.log("The /api/oauth/usage endpoint is undocumented and may be unavailable.");
      return;
    }
    console.log("");
    for (const line of formatLimitsLines(report.limits)) console.log(line);
    console.log("");
  });

// ── statusline (Claude Code status bar) ──────────────────────────────────────
program
  .command("statusline")
  .description("Claude Code statusLine command: print live plan limits (and keep them fresh)")
  .action(async () => {
    // Read stdin: Claude Code pipes its render JSON, and for Pro/Max sessions that
    // payload carries `rate_limits` — the documented, zero-network source for our
    // 5h + weekly standing. Prefer it over the (undocumented, rate-limited) usage
    // endpoint; we only reach for the network when it isn't there.
    let stdinRaw = "";
    try {
      if (!process.stdin.isTTY) {
        await new Promise<void>((resolve) => {
          process.stdin.setEncoding("utf8");
          process.stdin.on("data", (c) => {
            stdinRaw += c;
          });
          process.stdin.on("end", () => resolve());
          process.stdin.on("error", () => resolve());
          setTimeout(resolve, 200);
        });
      }
    } catch {
      /* ignore */
    }

    // Support hook: `touch ~/.kill-switch/agent-guard/DEBUG_STDIN` and the next
    // render records exactly what Claude Code sent, so we can see which fields are
    // actually available (the documented list may lag the payload). Off by default.
    try {
      if (stdinRaw.trim() && existsSync(join(guardDir(), "DEBUG_STDIN"))) {
        writeFileSync(join(guardDir(), "statusline-stdin.debug.json"), stdinRaw);
      }
    } catch {
      /* diagnostic only */
    }

    let fromStdin = false;
    try {
      if (stdinRaw.trim()) {
        const now = Date.now();
        const snap = parseStatuslineRateLimits(JSON.parse(stdinRaw), now);
        if (snap) {
          const prev = loadLimitsState();
          // Carry forward per-model extras: stdin has no per-model breakdown, and
          // they're display-only (the `usage` command refreshes them from the endpoint).
          saveLimitsState({
            ...prev,
            subscriptionDetected: true,
            snapshot: { ...snap, extras: prev.snapshot?.extras },
          });
          fromStdin = true;
        }
      }
    } catch {
      /* malformed payload — fall through to the endpoint */
    }

    // Network use is now the exception. Without stdin limits (non-subscriber, first
    // render of a session, older Claude Code) the endpoint is our only source, so
    // refresh at the normal cadence. With stdin limits we're already covered for 5h +
    // weekly and only reach out hourly to top up the per-model extras stdin can't
    // give us. Both paths respect the 429/401 backoff.
    try {
      const cliPath = fileURLToPath(import.meta.url);
      triggerBackgroundRefresh(cliPath, Date.now(), fromStdin ? EXTRAS_REFRESH_MS : undefined);
    } catch {
      /* best-effort */
    }
    try {
      process.stdout.write(formatStatusline(buildStatusReport().limits));
    } catch {
      process.stdout.write("🛡");
    }
    process.exit(0);
  });

// ── _refresh-usage (internal: detached throttled refresh) ────────────────────
program
  .command("_refresh-usage", { hidden: true })
  .description("(internal) fetch + persist real plan limits, then exit")
  .action(async () => {
    try {
      await refreshUsage(Date.now(), { force: true });
    } catch {
      /* best-effort */
    }
    process.exit(0);
  });

// ── pause / resume (escape hatch) ────────────────────────────────────────────
program
  .command("pause")
  .description("Temporarily disable enforcement (escape hatch — hook & proxy fail open)")
  .option("--minutes <n>", "Auto-resume after N minutes (default: indefinite)")
  .action((opts) => {
    const mins = opts.minutes !== undefined ? Number(opts.minutes) : NaN;
    if (opts.minutes !== undefined && Number.isFinite(mins)) {
      const until = Date.now() + mins * 60_000;
      writePause(until);
      console.log(`⏸  Enforcement paused until ${new Date(until).toLocaleString()} (${mins} min).`);
    } else {
      writePause();
      console.log("⏸  Enforcement paused indefinitely. Re-arm with `agent-guard resume`.");
    }
    console.log(`   Sentinel: ${pausePath()}`);
  });

program
  .command("resume")
  .description("Re-arm enforcement after a pause")
  .action(() => {
    clearPause();
    console.log("✅ Enforcement re-armed.");
  });

// ── proxy ────────────────────────────────────────────────────────────────────
program
  .command("proxy")
  .description("Start the token-metering proxy (returns HTTP 402 at the hard cap)")
  .option("--port <n>", "Port to listen on", "8787")
  .option("--flavor <name>", "API flavor for usage parsing: anthropic | openai", "anthropic")
  .option("--upstream <url>", "Upstream origin (default: api.anthropic.com / api.openai.com)")
  .action((opts) => {
    const flavor = opts.flavor === "openai" ? "openai" : "anthropic";
    startProxy({
      port: parseInt(opts.port, 10) || 8787,
      flavor,
      upstream: resolveUpstream(flavor, opts.upstream),
    });
  });

// ── config ───────────────────────────────────────────────────────────────────
program
  .command("config")
  .description("View or set budget caps + Claude Code plan limits (written to ~/.kill-switch/agent-guard/config.json)")
  .option("--session-soft <usd>", "Per-session soft cap (warn)")
  .option("--session-hard <usd>", "Per-session hard cap (block)")
  .option("--daily-soft <usd>", "Daily rolling soft cap (warn)")
  .option("--daily-hard <usd>", "Daily rolling hard cap (block)")
  .option("--slack-webhook <url>", "Slack incoming-webhook for breach alerts")
  .option("--plan <tier>", "Claude Code plan: auto | pro | max5 | max20 (subscription limit awareness)")
  .option("--weekly-soft <pct>", "Weekly limit soft threshold, 0–1 (warn)")
  .option("--weekly-danger <pct>", "Weekly limit danger threshold, 0–1")
  .option("--5h-soft <pct>", "5-hour limit soft threshold, 0–1 (warn)")
  .option("--5h-danger <pct>", "5-hour limit danger threshold, 0–1")
  .option("--burn-ratio <n>", "Burn-rate multiplier that triggers a pacing warning")
  .action((opts) => {
    const budgetKeys = ["sessionSoft", "sessionHard", "dailySoft", "dailyHard", "slackWebhook"];
    const limitKeys = ["plan", "weeklySoft", "weeklyDanger", "5hSoft", "5hDanger", "burnRatio"];
    const anyBudget = budgetKeys.some((k) => opts[k] !== undefined);
    const anyLimit = limitKeys.some((k) => opts[k] !== undefined);

    if (!anyBudget && !anyLimit) {
      const cfg = loadConfig();
      console.log(JSON.stringify({ budget: cfg.budget, limits: cfg.limits, slackWebhook: cfg.slackWebhook ? "(set)" : undefined }, null, 2));
      console.log(`\nConfig file: ${configPath()}`);
      return;
    }

    const num = (v: string | undefined) => (v !== undefined ? Number(v) : undefined);
    if (anyBudget) {
      const budget = setBudget({
        sessionSoftUSD: num(opts.sessionSoft),
        sessionHardUSD: num(opts.sessionHard),
        dailySoftUSD: num(opts.dailySoft),
        dailyHardUSD: num(opts.dailyHard),
        slackWebhook: opts.slackWebhook,
      });
      console.log(`✅ Budget saved → ${configPath()}`);
      console.log(JSON.stringify(budget, null, 2));
    }
    if (anyLimit) {
      const limits = setLimits({
        plan: opts.plan,
        weeklySoftPct: num(opts.weeklySoft),
        weeklyDangerPct: num(opts.weeklyDanger),
        fiveHourSoftPct: num(opts["5hSoft"]),
        fiveHourDangerPct: num(opts["5hDanger"]),
        burnRatioWarn: num(opts.burnRatio),
      });
      console.log(`✅ Plan limits saved → ${configPath()}`);
      console.log(JSON.stringify(limits, null, 2));
    }
  });

// ── reset ────────────────────────────────────────────────────────────────────
program
  .command("reset")
  .description("Clear the spend ledger and/or subscription-limit state")
  .option("--all", "Wipe all sessions + subscription-limit state")
  .option("--limits", "Clear subscription detection latch + snapshot only")
  .option("--session <id>", "Clear a single session")
  .option("--today", "Clear sessions active today")
  .action((opts) => {
    console.log(`✅ ${resetLedger({ all: opts.all, limits: opts.limits, session: opts.session, today: opts.today })}`);
  });

program.parseAsync();
