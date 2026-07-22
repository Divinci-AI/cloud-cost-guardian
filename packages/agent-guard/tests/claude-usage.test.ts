import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  usageToSnapshot,
  refreshUsage,
  triggerBackgroundRefresh,
  saveUsageMeta,
  loadUsageMeta,
  isAllowedUsageUrl,
  type UsageResponse,
} from "../src/claude-usage.js";
import { saveLimitsState, emptyLimitsState, loadLimitsState } from "../src/limits.js";

const now = 1_700_000_000_000;

describe("usageToSnapshot — OAuth usage endpoint mapping", () => {
  it("maps five_hour/seven_day utilization as a PERCENT (÷100), not the header heuristic", () => {
    const u: UsageResponse = {
      five_hour: { utilization: 12, resets_at: "2026-06-13T16:20:00+00:00" },
      seven_day: { utilization: 17, resets_at: "2026-06-17T03:00:00+00:00" },
    };
    const s = usageToSnapshot(u, now);
    expect(s.fiveHour!.utilization).toBeCloseTo(0.12);
    expect(s.weekly!.utilization).toBeCloseTo(0.17);
    expect(s.fiveHour!.resetAt).toBe(Date.parse("2026-06-13T16:20:00+00:00"));
    expect(s.status).toBe("oauth-usage");
  });

  it("reads a 1% window as 0.01, NOT 1.0 (the bug the header parser would have)", () => {
    const s = usageToSnapshot({ seven_day_sonnet: { utilization: 1, resets_at: null } }, now);
    expect(s.extras).toEqual([{ label: "weekly · Sonnet", utilization: 0.01, resetAt: null }]);
  });

  it("surfaces per-model weekly windows as extras, skipping nulls", () => {
    const u: UsageResponse = {
      five_hour: { utilization: 5, resets_at: null },
      seven_day_sonnet: { utilization: 1, resets_at: null },
      seven_day_opus: null,
    };
    const s = usageToSnapshot(u, now);
    expect(s.extras!.map((e) => e.label)).toEqual(["weekly · Sonnet"]);
  });

  it("handles missing/empty windows without throwing", () => {
    const s = usageToSnapshot({}, now);
    expect(s.fiveHour).toBeNull();
    expect(s.weekly).toBeNull();
    expect(s.extras).toBeUndefined();
  });

  it("clamps an over-100 utilization to 1.0", () => {
    const s = usageToSnapshot({ five_hour: { utilization: 130, resets_at: null } }, now);
    expect(s.fiveHour!.utilization).toBe(1);
  });
});

describe("isAllowedUsageUrl — token destination allowlist (security)", () => {
  it("allows Anthropic over https and loopback", () => {
    expect(isAllowedUsageUrl("https://api.anthropic.com/api/oauth/usage")).toBe(true);
    expect(isAllowedUsageUrl("https://anthropic.com/x")).toBe(true);
    expect(isAllowedUsageUrl("http://127.0.0.1:8080/u")).toBe(true);
    expect(isAllowedUsageUrl("http://localhost:1234")).toBe(true);
  });
  it("refuses arbitrary hosts so the OAuth token can't be exfiltrated", () => {
    expect(isAllowedUsageUrl("https://evil.com/steal")).toBe(false);
    expect(isAllowedUsageUrl("http://evil.com")).toBe(false);
    expect(isAllowedUsageUrl("https://api.anthropic.com.evil.com")).toBe(false); // suffix trick
    expect(isAllowedUsageUrl("https://evil-anthropic.com")).toBe(false);
    expect(isAllowedUsageUrl("http://api.anthropic.com")).toBe(false); // http to a non-loopback host
    expect(isAllowedUsageUrl("not a url")).toBe(false);
    expect(isAllowedUsageUrl("file:///etc/passwd")).toBe(false);
  });
});

describe("refreshUsage — throttle (uses usage-meta, never touches the snapshot — G3)", () => {
  let prevHome: string | undefined;
  beforeEach(() => {
    prevHome = process.env.HOME;
    process.env.HOME = mkdtempSync(join(tmpdir(), "ag-usage-"));
  });
  afterEach(() => {
    if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
  });

  it("skips the fetch when the meta stamp is recent and a snapshot exists", async () => {
    saveUsageMeta({ lastFetchAt: now - 1000 }); // 1s ago — throttle stamp lives in usage-meta
    saveLimitsState({
      ...emptyLimitsState(),
      subscriptionDetected: true,
      snapshot: { fiveHour: { utilization: 0.1, resetAt: now + 3600_000 }, weekly: null, status: "oauth-usage", observedAt: now - 1000 },
    });
    const result = await refreshUsage(now, { throttleMs: 120_000 });
    expect(result).toBeNull();
    // the snapshot must be untouched (the throttle stamp is a separate file)
    expect(loadLimitsState().snapshot!.fiveHour!.utilization).toBeCloseTo(0.1);
  });
});

