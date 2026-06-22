#!/usr/bin/env node
/**
 * End-to-end demo + check for subscription rate-limit awareness.
 *
 * Spins up a FAKE Anthropic upstream that emits `anthropic-ratelimit-unified-*`
 * headers on a deliberately fast-burning trajectory, points the real metering
 * proxy at it, fires a handful of requests through the proxy (as Claude Code
 * would), and prints `agent-guard status` after each so you can watch the guard
 * move ok → warn → danger and project a lockout — without touching your real
 * Claude account or your real ledger (it runs in a throwaway $HOME).
 *
 * Run it:   npm run e2e        (from packages/agent-guard — builds first)
 * Or:       node scripts/e2e-subscription.mjs
 *
 * Exit code is 0 only if subscription mode latched AND a danger-level pacing
 * assessment was produced, so this doubles as a CI-able smoke test.
 *
 * To test against the REAL thing instead: run `agent-guard proxy` and start
 * Claude Code with `ANTHROPIC_BASE_URL=http://localhost:8787 claude`, do some
 * work, then `agent-guard status`. Same code path, real headers.
 */

import { createServer } from "node:http";
import { mkdtempSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// Isolate ALL on-disk state (ledger/config/limits) into a throwaway home so the
// demo never reads or writes your real ~/.kill-switch.
process.env.HOME = mkdtempSync(join(tmpdir(), "ag-e2e-"));

const here = dirname(fileURLToPath(import.meta.url));
const dist = join(here, "..", "dist", "index.js");
let mod;
try {
  mod = await import(dist);
} catch {
  console.error(`\n✗ Could not load ${dist}\n  Build first:  npm run build   (or use:  npm run e2e)\n`);
  process.exit(2);
}
const {
  startProxy, buildStatusReport, formatLimitsLines, formatStatusline, loadLimitsState,
  setBudget, emptyLedger, setSessionCost, saveLedger, refreshUsage,
} = mod;

const now = Date.now();
const HOUR = 3600_000;
const DAY = 24 * HOUR;

// A scripted "burning fast" trajectory. The weekly window is only ~1 day into a
// 7-day period but already climbing steeply → on pace to lock out well before
// reset. The 5-hour window tightens toward its own reset.
const FIVE_H_RESET = now + 1 * HOUR; // 4h elapsed of a 5h window
const WEEK_RESET = now + 6 * DAY; // 1 day elapsed of a 7d window
const TRAJECTORY = [
  { fiveH: 0.2, weekly: 0.15 },
  { fiveH: 0.45, weekly: 0.35 },
  { fiveH: 0.7, weekly: 0.55 },
  { fiveH: 0.85, weekly: 0.72 },
];

let step = 0;

// ── Fake Anthropic upstream ────────────────────────────────────────────────
const upstream = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const t = TRAJECTORY[Math.min(step, TRAJECTORY.length - 1)];
    res.writeHead(200, {
      "content-type": "application/json",
      "anthropic-ratelimit-unified-status": t.weekly >= 0.6 ? "warning" : "allowed",
      "anthropic-ratelimit-unified-5h-utilization": String(t.fiveH),
      "anthropic-ratelimit-unified-5h-reset": String(FIVE_H_RESET),
      "anthropic-ratelimit-unified-7d-utilization": String(t.weekly),
      "anthropic-ratelimit-unified-7d-reset": String(WEEK_RESET),
      "anthropic-ratelimit-unified-7d-status": t.weekly >= 0.6 ? "warning" : "allowed",
    });
    res.end(JSON.stringify({ model: "claude-sonnet-4", usage: { input_tokens: 1200, output_tokens: 600 } }));
  });
});

