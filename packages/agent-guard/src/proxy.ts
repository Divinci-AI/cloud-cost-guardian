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

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
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

/** Parse a non-streaming JSON body into usage + model. */
function parseJsonUsage(flavor: string, text: string): { model: string; usage: TokenUsage } | null {
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

/** Parse accumulated SSE text into usage + model (Anthropic message_start/message_delta, OpenAI final chunk). */
function parseStreamUsage(flavor: string, sse: string): { model: string; usage: TokenUsage } | null {
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

export function startProxy(opts: ProxyOptions): void {
  const cfg = loadConfig();
  const upstreamOrigin = opts.upstream.replace(/\/$/, "");
  const blockedNotified: Record<string, boolean> = {};

  const server = createServer(async (req, res) => {
    const now = Date.now();
    const sessionId = (req.headers["x-agent-guard-session"] as string) || `proxy:${todayKey(now)}`;

    // 1) Pre-flight budget check — block before spending anything.
    // Escape hatch: while a human has paused enforcement, never block (but still meter).
    const ledger = loadLedger();
    const sessionUSD = ledger.sessions[sessionId]?.costUSD ?? 0;
    const dailyUSD = rollingDailyCost(ledger, now);
    const verdict = evaluate({ sessionUSD, dailyUSD }, cfg.budget);

    if (verdict.level === "block" && !isPaused(now)) {
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

        // Post-meter soft-cap alert (once).
        const after = fresh.sessions[sessionId]?.costUSD ?? 0;
        const afterDaily = rollingDailyCost(fresh, Date.now());
        const v2 = evaluate({ sessionUSD: after, dailyUSD: afterDaily }, cfg.budget);
        if (v2.level === "warn" && !blockedNotified[`warn:${sessionId}`]) {
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

  server.listen(opts.port, () => {
    process.stdout.write(
      `🛡  agent-guard proxy on http://localhost:${opts.port} → ${upstreamOrigin} (${opts.flavor})\n` +
        `   Caps: session hard ${fmtUSD(cfg.budget.sessionHardUSD)}, daily hard ${fmtUSD(cfg.budget.dailyHardUSD)}\n` +
        `   Point your agent at it, e.g.:\n` +
        (opts.flavor === "anthropic"
          ? `     ANTHROPIC_BASE_URL=http://localhost:${opts.port} claude\n`
          : `     OPENAI_BASE_URL=http://localhost:${opts.port}/v1 aider\n`),
    );
  });
}

export function resolveUpstream(flavor: string, explicit?: string): string {
  return explicit || UPSTREAMS[flavor] || UPSTREAMS.anthropic;
}
