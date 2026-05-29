/**
 * E2E tests for the agent-guard event endpoint.
 *
 * Follows the in-memory-mock harness used by tests/e2e/api.test.ts (mongoose,
 * jose, permissions, and alerting are all mocked) rather than a real DB.
 *
 * Covers: valid block event -> 200 + persisted + alert fan-out; warn event ->
 * 200 + persisted + NO fan-out; missing auth -> 401; malformed body -> 400;
 * GET -> this org's events, newest first.
 */

import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import request from "supertest";
import type { Express } from "express";

vi.hoisted(() => { process.env.CLERK_ISSUER = "https://test.clerk.accounts.dev"; });

// In-memory mongoose mock. find() returns a chainable supporting the
// sort/skip/limit/lean chain the GET handler uses.
vi.mock("mongoose", () => {
  const docs = new Map<string, any>();
  let idCounter = 1;

  const createMockModel = (name: string) => ({
    create: vi.fn(async (data: any) => {
      const doc: any = { _id: `${name}-${idCounter++}`, createdAt: new Date(Date.now() + idCounter), ...data };
      docs.set(doc._id, doc);
      return doc;
    }),
    find: vi.fn((query: any) => {
      let results = Array.from(docs.values()).filter(d =>
        !query?.guardianAccountId || d.guardianAccountId === query.guardianAccountId
      );
      const chainable: any = {
        sort: (spec: any) => {
          const key = spec && Object.keys(spec)[0];
          const dir = key ? spec[key] : -1;
          results = [...results].sort((a, b) => (a[key] > b[key] ? 1 : -1) * dir);
          return chainable;
        },
        skip: (n: number) => { results = results.slice(n); return chainable; },
        limit: (n: number) => { results = results.slice(0, n); return chainable; },
        lean: async () => results,
      };
      return chainable;
    }),
    countDocuments: vi.fn(async (query: any) =>
      Array.from(docs.values()).filter(d => !query?.guardianAccountId || d.guardianAccountId === query.guardianAccountId).length
    ),
    findById: vi.fn(async (id: string) => docs.get(id) || null),
    __docs: docs,
  });

  class MockSchema {
    static Types = { Mixed: "Mixed", ObjectId: "ObjectId" };
    pre() { return this; }
    post() { return this; }
    index() { return this; }
    virtual() { return { get: () => {} }; }
  }

  return {
    default: { Schema: MockSchema, model: vi.fn((name: string) => createMockModel(name)), models: {}, connect: vi.fn() },
    Schema: MockSchema,
  };
});

vi.mock("jose", () => ({
  createRemoteJWKSet: vi.fn(() => vi.fn()),
  jwtVerify: vi.fn(async () => ({ payload: { sub: "user_test", email: "t@example.com" } })),
}));

// Allow-all permissions (role enforcement is covered by its own test suite).
vi.mock("../../src/middleware/permissions.js", () => ({
  requirePermission: () => (_req: any, _res: any, next: any) => next(),
}));

// Spy on alert fan-out without sending anything.
vi.mock("../../src/services/alerting.js", () => ({ sendAlerts: vi.fn().mockResolvedValue(undefined) }));

// Provider/global mocks so app.ts import graph resolves cleanly.
vi.mock("../../src/providers/index.js", () => ({
  getProvider: vi.fn(() => undefined),
  getAllProviders: vi.fn(() => []),
}));
vi.mock("../../src/globals/index.js", () => ({
  recordUsageSnapshot: vi.fn(), recordAlert: vi.fn(),
  getUsageHistory: vi.fn(async () => []), getAlertHistory: vi.fn(async () => []),
  getAnalyticsOverview: vi.fn(async () => ({})),
}));
vi.mock("stripe", () => ({ default: class { constructor() {} } }));

let app: Express;
let sendAlerts: any;

const ACCT = "agentguard-acct-1";
const USER = "agentguard-user-1";

function authed(r: request.Test): request.Test {
  return r
    .set("X-Guardian-Account-Id", ACCT)
    .set("X-Guardian-User-Id", USER)
    .set("X-Guardian-Role", "owner");
}

const validBlock = {
  ts: 1_700_000_000_000,
  source: "hook",
  sessionId: "sess-block-1",
  level: "block",
  sessionUSD: 321.79,
  dailyUSD: 328.96,
  reasons: ["session spend $321.79 reached the hard cap of $100.00"],
  action: "denied next tool call",
  cwd: "/Users/dev/project",
};

beforeAll(async () => {
  process.env.NODE_ENV = "test";
  process.env.ENVIRONMENT = "local";
  process.env.GUARDIAN_DEV_AUTH_BYPASS = "true";
  const { createApp } = await import("../../src/app.js");
  app = createApp();
  sendAlerts = (await import("../../src/services/alerting.js")).sendAlerts;
});

