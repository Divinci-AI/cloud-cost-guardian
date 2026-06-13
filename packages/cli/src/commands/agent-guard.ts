/**
 * `ks guard` — the agent-guard surface inside the main Kill Switch CLI.
 *
 * Thin wrapper over @kill-switch/agent-guard's exported ops so users get one
 * tool name. Local-only: these read/write the on-disk ledger + config and
 * Claude Code settings; they do NOT call the Guardian API (the hook/proxy report
 * breaches to the API on their own).
 */

import { Command } from "commander";
import { createRequire } from "node:module";
import {
  buildStatusReport,
  installHook,
  setBudget,
  setLimits,
  resetLedger,
  writePause,
  clearPause,
  pauseExpiry,
  configPath,
  pausePath,
  startProxy,
  resolveUpstream,
  formatStatusReport,
  formatLimitsLines,
  refreshUsage,
} from "@kill-switch/agent-guard";
import { outputJson, colors as c } from "../output.js";

/** Resolve the absolute path to the agent-guard hook entry (its dist/cli.js). */
function agentGuardCliPath(): string {
  const require = createRequire(import.meta.url);
  // Resolve the package entry, then point at the sibling cli.js the hook uses.
  const pkgMain = require.resolve("@kill-switch/agent-guard");
  return pkgMain.replace(/index\.js$/, "cli.js");
}

