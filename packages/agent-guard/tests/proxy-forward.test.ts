import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createServer, request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startProxy } from "../src/proxy.js";
import { loadLedger, saveLedger, emptyLedger, setSessionCost } from "../src/ledger.js";
import { setBudget, setLimits } from "../src/ops.js";
import { loadLimitsState, saveLimitsState, emptyLimitsState } from "../src/limits.js";
import { eventsPath } from "../src/config.js";
import { readFileSync } from "node:fs";

/**
 * Integration tests for the metering proxy's request/response forwarding (only
 * usage *parsing* was covered before). Uses a real localhost upstream server —
 * the proxy forwards via global fetch, so a stubbed fetch would also intercept
 * the test client. guardDir()/configPath() resolve homedir() at call time, so a
 * temp $HOME fully isolates the ledger + config.
 */

const servers: Server[] = [];
let prevHome: string | undefined;

function listen(server: Server): Promise<number> {
  servers.push(server);
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port));
  });
}

/** Minimal upstream that records the request and returns a canned JSON body. */
function makeUpstream(responseBody: string, extraHeaders: Record<string, string> = {}) {
  const seen: { method?: string; url?: string; body: string } = { body: "" };
  const server = createServer((req, res) => {
    seen.method = req.method;
    seen.url = req.url;
    let b = "";
    req.on("data", (c) => (b += c));
    req.on("end", () => {
      seen.body = b;
      res.writeHead(200, { "content-type": "application/json", ...extraHeaders });
      res.end(responseBody);
    });
  });
  return { server, seen };
}

function post(port: number, path: string, body: string, headers: Record<string, string> = {}): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request(
      { host: "127.0.0.1", port, path, method: "POST", headers: { "content-type": "application/json", ...headers } },
      (res) => {
        let b = "";
        res.on("data", (c) => (b += c));
        res.on("end", () => resolve({ status: res.statusCode || 0, body: b }));
      },
    );
    req.on("error", reject);
    req.end(body);
  });
}

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return true;
    await new Promise((r) => setTimeout(r, 20));
  }
  return predicate();
}

beforeEach(() => {
  prevHome = process.env.HOME;
  process.env.HOME = mkdtempSync(join(tmpdir(), "ag-proxy-"));
});

afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise<void>((r) => s.close(() => r()))));
  if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
});