beforeEach(async () => {
  vi.clearAllMocks();
  // Clear the shared in-memory doc store between tests.
  const { AgentGuardEventModel } = await import("../../src/models/agent-guard-event/schema.js");
  (AgentGuardEventModel as any).__docs?.clear?.();
  const { GuardianAccountModel } = await import("../../src/models/guardian-account/schema.js");
  (GuardianAccountModel as any).__docs?.clear?.();
});

describe("POST /agent-guard/events", () => {
  it("rejects unauthenticated requests with 401", async () => {
    const res = await request(app).post("/agent-guard/events").send(validBlock);
    expect(res.status).toBe(401);
  });

  it("accepts a valid block event, persists it, and fans out alerts", async () => {
    const { GuardianAccountModel } = await import("../../src/models/guardian-account/schema.js");
    await (GuardianAccountModel as any).create({
      _id: ACCT,
      ownerUserId: USER,
      alertChannels: [{ type: "slack", name: "ops", config: { webhookUrl: "https://hooks.slack.com/services/x" }, enabled: true }],
    });

    const res = await authed(request(app).post("/agent-guard/events")).send(validBlock);
    if (res.status !== 200) {
      const fs = await import("node:fs");
      fs.writeFileSync("/tmp/ag-err.json", JSON.stringify({ status: res.status, body: res.body }, null, 2));
    }
    expect(res.status).toBe(200);
    expect(res.body.received).toBe(true);
    expect(res.body.id).toBeTruthy();

    const { AgentGuardEventModel } = await import("../../src/models/agent-guard-event/schema.js");
    const stored = await (AgentGuardEventModel as any).find({ guardianAccountId: ACCT }).lean();
    expect(stored).toHaveLength(1);
    expect(stored[0].level).toBe("block");

    expect(sendAlerts).toHaveBeenCalledTimes(1);
    const [channels, summary, severity] = sendAlerts.mock.calls[0];
    expect(channels).toHaveLength(1);
    expect(severity).toBe("critical");
    expect(summary).toContain("BLOCKED");
  });

  it("persists a warn event WITHOUT firing alerts", async () => {
    const res = await authed(request(app).post("/agent-guard/events")).send({
      ...validBlock, sessionId: "sess-warn-1", level: "warn", action: "warned",
    });
    expect(res.status).toBe(200);

    const { AgentGuardEventModel } = await import("../../src/models/agent-guard-event/schema.js");
    const stored = await (AgentGuardEventModel as any).find({ guardianAccountId: ACCT }).lean();
    expect(stored).toHaveLength(1);
    expect(stored[0].level).toBe("warn");
    expect(sendAlerts).not.toHaveBeenCalled();
  });

  it("rejects a malformed body with 400", async () => {
    const bad = await authed(request(app).post("/agent-guard/events"))
      .send({ source: "hook", level: "explode", sessionId: "x", sessionUSD: 1, dailyUSD: 1 });
    expect(bad.status).toBe(400);

    const missing = await authed(request(app).post("/agent-guard/events")).send({ source: "hook", level: "block" });
    expect(missing.status).toBe(400);
  });

  it("rejects NaN/Infinity amounts (Number.isFinite, not bare typeof)", async () => {
    const nan = await authed(request(app).post("/agent-guard/events"))
      .send({ ...validBlock, sessionId: "nan-1", sessionUSD: "not-a-number" });
    expect(nan.status).toBe(400);
    // JSON can't carry Infinity literally; the string path above is the realistic vector.
  });

  it("clamps oversized strings/arrays before persisting", async () => {
    // Stay under the global JSON body limit (which already 413s huge payloads)
    // so we exercise the per-field clamp, not the body-parser cap.
    const big = "x".repeat(5_000);
    const res = await authed(request(app).post("/agent-guard/events")).send({
      ...validBlock,
      sessionId: "clamp-1",
      level: "warn",
      cwd: big,
      reasons: Array.from({ length: 60 }, () => big),
    });
    expect(res.status).toBe(200);

    const { AgentGuardEventModel } = await import("../../src/models/agent-guard-event/schema.js");
    const stored = await (AgentGuardEventModel as any).find({ guardianAccountId: ACCT }).lean();
    const rec = stored.find((s: any) => s.sessionId === "clamp-1");
    expect(rec.cwd.length).toBeLessThanOrEqual(1024);
    expect(rec.reasons.length).toBeLessThanOrEqual(20);
    expect(rec.reasons[0].length).toBeLessThanOrEqual(512);
  });
});

describe("GET /agent-guard/events", () => {
  it("returns this org's events, newest first", async () => {
    await authed(request(app).post("/agent-guard/events")).send({ ...validBlock, sessionId: "s1", level: "warn", ts: 1000 });
    await authed(request(app).post("/agent-guard/events")).send({ ...validBlock, sessionId: "s2", level: "warn", ts: 2000 });

    const res = await authed(request(app).get("/agent-guard/events"));
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(2);
    expect(res.body.events).toHaveLength(2);
    expect(res.body.events[0].createdAt >= res.body.events[1].createdAt).toBe(true);
  });
});