export function registerAgentGuardCommands(program: Command) {
  const guard = program
    .command("guard")
    .description("Kill Switch for coding agents — cap Claude Code / Cursor / Aider spend");

  // ks guard status
  guard
    .command("status")
    .description("Show current session + daily agent spend, and real Claude Code plan limits")
    .action(async () => {
      const json = program.opts().json;
      // Pull fresh real limits from Anthropic's usage endpoint (throttled; never fails status).
      // foreground: authorizes background refresh; shorter timeout keeps status snappy.
      try {
        await refreshUsage(Date.now(), { foreground: true, timeoutMs: 4000 });
      } catch {
        /* offline / no token → fall back to whatever's cached */
      }
      const report = buildStatusReport();

      if (json) {
        outputJson(report);
        return;
      }

      console.log("");
      for (const line of formatStatusReport(report)) console.log(`  ${line}`);
      console.log("");
    });

  // ks guard usage — force-fetch real plan limits from Anthropic's usage endpoint
  guard
    .command("usage")
    .description("Fetch your REAL Claude Code plan limits (5h + weekly + per-model) from Anthropic")
    .action(async () => {
      const json = program.opts().json;
      let snap;
      try {
        snap = await refreshUsage(Date.now(), { force: true, foreground: true });
      } catch {
        snap = null;
      }
      const report = buildStatusReport();
      if (json) return outputJson({ fetched: !!snap, limits: report.limits });
      if (!snap && report.limits.source !== "headers") {
        console.log(c.yellow("Couldn't fetch usage."));
        console.log(c.dim("  Need a logged-in Claude Code (token in the macOS Keychain or ~/.claude/.credentials.json)."));
        console.log(c.dim("  The /api/oauth/usage endpoint is undocumented — it may be unavailable."));
        return;
      }
      console.log("");
      for (const line of formatLimitsLines(report.limits)) console.log(`  ${line}`);
      console.log("");
    });

  // ks guard install
  guard
    .command("install")
    .description("Wire the agent-guard hook into Claude Code settings")
    .option("--global", "Install into ~/.claude/settings.json (default: ./.claude/settings.json)")
    .action((opts) => {
      const json = program.opts().json;
      const { settingsPath, command, added } = installHook(agentGuardCliPath(), process.execPath, { global: opts.global });
      if (json) {
        outputJson({ settingsPath, command, added });
        return;
      }
      console.log(`✅ Hook installed → ${settingsPath}`);
      console.log(`   Events: ${added.length ? added.join(", ") : "(already present — no change)"}`);
      console.log(c.dim(`   Command: ${command}`));
      console.log(c.dim(`   Set caps with: ks guard config --session-hard 30 --daily-hard 150`));
    });

  // ks guard config
  guard
    .command("config")
    .description("View or set agent-guard budget caps + Claude Code plan limits")
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
      const json = program.opts().json;
      const budgetKeys = ["sessionSoft", "sessionHard", "dailySoft", "dailyHard", "slackWebhook"];
      const limitKeys = ["plan", "weeklySoft", "weeklyDanger", "5hSoft", "5hDanger", "burnRatio"];
      const anyBudget = budgetKeys.some((k) => opts[k] !== undefined);
      const anyLimit = limitKeys.some((k) => opts[k] !== undefined);

      if (!anyBudget && !anyLimit) {
        const report = buildStatusReport();
        if (json) return outputJson({ budget: report.budget, limits: report.limits, configPath: configPath() });
        console.log(JSON.stringify({ budget: report.budget, limits: report.limits }, null, 2));
        console.log(c.dim(`\nConfig file: ${configPath()}`));
        return;
      }

      const num = (v: string | undefined) => (v !== undefined ? Number(v) : undefined);
      const out: Record<string, unknown> = {};
      if (anyBudget) {
        out.budget = setBudget({
          sessionSoftUSD: num(opts.sessionSoft),
          sessionHardUSD: num(opts.sessionHard),
          dailySoftUSD: num(opts.dailySoft),
          dailyHardUSD: num(opts.dailyHard),
          slackWebhook: opts.slackWebhook,
        });
      }
      if (anyLimit) {
        out.limits = setLimits({
          plan: opts.plan,
          weeklySoftPct: num(opts.weeklySoft),
          weeklyDangerPct: num(opts.weeklyDanger),
          fiveHourSoftPct: num(opts["5hSoft"]),
          fiveHourDangerPct: num(opts["5hDanger"]),
          burnRatioWarn: num(opts.burnRatio),
        });
      }
      if (json) return outputJson({ ...out, saved: true });
      console.log(`✅ Saved → ${configPath()}`);
      console.log(JSON.stringify(out, null, 2));
    });

  // ks guard pause
  guard
    .command("pause")
    .description("Temporarily disable enforcement (escape hatch)")
    .option("--minutes <n>", "Auto-resume after N minutes (default: indefinite)")
    .action((opts) => {
      const json = program.opts().json;
      const mins = opts.minutes !== undefined ? Number(opts.minutes) : NaN;
      if (opts.minutes !== undefined && Number.isFinite(mins)) {
        const until = Date.now() + mins * 60_000;
        writePause(until);
        if (json) return outputJson({ paused: true, until });
        console.log(`⏸  Enforcement paused until ${new Date(until).toLocaleString()} (${mins} min).`);
      } else {
        writePause();
        if (json) return outputJson({ paused: true, until: null });
        console.log("⏸  Enforcement paused indefinitely. Re-arm with `ks guard resume`.");
      }
      console.log(c.dim(`   Sentinel: ${pausePath()}`));
    });

  // ks guard resume
  guard
    .command("resume")
    .description("Re-arm enforcement after a pause")
    .action(() => {
      const json = program.opts().json;
      clearPause();
      if (json) return outputJson({ paused: false });
      console.log("✅ Enforcement re-armed.");
    });

  // ks guard reset
  guard
    .command("reset")
    .description("Clear the agent spend ledger and/or subscription-limit state")
    .option("--all", "Wipe all sessions + subscription-limit state")
    .option("--limits", "Clear subscription detection latch + snapshot only")
    .option("--session <id>", "Clear a single session")
    .option("--today", "Clear sessions active today")
    .action((opts) => {
      const json = program.opts().json;
      const msg = resetLedger({ all: opts.all, limits: opts.limits, session: opts.session, today: opts.today });
      if (json) return outputJson({ message: msg });
      console.log(`✅ ${msg}`);
    });

  // ks guard proxy
  guard
    .command("proxy")
    .description("Start the token-metering proxy (HTTP 402 at the hard cap) for non-Claude-Code agents")
    .option("--port <n>", "Port to listen on", "8787")
    .option("--flavor <name>", "API flavor: anthropic | openai", "anthropic")
    .option("--upstream <url>", "Upstream origin (default: api.anthropic.com / api.openai.com)")
    .action((opts) => {
      const flavor = opts.flavor === "openai" ? "openai" : "anthropic";
      startProxy({
        port: parseInt(opts.port, 10) || 8787,
        flavor,
        upstream: resolveUpstream(flavor, opts.upstream),
      });
    });
}
