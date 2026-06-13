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
} from "./config.js";
import { loadLedger, rollingDailyCost } from "./ledger.js";
import { evaluate } from "./budget.js";
import { fmtUSD } from "./cost.js";
import { installHook, setBudget, setLimits, resetLedger } from "./ops.js";
import { buildStatusReport, formatLimitsLines } from "./report.js";

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
  .description("Show current session + daily spend against the budget")
  .option("--json", "Output as JSON")
  .action((opts) => {
    const cfg = loadConfig();
    const ledger = loadLedger();
    const now = Date.now();
    const dailyUSD = rollingDailyCost(ledger, now);
    const sessions = Object.entries(ledger.sessions)
      .filter(([, s]) => now - s.lastAt < 24 * 60 * 60 * 1000)
      .sort((a, b) => b[1].lastAt - a[1].lastAt);

    const topSession = sessions[0]?.[1].costUSD ?? 0;
    const verdict = evaluate({ sessionUSD: topSession, dailyUSD }, cfg.budget);

    if (opts.json) {
      console.log(JSON.stringify({
        budget: cfg.budget,
        dailyUSD,
        verdict: verdict.level,
        reasons: verdict.reasons,
        sessions: sessions.map(([id, s]) => ({ id, ...s })),
        limits: buildStatusReport(now).limits,
      }, null, 2));
      return;
    }

    const bar = (spent: number, hard: number) => {
      const pct = hard > 0 ? Math.min(100, Math.round((spent / hard) * 100)) : 0;
      const filled = Math.round(pct / 5);
      return `[${"█".repeat(filled)}${"░".repeat(20 - filled)}] ${pct}%`;
    };

    const paused = isPaused(now);
    const icon = paused ? "⏸ " : verdict.level === "block" ? "🛑" : verdict.level === "warn" ? "⚠️ " : "✅";
    console.log(`${icon} agent-guard — ${paused ? "PAUSED (enforcement off)" : verdict.level.toUpperCase()}`);
    if (paused) {
      const until = pauseExpiry();
      console.log(until ? `   resumes ${new Date(until).toLocaleString()}` : "   paused indefinitely — `agent-guard resume` to re-arm");
    }
    console.log("");
    console.log(`Daily (rolling 24h): ${fmtUSD(dailyUSD)} / ${fmtUSD(cfg.budget.dailyHardUSD)}  ${bar(dailyUSD, cfg.budget.dailyHardUSD)}`);
    console.log("");
    if (sessions.length === 0) {
      console.log("No active sessions in the last 24h.");
    } else {
      console.log("Active sessions (24h):");
      for (const [id, s] of sessions.slice(0, 8)) {
        console.log(`  ${fmtUSD(s.costUSD).padStart(9)} / ${fmtUSD(cfg.budget.sessionHardUSD)}  ${bar(s.costUSD, cfg.budget.sessionHardUSD)}  ${id}`);
      }
    }
    if (verdict.reasons.length) {
      console.log("");
      for (const r of verdict.reasons) console.log(`  • ${r}`);
    }

    // Subscription rate-limit pacing (Claude Code Pro/Max).
    const limitLines = formatLimitsLines(buildStatusReport(now).limits, now);
    if (limitLines.length) {
      console.log("");
      for (const line of limitLines) console.log(line);
    }
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
