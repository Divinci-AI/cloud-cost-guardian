import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createServer, request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startProxy } from "../src/proxy.js";
import { loadLedger, saveLedger, emptyLedger, setSessionCost } from "../src/ledger.js";
import { setBudget } from "../src/ops.js";
import { loadLimitsState, saveLimitsState, emptyLimitsState } from "../src/limits.js";

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
  });

  it("never returns 402 once subscription mode is latched (alert-only)", async () => {
    // Over the dollar cap AND flagged as a subscription session.
    setBudget({ sessionHardUSD: 1, dailyHardUSD: 1000 });
    const led = emptyLedger();
    setSessionCost(led, "sess-sub-block", 50, 100, 100, Date.now());
    saveLedger(led);
    saveLimitsState({ ...emptyLimitsState(), subscriptionDetected: true });

    let upstreamHit = false;
    const up = createServer((_req, res) => {
      upstreamHit = true;
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
    });
    const upPort = await listen(up);
    const proxy = startProxy({ port: 0, flavor: "anthropic", upstream: `http://127.0.0.1:${upPort}` });
    const proxyPort = await listen(proxy);

    const res = await post(proxyPort, "/v1/messages", "{}", { "x-agent-guard-session": "sess-sub-block" });

    // Flat-fee plan: dollars are meaningless, so we forward instead of blocking.
    expect(res.status).toBe(200);
    expect(await waitFor(() => upstreamHit)).toBe(true);
  });
});
