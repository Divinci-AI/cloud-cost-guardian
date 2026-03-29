/**
 * Live API Smoke Test
 *
 * Hits the real production API to verify core functionality.
 * Uses KILL_SWITCH_API_KEY env var or ~/.kill-switch/config.json.
 *
 * Run manually:
 *   SMOKE=1 npm test -- tests/smoke/live-api.test.ts
 *
 * Skipped by default in CI (requires live API + valid key).
 */

import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";

const SKIP = !process.env.SMOKE;
const API_URL = process.env.KILL_SWITCH_API_URL || "https://api.kill-switch.net";

function getApiKey(): string {
  if (process.env.KILL_SWITCH_API_KEY) return process.env.KILL_SWITCH_API_KEY;
  try {
    const config = JSON.parse(readFileSync(join(homedir(), ".kill-switch", "config.json"), "utf-8"));
    return config.apiKey;
  } catch {
    return "";
  }
}

async function api(path: string, opts: { method?: string; body?: any } = {}) {
  const res = await fetch(`${API_URL}${path}`, {
    method: opts.method || "GET",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${getApiKey()}`,
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json();
  return { status: res.status, data };
}

describe.skipIf(SKIP)("Live API Smoke Test", () => {
  beforeAll(() => {
    const key = getApiKey();
    if (!key) throw new Error("No API key found. Set KILL_SWITCH_API_KEY or configure ~/.kill-switch/config.json");
  });

  it("GET / — health check returns healthy", async () => {
    const res = await fetch(`${API_URL}/`);
    const data = await res.json();
    expect(res.status).toBe(200);
    expect(data.status).toBe("healthy");
    expect(data.providers.length).toBeGreaterThanOrEqual(3);
  }, 10000);

  it("GET /providers — lists all providers", async () => {
    const res = await fetch(`${API_URL}/providers`);
    const data = await res.json();
    expect(res.status).toBe(200);
    const ids = data.providers.map((p: any) => p.id);
    expect(ids).toContain("cloudflare");
    expect(ids).toContain("gcp");
    expect(ids).toContain("aws");
  }, 10000);

  it("GET /accounts/me — returns authenticated account", async () => {
    const { status, data } = await api("/accounts/me");
    expect(status).toBe(200);
    expect(data.tier).toBeDefined();
    expect(data.ownerUserId).toBeDefined();
  }, 10000);

  it("GET /cloud-accounts — lists connected accounts", async () => {
    const { status, data } = await api("/cloud-accounts");
    expect(status).toBe(200);
    expect(data.accounts).toBeDefined();
    expect(Array.isArray(data.accounts)).toBe(true);
  }, 10000);

  it("GET /cloud-accounts — has at least the dogfood account", async () => {
    const { data } = await api("/cloud-accounts");
    const dogfood = data.accounts.find((a: any) => a.name?.includes("Dogfood"));
    expect(dogfood).toBeDefined();
    expect(dogfood.provider).toBe("cloudflare");
    expect(dogfood.status).toBe("active");
  }, 10000);

  it("GET /rules — lists active rules", async () => {
    const { status, data } = await api("/rules");
    expect(status).toBe(200);
    expect(data.rules).toBeDefined();
    expect(Array.isArray(data.rules)).toBe(true);
  }, 10000);

  it("GET /rules/presets — lists shield presets", async () => {
    const { status, data } = await api("/rules/presets");
    expect(status).toBe(200);
    expect(data.presets.length).toBeGreaterThanOrEqual(5);
  }, 10000);

  it("GET /auth/api-keys — lists API keys (at least 1)", async () => {
    const { status, data } = await api("/auth/api-keys");
    expect(status).toBe(200);
    expect(data.keys.length).toBeGreaterThanOrEqual(1);
    // Keys should only show prefix, not full key
    for (const key of data.keys) {
      expect(key.keyPrefix).toBeDefined();
      expect(key.keyHash).toBeUndefined(); // Hash must never be exposed
    }
  }, 10000);

  it("GET /analytics/overview — returns analytics (or 500 if Postgres not configured)", async () => {
    const { status, data } = await api("/analytics/overview?days=7");
    // Analytics requires PostgreSQL — may not be configured in staging
    if (status === 200) {
      expect(typeof data.totalSpendPeriod).toBe("number");
      expect(typeof data.projectedMonthlyCost).toBe("number");
    } else {
      expect(status).toBe(500); // Expected when Postgres is not configured
    }
  }, 10000);

  it("POST /check — runs a monitoring check", async () => {
    const { status, data } = await api("/check", { method: "POST" });
    expect(status).toBe(200);
    expect(data.results).toBeDefined();
    expect(Array.isArray(data.results)).toBe(true);
  }, 30000);

  it("rejects requests without auth", async () => {
    const res = await fetch(`${API_URL}/cloud-accounts`);
    expect(res.status).toBe(401);
  }, 10000);

  it("rejects invalid API key", async () => {
    const res = await fetch(`${API_URL}/cloud-accounts`, {
      headers: { Authorization: "Bearer ks_live_invalidkey" },
    });
    expect(res.status).toBe(401);
  }, 10000);
});
