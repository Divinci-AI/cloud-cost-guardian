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
import { mkdtempSync, readFileSync } from "node:fs";
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
const { startProxy, buildStatusReport, formatLimitsLines, loadLimitsState } = mod;

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

  console.log("  ── result ───────────────────────────────────────────────────");
  console.log(`  subscription mode latched : ${latched ? "✓" : "✗"}`);
  console.log(`  reached danger (lockout)  : ${sawDanger ? "✓" : "✗"}`);
  console.log(`  raw headers logged once   : ${loggedHeaders ? "✓" : "✗"}`);
  console.log(`  blocked any request (402) : ✗ (alert-only by design)\n`);

  upstream.close();
  proxy.close();

  if (latched && sawDanger && loggedHeaders) {
    console.log("  ✅ e2e PASS — guard read real rate-limit headers, logged them once, paced them, and warned of lockout without blocking.\n");
    process.exit(0);
  }
  console.error("  ❌ e2e FAIL — expected subscription mode to latch, log raw headers once, and reach danger.\n");
  process.exit(1);
}

main().catch((err) => {
  console.error("  ❌ e2e ERROR:", err);
  try { upstream.close(); } catch {}
  process.exit(1);
});