describe("proxy request forwarding + metering", () => {
  it("forwards the request upstream, relays the response, and meters real usage", async () => {
    const upstreamBody = JSON.stringify({
      model: "claude-sonnet-4",
      usage: { input_tokens: 1000, output_tokens: 500 },
    });
    const { server: up, seen } = makeUpstream(upstreamBody);
    const upPort = await listen(up);

    const proxy = startProxy({ port: 0, flavor: "anthropic", upstream: `http://127.0.0.1:${upPort}` });
    const proxyPort = await listen(proxy);

    const res = await post(proxyPort, "/v1/messages", JSON.stringify({ model: "claude-sonnet-4" }), {
      "x-agent-guard-session": "sess-fwd",
    });

    // Response relayed verbatim from upstream
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body).model).toBe("claude-sonnet-4");
    // Request actually reached the upstream, same path + method
    expect(seen.method).toBe("POST");
    expect(seen.url).toBe("/v1/messages");

    // Metering is fire-and-forget after the body tees — poll the ledger.
    const metered = await waitFor(() => (loadLedger().sessions["sess-fwd"]?.costUSD ?? 0) > 0);
    expect(metered).toBe(true);
    // 1000 in @ $3/M + 500 out @ $15/M = $0.0105
    expect(loadLedger().sessions["sess-fwd"].costUSD).toBeCloseTo(0.0105, 4);
  });

  it("returns HTTP 402 at the hard cap without ever hitting upstream", async () => {
    // Low cap, persisted before startProxy reads config.
    setBudget({ sessionHardUSD: 1, dailyHardUSD: 1000 });
    // Seed the session already over the cap.
    const led = emptyLedger();
    setSessionCost(led, "sess-blocked", 5, 100, 100, Date.now());
    saveLedger(led);

    let upstreamHit = false;
    const { server: up } = (() => {
      const s = createServer((_req, res) => { upstreamHit = true; res.end("{}"); });
      return { server: s };
    })();
    const upPort = await listen(up);

    const proxy = startProxy({ port: 0, flavor: "anthropic", upstream: `http://127.0.0.1:${upPort}` });
    const proxyPort = await listen(proxy);

    const res = await post(proxyPort, "/v1/messages", "{}", { "x-agent-guard-session": "sess-blocked" });

    expect(res.status).toBe(402);
    // give any (wrongly-issued) forward a moment to land
    await new Promise((r) => setTimeout(r, 50));
    expect(upstreamHit).toBe(false);
  });

  it("captures Anthropic unified rate-limit headers and latches subscription mode", async () => {
    const { server: up } = makeUpstream(
      JSON.stringify({ model: "claude-sonnet-4", usage: { input_tokens: 10, output_tokens: 5 } }),
      {
        "anthropic-ratelimit-unified-status": "allowed",
        "anthropic-ratelimit-unified-5h-utilization": "0.4",
        "anthropic-ratelimit-unified-7d-utilization": "0.62",
        "anthropic-ratelimit-unified-7d-reset": "2026-06-20T01:00:00Z",
      },
    );
    const upPort = await listen(up);
    const proxy = startProxy({ port: 0, flavor: "anthropic", upstream: `http://127.0.0.1:${upPort}` });
    const proxyPort = await listen(proxy);

    await post(proxyPort, "/v1/messages", "{}", { "x-agent-guard-session": "sess-sub" });

    const latched = await waitFor(() => loadLimitsState().subscriptionDetected);
    expect(latched).toBe(true);
    const snap = loadLimitsState().snapshot!;
    expect(snap.weekly!.utilization).toBeCloseTo(0.62);
    expect(snap.fiveHour!.utilization).toBeCloseTo(0.4);

    // Raw headers are dumped once for format verification…
    const events = readFileSync(eventsPath(), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    const dumps = events.filter((e) => e.kind === "unified-headers-observed");
    expect(dumps).toHaveLength(1);
    expect(dumps[0].headers["anthropic-ratelimit-unified-7d-reset"]).toBe("2026-06-20T01:00:00Z");

    // …and only once, even after more requests.
    await post(proxyPort, "/v1/messages", "{}", { "x-agent-guard-session": "sess-sub" });
    await waitFor(() => false, 150); // small settle
    const after = readFileSync(eventsPath(), "utf8").trim().split("\n").map((l) => JSON.parse(l))
      .filter((e) => e.kind === "unified-headers-observed");
    expect(after).toHaveLength(1);
  });

  it("captures unified headers on a STREAMING (SSE) response too", async () => {
    // Headers ride the HTTP response, independent of the streamed body — so a
    // streaming Claude Code turn must still latch subscription mode.
    const sse = [
      `event: message_start`,
      `data: ${JSON.stringify({ type: "message_start", message: { model: "claude-sonnet-4", usage: { input_tokens: 20 } } })}`,
      ``,
      `event: message_delta`,
      `data: ${JSON.stringify({ type: "message_delta", usage: { output_tokens: 10 } })}`,
      ``,
      `data: [DONE]`,
      ``,
    ].join("\n");
    const server = createServer((req, res) => {
      let b = "";
      req.on("data", (c) => (b += c));
      req.on("end", () => {
        res.writeHead(200, {
          "content-type": "text/event-stream",
          "anthropic-ratelimit-unified-status": "warning",
          "anthropic-ratelimit-unified-7d-utilization": "0.81",
          "anthropic-ratelimit-unified-7d-reset": "2026-06-20T01:00:00Z",
        });
        res.end(sse);
      });
    });
    const upPort = await listen(server);
    const proxy = startProxy({ port: 0, flavor: "anthropic", upstream: `http://127.0.0.1:${upPort}` });
    const proxyPort = await listen(proxy);

    const res = await post(proxyPort, "/v1/messages", JSON.stringify({ stream: true }), { "x-agent-guard-session": "sess-sse" });
    expect(res.status).toBe(200);

    const latched = await waitFor(() => loadLimitsState().subscriptionDetected);
    expect(latched).toBe(true);
    expect(loadLimitsState().snapshot!.weekly!.utilization).toBeCloseTo(0.81);
  });

  // F1: the dollar-402 suppression is scoped (flavor + pinned-plan / fresh
  // headers), NOT a permanent global latch. Seed an over-cap session, then vary
  // what's known about subscription state.
  async function overCapProxy(flavor: "anthropic" | "openai") {
    setBudget({ sessionHardUSD: 1, dailyHardUSD: 1000 });
    const led = emptyLedger();
    setSessionCost(led, "sess-block", 50, 100, 100, Date.now());
    saveLedger(led);
    const hit = { v: false };
    const up = createServer((_req, res) => {
      hit.v = true;
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
    });
    const upPort = await listen(up);
    const proxy = startProxy({ port: 0, flavor, upstream: `http://127.0.0.1:${upPort}` });
    const proxyPort = await listen(proxy);
    return { proxyPort, hit };
  }

  function freshSnapshotState() {
    const now = Date.now();
    return {
      ...emptyLimitsState(),
      subscriptionDetected: true,
      snapshot: {
        fiveHour: { utilization: 0.4, resetAt: now + 3 * 3600_000 },
        weekly: { utilization: 0.6, resetAt: now + 5 * 86400_000 },
        status: "allowed",
        observedAt: now,
      },
    };
  }

  it("suppresses the dollar 402 when a fresh subscription snapshot exists (anthropic)", async () => {
    saveLimitsState(freshSnapshotState());
    const { proxyPort, hit } = await overCapProxy("anthropic");
    const res = await post(proxyPort, "/v1/messages", "{}", { "x-agent-guard-session": "sess-block" });
    expect(res.status).toBe(200); // flat-fee plan: forward, don't block on meaningless dollars
    expect(await waitFor(() => hit.v)).toBe(true);
  });

  it("suppresses the dollar 402 when a subscription plan is pinned (anthropic, no snapshot)", async () => {
    setLimits({ plan: "max5" });
    const { proxyPort, hit } = await overCapProxy("anthropic");
    const res = await post(proxyPort, "/v1/messages", "{}", { "x-agent-guard-session": "sess-block" });
    expect(res.status).toBe(200);
    expect(await waitFor(() => hit.v)).toBe(true);
  });

  it("F1 regression: still 402s on a bare/stale latch with no fresh snapshot (plan=auto)", async () => {
    // The old bug: subscriptionDetected alone disarmed the wall forever.
    saveLimitsState({ ...emptyLimitsState(), subscriptionDetected: true });
    const { proxyPort, hit } = await overCapProxy("anthropic");
    const res = await post(proxyPort, "/v1/messages", "{}", { "x-agent-guard-session": "sess-block" });
    expect(res.status).toBe(402);
    await new Promise((r) => setTimeout(r, 50));
    expect(hit.v).toBe(false);
  });

  it("F1 regression: still 402s on the openai flavor even if a subscription was detected", async () => {
    saveLimitsState(freshSnapshotState()); // anthropic subscription seen…
    const { proxyPort, hit } = await overCapProxy("openai"); // …but this is a billed OpenAI agent
    const res = await post(proxyPort, "/v1/messages", "{}", { "x-agent-guard-session": "sess-block" });
    expect(res.status).toBe(402);
    await new Promise((r) => setTimeout(r, 50));
    expect(hit.v).toBe(false);
  });
});
