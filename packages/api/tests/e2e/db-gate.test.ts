/**
 * DB fast-fail gate
 *
 * When MongoDB is configured but unreachable (e.g. the cluster is paused),
 * DB-dependent routes must fail fast with 503 instead of hanging ~10s on a
 * Mongoose buffering timeout. DB-free public routes stay up so health probes
 * and the marketing surface keep working during a DB outage.
 *
 * Regression guard for the ks-cluster0 pause outage (2026-06-20).
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import request from "supertest";
import mongoose from "mongoose";
import { createApp } from "../../src/app.js";

vi.hoisted(() => { process.env.CLERK_ISSUER = "https://test.clerk.accounts.dev"; });

// Fail fast instead of buffering 10s when a handler reaches past the gate with
// no real Mongo connection (mirrors connectMongoDB's production setting).
mongoose.set("bufferCommands", false);

// Mutable connection state the mocked globals report to the app.
const state = vi.hoisted(() => ({ enabled: true, connected: true }));

vi.mock("../../src/globals/index.js", () => ({
  isMongoEnabled: vi.fn(() => state.enabled),
  isMongoConnected: vi.fn(() => state.connected),
  recordUsageSnapshot: vi.fn(),
  recordAlert: vi.fn(),
  getUsageHistory: vi.fn(async () => []),
  getAlertHistory: vi.fn(async () => []),
  getAnalyticsOverview: vi.fn(async () => ({
    dailyCosts: [], totalSpendPeriod: 0, avgDailyCost: 0,
    projectedMonthlyCost: 0, savingsEstimate: 0, killSwitchActions: 0, accountBreakdown: [],
  })),
}));

const app = createApp();

describe("DB fast-fail gate", () => {
  beforeEach(() => { state.enabled = true; state.connected = true; });

  it("returns 503 fast for DB routes when Mongo is enabled but disconnected", async () => {
    state.connected = false;
    const res = await request(app).post("/auth/cli/start").send({ hostname: "t", cliVersion: "0" });
    expect(res.status).toBe(503);
    expect(res.body.reason).toBe("database unavailable");
    expect(res.headers["retry-after"]).toBe("10");
  });

  it("keeps DB-free routes up during a DB outage", async () => {
    state.connected = false;
    expect((await request(app).get("/")).status).toBe(200);
    expect((await request(app).get("/providers")).status).toBe(200);
    expect((await request(app).get("/rules/presets")).status).toBe(200);
    expect((await request(app).get("/docs/openapi.json")).status).toBe(200);
  });

  it("does not gate when Mongo is connected", async () => {
    state.connected = true;
    // 201 = handler ran (Mongo reachable); the point is it is NOT a 503 from the gate.
    const res = await request(app).post("/auth/cli/start").send({ hostname: "t", cliVersion: "0" });
    expect(res.status).not.toBe(503);
  });

  it("does not gate when Mongo is not configured (in-memory / test mode)", async () => {
    state.enabled = false;
    state.connected = false;
    const res = await request(app).post("/auth/cli/start").send({ hostname: "t", cliVersion: "0" });
    expect(res.status).not.toBe(503);
  });

  it("recovers live: a DB route goes 503 -> not-503 on the same server once the connection returns", async () => {
    // Mirrors the production self-heal: the background reconnect loop flips
    // isMongoConnected back to true, and the SAME running process starts
    // serving requests again — no redeploy/restart.
    state.connected = false;
    const down = await request(app).post("/auth/cli/start").send({ hostname: "t", cliVersion: "0" });
    expect(down.status).toBe(503);

    state.connected = true; // cluster resumed; reconnect loop reconnected
    const up = await request(app).post("/auth/cli/start").send({ hostname: "t", cliVersion: "0" });
    expect(up.status).not.toBe(503);
  });
});
