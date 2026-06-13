/**
 * Token-metering proxy — `agent-guard proxy`.
 *
 * A local reverse proxy you point an agent's API base URL at:
 *   ANTHROPIC_BASE_URL=http://localhost:8787 claude
 *   OPENAI_BASE_URL=http://localhost:8787/v1 aider
 *
 * It forwards every request to the real upstream, parses the *real* usage out of
 * the response (streaming or not), prices it, and accumulates spend in the shared
 * ledger. Once the hard cap is reached it stops forwarding and returns HTTP 402 —
 * a wall the agent cannot argue its way past, regardless of whether it supports
 * hooks. This is the agent-agnostic backstop to the Claude Code hook.
 *
 * Double-count caveat: don't run Claude Code through BOTH the hook and the proxy
 * — they'd each meter the same dollars. Hook for Claude Code; proxy for everything
 * else (Cursor, Aider, raw scripts). See README.
 */

import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import { Readable } from "node:stream";
import { loadConfig, mergedPricing, isPaused, type GuardConfig } from "./config.js";
import { MODEL_PRICING } from "./pricing.js";
import { costForUsage, fmtUSD, type TokenUsage } from "./cost.js";
import {
  loadLedger,
  saveLedger,
  addSessionCost,
  rollingDailyCost,
  prune,
  type Ledger,
} from "./ledger.js";
import { evaluate } from "./budget.js";
import { dispatchAlert } from "./alert.js";
import { assertSafeEndpoint, warnIfUnexpectedHost } from "./net.js";
import {
  parseUnifiedHeaders,
  recordHeaders,
  unifiedHeaderDump,
  logUnifiedHeaders,
  loadLimitsState,
  saveLimitsState,
  limitNotifyKey,
  WINDOW_MS,
  type LimitsState,
} from "./limits.js";
import { assessSnapshot, worstLevel } from "./pacing.js";

export interface ProxyOptions {
  port: number;
  /** Upstream origin, e.g. https://api.anthropic.com */
  upstream: string;
  /** "anthropic" | "openai" — controls usage parsing. */
  flavor: "anthropic" | "openai";
}

const UPSTREAMS: Record<string, string> = {
  anthropic: "https://api.anthropic.com",
  openai: "https://api.openai.com",
};