function listen(server) {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  // ── Scenario 0: real limits via the /api/oauth/usage endpoint (no proxy) ──
  console.log("  Fetching REAL limits from a mock /api/oauth/usage endpoint (no proxy)…\n");
  mkdirSync(join(homedir(), ".claude"), { recursive: true });
  writeFileSync(join(homedir(), ".claude", ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "e2e-token" } }));
  process.env.AGENT_GUARD_NO_KEYCHAIN = "1";
  const usageServer = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      five_hour: { utilization: 12, resets_at: new Date(now + 3 * HOUR).toISOString() },
      seven_day: { utilization: 17, resets_at: new Date(now + 4 * DAY).toISOString() },
      seven_day_sonnet: { utilization: 1, resets_at: null },
    }));
  });
  const usagePort = await listen(usageServer);
  process.env.AGENT_GUARD_USAGE_URL = `http://127.0.0.1:${usagePort}`;
  await refreshUsage(Date.now(), { force: true, foreground: true });
  const usageReport = buildStatusReport().limits;
  for (const line of formatLimitsLines(usageReport)) console.log(`  ${line}`);
  console.log("");
  const usageWeeklyWin = usageReport.windows.find((w) => w.window === "weekly");
  const usageWeekly = Math.round((usageWeeklyWin?.utilization || 0) * 100);
  const usageOk = usageReport.source === "headers" && usageWeekly === 17;
  // Pace-awareness: 17% used with ~4 days left is UNDER the ~14%/day budget, so it
  // must read 🟢 (ok), and the statusline must carry the day-of-week context.
  const usageStatusline = formatStatusline(usageReport);
  console.log(`  statusline: ${usageStatusline}\n`);
  const usagePaceOk =
    usageWeeklyWin?.level === "ok" &&
    usageStatusline.includes("🟢") &&
    /wk 17% \(\d+(\.\d+)?d left\)/.test(usageStatusline);
  usageServer.close();
  delete process.env.AGENT_GUARD_USAGE_URL;

  const upPort = await listen(upstream);
  const proxy = startProxy({ port: 0, flavor: "anthropic", upstream: `http://127.0.0.1:${upPort}` });
  const proxyPort = await listen(proxy);

  console.log(`\n  fake upstream  : http://127.0.0.1:${upPort}`);
  console.log(`  guard proxy    : http://127.0.0.1:${proxyPort}`);
  console.log(`  throwaway HOME : ${process.env.HOME}\n`);
  console.log("  Simulating Claude Code burning through a weekly plan limit ~4× faster than sustainable…\n");

  let sawDanger = false;

  for (step = 0; step < TRAJECTORY.length; step++) {
    const resp = await fetch(`http://127.0.0.1:${proxyPort}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-agent-guard-session": "e2e-demo" },
      body: JSON.stringify({ model: "claude-sonnet-4", messages: [] }),
    });
    // Drain so the proxy's meter/capture branch completes.
    await resp.text();
    // Capture is fire-and-forget after the response tees; let it settle.
    await sleep(120);

    const report = buildStatusReport();
    const lines = formatLimitsLines(report.limits);
    console.log(`  ── request ${step + 1} ─────────────────────────────────────────────`);
    for (const l of lines) console.log(`  ${l}`);
    console.log("");
    if (report.limits.level === "danger") sawDanger = true;
  }

  const state = loadLimitsState();
  const latched = state.subscriptionDetected === true;

  // Show the write-once raw-header diagnostic the proxy logged on first sight —
  // this is the "verification is one cat away" check for Anthropic's value formats.
  let loggedHeaders = false;
  try {
    const events = readFileSync(join(homedir(), ".kill-switch", "agent-guard", "events.jsonl"), "utf8");
    const line = events.split("\n").map((l) => l.trim()).filter(Boolean)
      .map((l) => JSON.parse(l)).find((e) => e.kind === "unified-headers-observed");
    if (line) {
      loggedHeaders = true;
      console.log("  ── raw unified-* headers captured (events.jsonl) ─────────────");
      for (const [k, v] of Object.entries(line.headers)) console.log(`  ${k}: ${v}`);
      console.log("");
    }
  } catch {
    /* diagnostic only */
  }

  upstream.close();
  proxy.close();

  // ── F1 scenario: a billed (OpenAI-flavor) agent sharing the proxy must STILL
  // hit the dollar wall, even though subscription mode is now latched globally.
  console.log("  Now a billed OpenAI-flavor agent (over its dollar cap) runs through the proxy…\n");
  setBudget({ sessionHardUSD: 1, dailyHardUSD: 1000 });
  const led = emptyLedger();
  setSessionCost(led, "billed-agent", 50, 100, 100, now); // already $50, over the $1 cap
  saveLedger(led);

  let billedUpstreamHit = false;
  const billedUpstream = createServer((_req, res) => {
    billedUpstreamHit = true;
    res.writeHead(200, { "content-type": "application/json" });
    res.end("{}");
  });
  const billedUpPort = await listen(billedUpstream);
  const billedProxy = startProxy({ port: 0, flavor: "openai", upstream: `http://127.0.0.1:${billedUpPort}` });
  const billedProxyPort = await listen(billedProxy);

  const billedRes = await fetch(`http://127.0.0.1:${billedProxyPort}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-agent-guard-session": "billed-agent" },
    body: "{}",
  });
  await sleep(60);
  const walled = billedRes.status === 402 && billedUpstreamHit === false;
  billedUpstream.close();
  billedProxy.close();

  console.log("  ── result ───────────────────────────────────────────────────");
  console.log(`  REAL limits via usage endpoint : ${usageOk ? "✓" : "✗"}  (weekly ${usageWeekly}%)`);
  console.log(`  pace-aware 🟢 + days-left       : ${usagePaceOk ? "✓" : "✗"}  (under ~14%/day budget)`);
  console.log(`  subscription mode latched      : ${latched ? "✓" : "✗"}`);
  console.log(`  reached danger (lockout)       : ${sawDanger ? "✓" : "✗"}`);
  console.log(`  raw headers logged once        : ${loggedHeaders ? "✓" : "✗"}`);
  console.log(`  subscription session blocked   : ✗ (alert-only by design)`);
  console.log(`  billed agent STILL 402'd (F1)  : ${walled ? "✓" : "✗"}  (status ${billedRes.status})\n`);

  if (usageOk && usagePaceOk && latched && sawDanger && loggedHeaders && walled) {
    console.log("  ✅ e2e PASS — real limits from the usage endpoint, pace-aware standing, proxy pacing, and the dollar wall all hold.\n");
    process.exit(0);
  }
  console.error("  ❌ e2e FAIL — expected: usage endpoint + pace-aware 🟢 + latch + danger + headers logged + billed agent walled.\n");
  process.exit(1);
}

main().catch((err) => {
  console.error("  ❌ e2e ERROR:", err);
  try { upstream.close(); } catch {}
  process.exit(1);
});