describe("triggerBackgroundRefresh — G1 authorization gate", () => {
  let prevHome: string | undefined;
  beforeEach(() => {
    prevHome = process.env.HOME;
    process.env.HOME = mkdtempSync(join(tmpdir(), "ag-bg-"));
  });
  afterEach(() => {
    if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
  });

  it("does NOT claim or spawn until a foreground command authorized it", () => {
    // no authorized flag → must return early (no surprise Keychain read), no stamp claimed
    triggerBackgroundRefresh("/tmp/ks-nonexistent-refresh.js", now);
    expect(loadUsageMeta().lastFetchAt).toBeUndefined();
  });

  it("claims the stamp once authorized + stale", () => {
    saveUsageMeta({ authorized: true });
    triggerBackgroundRefresh("/tmp/ks-nonexistent-refresh.js", now);
    expect(loadUsageMeta().lastFetchAt).toBe(now);
  });

  it("does NOT spawn while the endpoint's backoff is still running", () => {
    // A 429/401 cooldown is in effect — spawning a child would just no-op inside
    // refreshUsage, so don't even pay for the process.
    saveUsageMeta({ authorized: true, retryAfterUntil: now + 30 * 60_000 });
    triggerBackgroundRefresh("/tmp/ks-nonexistent-refresh.js", now);
    expect(loadUsageMeta().lastFetchAt).toBeUndefined(); // no slot claimed

    // …and resumes once the cooldown has passed.
    triggerBackgroundRefresh("/tmp/ks-nonexistent-refresh.js", now + 31 * 60_000);
    expect(loadUsageMeta().lastFetchAt).toBe(now + 31 * 60_000);
  });
});

describe("refreshUsage — full flow against a mock endpoint", () => {
  let prevHome: string | undefined;
  let home: string;
  let server: Server | undefined;

  beforeEach(() => {
    prevHome = process.env.HOME;
    home = mkdtempSync(join(tmpdir(), "ag-flow-"));
    process.env.HOME = home;
    process.env.AGENT_GUARD_NO_KEYCHAIN = "1"; // never touch the real Keychain in tests
  });
  afterEach(async () => {
    if (server) await new Promise<void>((r) => server!.close(() => r()));
    server = undefined;
    delete process.env.AGENT_GUARD_USAGE_URL;
    delete process.env.AGENT_GUARD_NO_KEYCHAIN;
    if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
  });

  it("reads the file token, fetches, maps, persists the snapshot, and sets authorized + stamp", async () => {
    // token via the cross-platform creds file (file-first read)
    mkdirSync(join(home, ".claude"), { recursive: true });
    writeFileSync(join(home, ".claude", ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "test-token" } }));

    // mock usage endpoint
    let sawAuth = "";
    server = createServer((req, res) => {
      sawAuth = (req.headers["authorization"] as string) || "";
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        five_hour: { utilization: 26, resets_at: "2026-06-13T16:20:00+00:00" },
        seven_day: { utilization: 19, resets_at: "2026-06-17T03:00:00+00:00" },
        seven_day_sonnet: { utilization: 1, resets_at: null },
      }));
    });
    const port = await new Promise<number>((r) => server!.listen(0, "127.0.0.1", () => r((server!.address() as AddressInfo).port)));
    process.env.AGENT_GUARD_USAGE_URL = `http://127.0.0.1:${port}`;

    const snap = await refreshUsage(now, { force: true, foreground: true });

    expect(snap).not.toBeNull();
    expect(snap!.fiveHour!.utilization).toBeCloseTo(0.26);
    expect(snap!.weekly!.utilization).toBeCloseTo(0.19);
    expect(snap!.extras).toEqual([{ label: "weekly · Sonnet", utilization: 0.01, resetAt: null }]);
    expect(sawAuth).toBe("Bearer test-token"); // token sent as Bearer
    // persisted to limits.json
    expect(loadLimitsState().snapshot!.weekly!.utilization).toBeCloseTo(0.19);
    expect(loadLimitsState().subscriptionDetected).toBe(true);
    // meta updated (separate file)
    expect(loadUsageMeta().authorized).toBe(true);
    expect(loadUsageMeta().lastFetchAt).toBe(now);
  });

  it("returns null and does NOT authorize when there's no token", async () => {
    // no creds file, keychain disabled → no token
    const snap = await refreshUsage(now, { force: true, foreground: true });
    expect(snap).toBeNull();
    expect(loadUsageMeta().authorized).toBeUndefined();
  });
});