function todayKey(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

/** Parse a non-streaming JSON body into usage + model. Exported for testing. */
export function parseJsonUsage(flavor: string, text: string): { model: string; usage: TokenUsage } | null {
  try {
    const body = JSON.parse(text);
    const u = body.usage;
    if (!u) return null;
    if (flavor === "openai") {
      return {
        model: body.model || "unknown",
        usage: { inputTokens: u.prompt_tokens || 0, outputTokens: u.completion_tokens || 0 },
      };
    }
    return {
      model: body.model || "unknown",
      usage: {
        inputTokens: u.input_tokens || 0,
        outputTokens: u.output_tokens || 0,
        cacheCreationTokens: u.cache_creation_input_tokens || 0,
        cacheReadTokens: u.cache_read_input_tokens || 0,
      },
    };
  } catch {
    return null;
  }
}

/** Parse accumulated SSE text into usage + model (Anthropic message_start/message_delta, OpenAI final chunk). Exported for testing. */
export function parseStreamUsage(flavor: string, sse: string): { model: string; usage: TokenUsage } | null {
  let model = "unknown";
  const usage: TokenUsage = { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 };
  let found = false;

  for (const line of sse.split("\n")) {
    const t = line.trim();
    if (!t.startsWith("data:")) continue;
    const payload = t.slice(5).trim();
    if (!payload || payload === "[DONE]") continue;
    let data: any;
    try {
      data = JSON.parse(payload);
    } catch {
      continue;
    }

    if (flavor === "anthropic") {
      if (data.type === "message_start" && data.message?.usage) {
        const u = data.message.usage;
        model = data.message.model || model;
        usage.inputTokens += u.input_tokens || 0;
        usage.cacheCreationTokens = (usage.cacheCreationTokens || 0) + (u.cache_creation_input_tokens || 0);
        usage.cacheReadTokens = (usage.cacheReadTokens || 0) + (u.cache_read_input_tokens || 0);
        found = true;
      } else if (data.type === "message_delta" && data.usage) {
        usage.outputTokens += data.usage.output_tokens || 0;
        found = true;
      }
    } else {
      // OpenAI: usage arrives on the final chunk when stream_options.include_usage is set.
      if (data.usage) {
        model = data.model || model;
        usage.inputTokens += data.usage.prompt_tokens || 0;
        usage.outputTokens += data.usage.completion_tokens || 0;
        found = true;
      }
    }
  }

  return found ? { model, usage } : null;
}

function send402(res: ServerResponse, sessionUSD: number, dailyUSD: number, reasons: string[]): void {
  const body = JSON.stringify({
    type: "error",
    error: {
      type: "kill_switch_budget_exceeded",
      message:
        `Kill Switch blocked this request: hard spend cap reached. ` +
        `Session ${fmtUSD(sessionUSD)}, daily ${fmtUSD(dailyUSD)}. ${reasons.join(" ")} ` +
        `Raise the cap (AGENT_GUARD_SESSION_HARD / AGENT_GUARD_DAILY_HARD) or run \`agent-guard reset\`.`,
    },
  });
  res.writeHead(402, { "content-type": "application/json", "x-kill-switch": "blocked" });
  res.end(body);
}

/** Meter a completed response's usage into the ledger. */
function meter(
  cfg: GuardConfig,
  ledger: Ledger,
  sessionId: string,
  parsed: { model: string; usage: TokenUsage } | null,
  now: number,
): void {
  if (!parsed) return;
  const pricing = mergedPricing(cfg, MODEL_PRICING);
  const delta = costForUsage(parsed.model, parsed.usage, pricing);
  addSessionCost(ledger, sessionId, delta, parsed.usage.inputTokens, parsed.usage.outputTokens, now);
  prune(ledger, now);
  saveLedger(ledger);
}

/**
 * Read Anthropic's `unified-*` rate-limit headers off a response, persist the
 * snapshot, latch subscription mode on, and fire a deduped pacing alert when a
 * window crosses into warn/danger. Returns true if subscription headers were
 * seen. Alert-only by design — this never blocks (a subscription session already
 * paid a flat fee; the scarce resource is quota, and Anthropic's own limit is
 * the real wall).
 */
function captureLimits(cfg: GuardConfig, headers: Headers, sessionId: string, now: number): boolean {
  // Flatten to a lowercased record so we can both parse and dump the raw values.
  const rec: Record<string, string> = {};
  headers.forEach((v, k) => {
    rec[k.toLowerCase()] = v;
  });

  const snap = parseUnifiedHeaders(recordHeaders(rec), now);
  if (!snap) return false;

  const state = loadLimitsState();
  // Write-once raw-header diagnostic for format verification (`cat events.jsonl`).
  if (!state.headersLoggedAt) {
    logUnifiedHeaders(unifiedHeaderDump(rec), now);
    state.headersLoggedAt = now;
  }

  // Which windows newly cross into warn/danger (dedup vs. what we've alerted).
  const assessments = assessSnapshot(snap, cfg.limits, now);
  const newlyNotified: string[] = [];
  const fresh = assessments.filter((a) => {
    if (a.level === "ok") return false;
    const key = limitNotifyKey(a.window, a.level, a.resetAt);
    if (state.notified[key]) return false;
    newlyNotified.push(key);
    return true;
  });

  // Re-read at write time to mitigate read-modify-write races: the file write is
  // atomic (no corruption), but a concurrent response could otherwise clobber a
  // newer snapshot or a just-set notified flag. Keep the newest snapshot by
  // observedAt; union the notified flags.
  const onDisk = loadLimitsState();
  const keepNewer = onDisk.snapshot && onDisk.snapshot.observedAt > snap.observedAt;
  const merged: LimitsState = {
    version: 1,
    subscriptionDetected: true,
    snapshot: keepNewer ? onDisk.snapshot : snap,
    notified: { ...onDisk.notified, ...state.notified },
    headersLoggedAt: onDisk.headersLoggedAt ?? state.headersLoggedAt,
  };
  for (const key of newlyNotified) merged.notified[key] = true;
  saveLimitsState(merged);

  if (fresh.length) {
    const level = worstLevel(fresh);
    dispatchAlert(cfg, {
      ts: now,
      source: "proxy",
      kind: "limit",
      sessionId,
      level: level === "danger" ? "danger" : "warn",
      sessionUSD: 0,
      dailyUSD: 0,
      reasons: fresh.map((a) => a.message),
      action: level === "danger" ? "on pace to lock out before reset" : "approaching plan limit",
      limits: fresh.map((a) => ({ window: a.window, utilization: a.utilization, resetAt: a.resetAt, level: a.level })),
    }).catch(() => {});
  }

  return true;
}

function planIsSubscription(plan: string): boolean {
  return plan === "pro" || plan === "max5" || plan === "max20";
}

/**
 * Should the dollar hard-cap 402 be suppressed for THIS proxy/request?
 *
 * Only for the **Anthropic** flavor — an OpenAI / other-API agent is billed per
 * token and must keep its wall, even if a *different* (Claude Code) session once
 * latched subscription mode on the shared `limits.json`. And only when we have a
 * live reason to believe this is a flat-fee plan: either the operator pinned a
 * subscription tier (`--plan`), or we saw real `unified-*` headers **recently**
 * (within the 5-hour window). A stale, months-old detection must never disarm
 * the wall — that's the bug this replaces (a permanent global latch).
 *
 * Residual edge: an Anthropic-flavor *API-key* agent run within 5h of a Claude
 * Code subscription session (or under a pinned `--plan`) would also be
 * suppressed. That's a narrow, opt-in-ish overlap; the common dual-use case
 * (Claude Code + an OpenAI-flavor agent) is fully covered by the flavor gate.
 *
 * Trust model: in `auto` mode this trusts the upstream's `unified-*` headers, so
 * a malicious/compromised Anthropic-compatible gateway could disarm the dollar
 * wall by emitting fake subscription headers. That upstream already holds your
 * API key (you pointed the proxy at it), and `net.ts` enforces https + warns on
 * an unexpected host — so this isn't a new trust boundary. Pin `--plan` if you
 * want suppression to be an explicit, upstream-independent choice.
 */
function dollarWallSuppressed(
  cfg: GuardConfig,
  flavor: string,
  state: LimitsState,
  now: number,
): boolean {
  if (flavor !== "anthropic") return false;
  if (planIsSubscription(cfg.limits.plan)) return true;
  const snap = state.snapshot;
  return !!snap && now - snap.observedAt < WINDOW_MS["5h"] && !!(snap.fiveHour || snap.weekly);
}

export function startProxy(opts: ProxyOptions): Server {
  const cfg = loadConfig();
  const upstreamOrigin = assertSafeEndpoint(opts.upstream, "upstream").replace(/\/$/, "");
  const blockedNotified: Record<string, boolean> = {};

  const server = createServer(async (req, res) => {
    const now = Date.now();
    const sessionId = (req.headers["x-agent-guard-session"] as string) || `proxy:${todayKey(now)}`;

    // 1) Pre-flight budget check — block before spending anything.
    // Escape hatch: while a human has paused enforcement, never block (but still meter).
    // Subscription mode is ALERT-ONLY: a flat-fee Pro/Max session is paced, not
    // dollar-gated. Scope that suppression tightly (flavor + pinned plan / fresh
    // headers) so it never disarms the wall for a genuinely-billed agent.
    let subscriptionMode = dollarWallSuppressed(cfg, opts.flavor, loadLimitsState(), now);
    const ledger = loadLedger();
    const sessionUSD = ledger.sessions[sessionId]?.costUSD ?? 0;
    const dailyUSD = rollingDailyCost(ledger, now);
    const verdict = evaluate({ sessionUSD, dailyUSD }, cfg.budget);

    if (verdict.level === "block" && !isPaused(now) && !subscriptionMode) {
      if (!blockedNotified[sessionId]) {
        blockedNotified[sessionId] = true;
        dispatchAlert(cfg, {
          ts: now, source: "proxy", sessionId, level: "block",
          sessionUSD, dailyUSD, reasons: verdict.reasons, action: "returned HTTP 402",
        }).catch(() => {});
      }
      send402(res, sessionUSD, dailyUSD, verdict.reasons);
      return;
    }

    // 2) Forward to upstream.
    let reqBody: Buffer;
    try {
      reqBody = await readBody(req);
    } catch {
      res.writeHead(400).end("bad request body");
      return;
    }

    const targetUrl = `${upstreamOrigin}${req.url ?? "/"}`;
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) {
      if (v === undefined) continue;
      const key = k.toLowerCase();
      if (["host", "content-length", "connection"].includes(key)) continue;
      headers.set(k, Array.isArray(v) ? v.join(", ") : v);
    }

    let upstream: Response;
    try {
      upstream = await fetch(targetUrl, {
        method: req.method,
        headers,
        body: req.method === "GET" || req.method === "HEAD" ? undefined : new Uint8Array(reqBody),
      });
    } catch (err) {
      res.writeHead(502, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "kill-switch proxy: upstream fetch failed", detail: String(err) }));
      return;
    }

    // 2.5) Read Anthropic's subscription rate-limit headers (alert-only). If this
    // response carried them, treat the session as subscription for alert purposes
    // too — even if the pre-flight check (run before we'd seen any headers) didn't.
    if (opts.flavor === "anthropic") {
      try {
        if (captureLimits(cfg, upstream.headers, sessionId, Date.now())) subscriptionMode = true;
      } catch {
        /* limit capture must never break the proxied response */
      }
    }

    // 3) Relay status + headers.
    const respHeaders: Record<string, string> = {};
    upstream.headers.forEach((v, k) => {
      if (!["content-encoding", "content-length", "transfer-encoding", "connection"].includes(k.toLowerCase())) {
        respHeaders[k] = v;
      }
    });
    res.writeHead(upstream.status, respHeaders);

    const isStream = (upstream.headers.get("content-type") || "").includes("text/event-stream");

    if (!upstream.body) {
      res.end();
      return;
    }

    // 4) Tee the body: one branch to the client, one to accumulate for metering.
    const [toClient, toMeter] = upstream.body.tee();

    // Pipe to client.
    Readable.fromWeb(toClient as any).pipe(res);

    // Accumulate the meter branch, then price it.
    (async () => {
      try {
        const reader = (toMeter as ReadableStream<Uint8Array>).getReader();
        const decoder = new TextDecoder();
        let buf = "";
        // Cap accumulation for non-stream JSON to avoid holding giant bodies; SSE we need fully.
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
        }
        const parsed = isStream
          ? parseStreamUsage(opts.flavor, buf)
          : parseJsonUsage(opts.flavor, buf);

        // Re-load ledger (the request may have been concurrent) and meter.
        const fresh = loadLedger();
        meter(cfg, fresh, sessionId, parsed, Date.now());

        // Post-meter soft-cap alert (once). Skipped in subscription mode — the
        // dollars are meaningless on a flat-fee plan, so a USD warn is just noise.
        const after = fresh.sessions[sessionId]?.costUSD ?? 0;
        const afterDaily = rollingDailyCost(fresh, Date.now());
        const v2 = evaluate({ sessionUSD: after, dailyUSD: afterDaily }, cfg.budget);
        if (v2.level === "warn" && !subscriptionMode && !blockedNotified[`warn:${sessionId}`]) {
          blockedNotified[`warn:${sessionId}`] = true;
          dispatchAlert(cfg, {
            ts: Date.now(), source: "proxy", sessionId, level: "warn",
            sessionUSD: after, dailyUSD: afterDaily, reasons: v2.reasons, action: "soft cap warning",
          }).catch(() => {});
        }
      } catch {
        /* metering must never break the proxied response */
      }
    })();
  });

  // Bind to loopback only — this proxy forwards the caller's LLM API key
  // upstream, so it must never be reachable from the local network.
  server.listen(opts.port, "127.0.0.1", () => {
    process.stdout.write(
      `🛡  agent-guard proxy on http://localhost:${opts.port} → ${upstreamOrigin} (${opts.flavor})\n` +
        `   Caps: session hard ${fmtUSD(cfg.budget.sessionHardUSD)}, daily hard ${fmtUSD(cfg.budget.dailyHardUSD)}\n` +
        (opts.flavor === "anthropic"
          ? `   Subscription mode: reads Anthropic rate-limit headers → paces your Pro/Max plan (alert-only)\n`
          : "") +
        `   Point your agent at it, e.g.:\n` +
        (opts.flavor === "anthropic"
          ? `     ANTHROPIC_BASE_URL=http://localhost:${opts.port} claude\n`
          : `     OPENAI_BASE_URL=http://localhost:${opts.port}/v1 aider\n`),
    );
  });

  return server;
}

export function resolveUpstream(flavor: string, explicit?: string): string {
  const upstream = explicit || UPSTREAMS[flavor] || UPSTREAMS.anthropic;
  assertSafeEndpoint(upstream, "upstream");
  if (explicit) {
    const expected = new URL(UPSTREAMS[flavor] || UPSTREAMS.anthropic).hostname;
    warnIfUnexpectedHost(upstream, expected, "--upstream");
  }
  return upstream;
}