/**
 * 429 backoff. The endpoint answers an over-eager poller with
 * `429 rate_limit_error` + `retry-after: ~3600`. We previously collapsed every
 * non-2xx into `null` and re-tried on a flat 120s throttle, so ~300 rejected
 * calls in 10h kept the limit alive and the feature looked dead. Honour the
 * server's cooldown instead.
 */
describe("refreshUsage — 429 / retry-after backoff", () => {
  let prevHome: string | undefined;
  let home: string;
  let server: Server | undefined;
  let hits = 0;

  beforeEach(() => {
    prevHome = process.env.HOME;
    home = mkdtempSync(join(tmpdir(), "ag-429-"));
    process.env.HOME = home;
    process.env.AGENT_GUARD_NO_KEYCHAIN = "1";
    mkdirSync(join(home, ".claude"), { recursive: true });
    writeFileSync(join(home, ".claude", ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "t" } }));
    hits = 0;
  });
  afterEach(async () => {
    if (server) await new Promise<void>((r) => server!.close(() => r()));
    server = undefined;
    delete process.env.AGENT_GUARD_USAGE_URL;
    delete process.env.AGENT_GUARD_NO_KEYCHAIN;
    if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
  });

  async function serve(status: number, headers: Record<string, string> = {}, body = "{}") {
    server = createServer((_req, res) => {
      hits++;
      res.writeHead(status, { "content-type": "application/json", ...headers });
      res.end(body);
    });
    const port = await new Promise<number>((r) => server!.listen(0, "127.0.0.1", () => r((server!.address() as AddressInfo).port)));
    process.env.AGENT_GUARD_USAGE_URL = `http://127.0.0.1:${port}`;
  }

  it("records the server's retry-after and then STOPS calling — even when forced", async () => {
    await serve(429, { "retry-after": "3519" });

    expect(await refreshUsage(now, { force: true, foreground: true })).toBeNull();
    expect(hits).toBe(1);
    const meta = loadUsageMeta();
    expect(meta.retryAfterUntil).toBe(now + 3519 * 1000); // exactly the server's window
    expect(meta.failureStreak).toBe(1);

    // Any call inside the cooldown must not touch the network — this is the loop
    // that previously kept us rate-limited.
    for (const t of [now + 1000, now + 60_000, now + 3518 * 1000]) {
      expect(await refreshUsage(t, { force: true, foreground: true })).toBeNull();
    }
    expect(hits).toBe(1); // still just the one call
  });

  it("resumes once the cooldown expires, and success clears the backoff", async () => {
    await serve(429, { "retry-after": "60" });
    await refreshUsage(now, { force: true, foreground: true });
    expect(hits).toBe(1);

    // Past the window → allowed to try again.
    await new Promise<void>((r) => server!.close(() => r()));
    await serve(200, {}, JSON.stringify({ five_hour: { utilization: 10, resets_at: null } }));
    const snap = await refreshUsage(now + 61_000, { force: true, foreground: true });

    expect(snap).not.toBeNull();
    expect(snap!.fiveHour!.utilization).toBeCloseTo(0.1);
    const meta = loadUsageMeta();
    expect(meta.failureStreak).toBe(0);
    expect(meta.retryAfterUntil).toBe(0); // cleared — free to poll normally
  });

  it("falls back to a sane cooldown when a 429 carries no retry-after", async () => {
    await serve(429);
    await refreshUsage(now, { force: true, foreground: true });
    expect(loadUsageMeta().retryAfterUntil).toBe(now + 60 * 60_000); // 1h default
  });

  it("backs off exponentially on non-429 failures (5m → 10m), capped", async () => {
    await serve(500);
    await refreshUsage(now, { force: true, foreground: true });
    expect(loadUsageMeta().retryAfterUntil).toBe(now + 5 * 60_000);

    const t2 = now + 5 * 60_000 + 1;
    await refreshUsage(t2, { force: true, foreground: true });
    expect(loadUsageMeta().failureStreak).toBe(2);
    expect(loadUsageMeta().retryAfterUntil).toBe(t2 + 10 * 60_000);
  });
});
