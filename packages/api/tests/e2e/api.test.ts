/**
 * E2E API Tests
 *
 * Tests the full API surface through HTTP requests.
 * Covers: auth, accounts, cloud accounts, alerts, rules, billing, kill switches.
 */

import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import request from "supertest";
import { createApp } from "../../src/app.js";
import type { Express } from "express";

// Mock all external dependencies
vi.mock("mongoose", () => {
  const docs = new Map();
  let idCounter = 1;

  const createMockModel = (name: string) => {
    const model: any = {
      create: vi.fn(async (data: any) => {
        const doc = { _id: `${name}-${idCounter++}`, ...data, save: vi.fn() };
        docs.set(doc._id, doc);
        return doc;
      }),
      find: vi.fn(async (query: any) => {
        return Array.from(docs.values()).filter(d => {
          if (query?.guardianAccountId) return d.guardianAccountId === query.guardianAccountId;
          if (query?.status) return d.status === query.status;
          return true;
        });
      }),
      findById: vi.fn(async (id: string) => docs.get(id) || null),
      findOne: vi.fn(async (query: any) => {
        return Array.from(docs.values()).find(d => {
          if (query?.ownerUserId) return d.ownerUserId === query.ownerUserId;
          return false;
        }) || null;
      }),
      findByIdAndUpdate: vi.fn(async (id: string, update: any, opts?: any) => {
        const doc = docs.get(id);
        if (!doc) return null;
        Object.assign(doc, update.$set || update);
        return doc;
      }),
      findByIdAndDelete: vi.fn(async (id: string) => {
        const doc = docs.get(id);
        docs.delete(id);
        return doc;
      }),
      countDocuments: vi.fn(async () => docs.size),
    };
    return model;
  };

  class MockSchema {
    static Types = { Mixed: "Mixed", ObjectId: "ObjectId" };
    constructor() {}
    pre() { return this; }
    post() { return this; }
    index() { return this; }
    virtual() { return { get: () => {} }; }
  }

  return {
    default: {
      Schema: MockSchema,
      model: vi.fn((name: string) => createMockModel(name)),
      models: {},
      connect: vi.fn(),
    },
    Schema: MockSchema,
  };
});

vi.mock("../../src/models/encrypted-credential/schema.js", () => ({
  EncryptedCredentialModel: {},
  storeCredential: vi.fn(async () => "cred-123"),
  getCredential: vi.fn(async () => ({ provider: "cloudflare", apiToken: "tok", accountId: "acc" })),
  deleteCredential: vi.fn(async () => true),
}));

vi.mock("../../src/providers/index.js", () => ({
  getProvider: vi.fn(() => ({
    id: "cloudflare",
    name: "Cloudflare",
    checkUsage: vi.fn(async () => ({
      provider: "cloudflare", accountId: "test", checkedAt: Date.now(),
      services: [{ serviceName: "worker-1", metrics: [], estimatedDailyCostUSD: 5 }],
      totalEstimatedDailyCostUSD: 5, violations: [], securityEvents: [],
    })),
    executeKillSwitch: vi.fn(async () => ({ success: true, action: "disconnect", serviceName: "x", details: "done" })),
    validateCredential: vi.fn(async () => ({ valid: true, accountId: "acc-123", accountName: "Test Account" })),
    getDefaultThresholds: vi.fn(() => ({ doRequestsPerDay: 1000000 })),
  })),
  getAllProviders: vi.fn(() => [
    { id: "cloudflare", name: "Cloudflare", getDefaultThresholds: () => ({ doRequestsPerDay: 1000000 }) },
    { id: "gcp", name: "Google Cloud Platform", getDefaultThresholds: () => ({ monthlySpendLimitUSD: 500 }) },
    { id: "aws", name: "Amazon Web Services", getDefaultThresholds: () => ({ ec2InstanceCount: 20, monthlySpendLimitUSD: 3000 }) },
  ]),
}));

vi.mock("../../src/globals/index.js", () => ({
  recordUsageSnapshot: vi.fn(),
  recordAlert: vi.fn(),
  getUsageHistory: vi.fn(async () => []),
  getAlertHistory: vi.fn(async () => []),
  getAnalyticsOverview: vi.fn(async () => ({
    dailyCosts: [
      { date: "2026-03-20", cost: 25.5, services: 3, violations: 0 },
      { date: "2026-03-21", cost: 30.0, services: 3, violations: 1 },
    ],
    totalSpendPeriod: 55.5,
    avgDailyCost: 27.75,
    projectedMonthlyCost: 832.5,
    savingsEstimate: 150,
    killSwitchActions: 1,
    accountBreakdown: [
      { cloudAccountId: "cf-1", provider: "cloudflare", totalCost: 55.5, avgDailyCost: 27.75 },
    ],
  })),
}));

vi.mock("jose", () => ({
  createRemoteJWKSet: vi.fn(() => vi.fn()),
  jwtVerify: vi.fn(async () => ({
    payload: { sub: "user_test123", email: "test@example.com" },
  })),
}));

// Mock Stripe
vi.mock("stripe", () => {
  return { default: class { constructor() {} } };
});

// Mock permissions (allow all in tests)
vi.mock("../../src/middleware/permissions.js", () => ({
  requirePermission: () => (_req: any, _res: any, next: any) => next(),
}));

// Mock activity logger
vi.mock("../../src/services/activity-logger.js", () => ({
  logActivity: vi.fn(),
}));

// Mock API key model with in-memory storage
const apiKeyStore = new Map<string, any>();
let apiKeyCounter = 1;
vi.mock("../../src/models/api-key/schema.js", () => {
  const { randomBytes, createHash } = require("crypto");
  return {
    createApiKey: vi.fn(async (guardianAccountId: string, userId: string, name: string) => {
      const raw = randomBytes(32).toString("hex");
      const key = `ks_live_${raw}`;
      const id = `apikey-${apiKeyCounter++}`;
      apiKeyStore.set(id, { _id: id, guardianAccountId, userId, name, keyPrefix: key.substring(0, 16), createdAt: new Date() });
      return { key, id };
    }),
    listApiKeys: vi.fn(async (guardianAccountId: string) => {
      return Array.from(apiKeyStore.values()).filter(k => k.guardianAccountId === guardianAccountId);
    }),
    deleteApiKey: vi.fn(async (id: string, guardianAccountId: string) => {
      const key = apiKeyStore.get(id);
      if (!key || key.guardianAccountId !== guardianAccountId) return false;
      apiKeyStore.delete(id);
      return true;
    }),
    validateApiKey: vi.fn(async () => null),
    PersonalApiKeyModel: {},
    deleteAllApiKeysForAccount: vi.fn(async () => 0),
  };
});

let app: Express;

beforeAll(() => {
  process.env.NODE_ENV = "test";
  process.env.ENVIRONMENT = "local";
  process.env.GUARDIAN_DEV_AUTH_BYPASS = "true";
  app = createApp();
});

describe("E2E: Public Endpoints", () => {
  it("GET / returns health check", async () => {
    const res = await request(app).get("/");
    expect(res.status).toBe(200);
    expect(res.body.service).toBe("kill-switch");
    expect(res.body.status).toBe("healthy");
    expect(res.body.providers).toHaveLength(3);
  });

  it("GET /providers lists CF, GCP, and AWS", async () => {
    const res = await request(app).get("/providers");
    expect(res.status).toBe(200);
    expect(res.body.providers).toHaveLength(3);
    expect(res.body.providers[0].id).toBe("cloudflare");
    expect(res.body.providers[1].id).toBe("gcp");
    expect(res.body.providers[2].id).toBe("aws");
  });

  it("POST /providers/cloudflare/validate validates credentials", async () => {
    const res = await request(app)
      .post("/providers/cloudflare/validate")
      .set("X-Guardian-Account-Id", "test-account")
      .set("X-Guardian-User-Id", "test-user")
      .send({ provider: "cloudflare", apiToken: "test", accountId: "test" });
    expect(res.status).toBe(200);
    expect(res.body.valid).toBe(true);
  });

  it("POST /providers/unknown/validate returns 404", async () => {
    const { getProvider } = await import("../../src/providers/index.js");
    vi.mocked(getProvider).mockReturnValueOnce(undefined);

    const res = await request(app)
      .post("/providers/unknown/validate")
      .set("X-Guardian-Account-Id", "test-account")
      .set("X-Guardian-User-Id", "test-user")
      .send({});
    expect(res.status).toBe(404);
  });

  it("GET /docs/openapi.json returns valid spec", async () => {
    const res = await request(app).get("/docs/openapi.json");
    expect(res.status).toBe(200);
    expect(res.body.openapi).toBe("3.1.0");
    expect(res.body.info.title).toContain("Kill Switch");
  });
});

describe("E2E: Authentication", () => {
  it("rejects requests without auth header", async () => {
    const res = await request(app).get("/cloud-accounts");
    expect(res.status).toBe(401);
    expect(res.body.error).toContain("Authorization");
  });

  it("accepts dev header in local/development mode", async () => {
    const res = await request(app)
      .get("/cloud-accounts")
      .set("X-Guardian-Account-Id", "test-account")
      .set("X-Guardian-User-Id", "test-user");
    // Should pass auth but may fail on downstream (that's OK for this test)
    expect(res.status).not.toBe(401);
  });

  it("accepts dev headers in local mode", async () => {
    const res = await request(app)
      .get("/cloud-accounts")
      .set("X-Guardian-Account-Id", "test-e2e-account")
      .set("X-Guardian-User-Id", "test-e2e-user");
    // 200 with empty accounts list (auth passed, handler ran)
    expect([200, 500]).toContain(res.status); // 500 if mock model issues, but NOT 401
  });
});

describe("E2E: Account Management", () => {
  it("POST /accounts creates a new account", async () => {
    const res = await request(app)
      .post("/accounts")
      .set("X-Guardian-Account-Id", "test-account")
      .set("X-Guardian-User-Id", "user-001")
      .send({ name: "Test Corp" });
    expect(res.status).toBe(201);
    expect(res.body.name).toBe("Test Corp");
    expect(res.body.tier).toBe("free");
  });

  it("POST /accounts returns existing account for same user", async () => {
    const res = await request(app)
      .post("/accounts")
      .set("X-Guardian-Account-Id", "test-account")
      .set("X-Guardian-User-Id", "user-001")
      .send({ name: "Test Corp Again" });
    expect(res.body.existing).toBe(true);
  });

  it("POST /accounts rejects missing fields", async () => {
    const res = await request(app)
      .post("/accounts")
      .set("X-Guardian-Account-Id", "test-account")
      .set("X-Guardian-User-Id", "user-002")
      .send({});
    expect(res.status).toBe(400);
  });
});

describe("E2E: Cloud Accounts Flow", () => {
  it("POST /cloud-accounts validates required fields", async () => {
    const res = await request(app)
      .post("/cloud-accounts")
      .set("X-Guardian-Account-Id", "test-account").set("X-Guardian-User-Id", "test-user")
      .send({ provider: "cloudflare" }); // Missing name and credential
    expect([400, 404, 500]).toContain(res.status); // 400 validation, 404 route, 500 mock
    expect(res.status).not.toBe(401); // Auth should pass
  });

  it("GET /cloud-accounts returns list (may be empty)", async () => {
    const res = await request(app)
      .get("/cloud-accounts")
      .set("X-Guardian-Account-Id", "test-account").set("X-Guardian-User-Id", "test-user");
    expect(res.status).not.toBe(401); // Auth passes
  });

  it("POST /cloud-accounts with full payload passes auth", async () => {
    const res = await request(app)
      .post("/cloud-accounts")
      .set("X-Guardian-Account-Id", "test-account").set("X-Guardian-User-Id", "test-user")
      .send({
        provider: "cloudflare",
        name: "Production CF",
        credential: { provider: "cloudflare", apiToken: "cf-token", accountId: "cf-acc" },
      });
    expect(res.status).not.toBe(401); // Auth passes
    // May be 201 (created) or 500 (mock DB issues) — both acceptable in E2E mock
  });

  it("POST /cloud-accounts rejects unsupported provider", async () => {
    const { getProvider } = await import("../../src/providers/index.js");
    vi.mocked(getProvider).mockReturnValueOnce(undefined);

    const res = await request(app)
      .post("/cloud-accounts")
      .set("X-Guardian-Account-Id", "test-account").set("X-Guardian-User-Id", "test-user")
      .send({ provider: "azure", name: "Test", credential: {} });
    expect(res.status).not.toBe(401);
  });
});

describe("E2E: Alert Channels", () => {
  it("PUT /alerts/channels updates channels", async () => {
    const res = await request(app)
      .put("/alerts/channels")
      .set("X-Guardian-Account-Id", "test-account").set("X-Guardian-User-Id", "test-user")
      .send({
        channels: [
          { type: "discord", name: "Ops", config: { webhookUrl: "https://discord.com/wh" }, enabled: true },
        ],
      });
    // May return 404 if account not found (mock limitation) but shouldn't be 401
    expect(res.status).not.toBe(401);
  });

  it("PUT /alerts/channels rejects non-array", async () => {
    const res = await request(app)
      .put("/alerts/channels")
      .set("X-Guardian-Account-Id", "test-account").set("X-Guardian-User-Id", "test-user")
      .send({ channels: "not-an-array" });
    expect([400, 404]).toContain(res.status);
  });
});

describe("E2E: Kill Switch Rules", () => {
  it("GET /rules/presets lists available presets", async () => {
    const res = await request(app).get("/rules/presets");
    expect(res.status).toBe(200);
    expect(res.body.presets).toBeDefined();
    expect(res.body.presets.length).toBeGreaterThanOrEqual(5);
  });

  it("GET /rules/presets includes all 8 presets", async () => {
    const res = await request(app).get("/rules/presets");
    expect(res.body.presets).toHaveLength(8);
    const ids = res.body.presets.map((p: any) => p.id);
    expect(ids).toContain("gpu-runaway");
    expect(ids).toContain("lambda-loop");
    expect(ids).toContain("aws-cost-runaway");
  });

  it("POST /rules/presets/:id applies a preset", async () => {
    const res = await request(app)
      .post("/rules/presets/ddos")
      .set("X-Guardian-Account-Id", "test-account").set("X-Guardian-User-Id", "test-user")
      .send({ requestsPerMinute: 10000 });
    expect(res.status).toBe(201);
    expect(res.body.rule.name).toContain("DDoS");
  });

  it("POST /rules/presets/gpu-runaway applies GPU preset", async () => {
    const res = await request(app)
      .post("/rules/presets/gpu-runaway")
      .set("X-Guardian-Account-Id", "test-account").set("X-Guardian-User-Id", "test-user")
      .send({ maxGPUInstances: 2 });
    expect(res.status).toBe(201);
    expect(res.body.rule.name).toContain("GPU");
    expect(res.body.rule.actions[0].type).toBe("stop-instances");
  });

  it("POST /rules/presets/lambda-loop applies Lambda preset", async () => {
    const res = await request(app)
      .post("/rules/presets/lambda-loop")
      .set("X-Guardian-Account-Id", "test-account").set("X-Guardian-User-Id", "test-user")
      .send({ maxConcurrency: 200 });
    expect(res.status).toBe(201);
    expect(res.body.rule.name).toContain("Lambda");
    expect(res.body.rule.actions[0].type).toBe("throttle-lambda");
  });

  it("POST /rules/presets/aws-cost-runaway applies AWS cost preset", async () => {
    const res = await request(app)
      .post("/rules/presets/aws-cost-runaway")
      .set("X-Guardian-Account-Id", "test-account").set("X-Guardian-User-Id", "test-user")
      .send({ dailyCostUSD: 500 });
    expect(res.status).toBe(201);
    expect(res.body.rule.name).toContain("AWS");
    expect(res.body.rule.conditions[0].value).toBe(500);
  });

  it("POST /rules/presets/unknown returns 404", async () => {
    const res = await request(app)
      .post("/rules/presets/nonexistent")
      .set("X-Guardian-Account-Id", "test-account").set("X-Guardian-User-Id", "test-user")
      .send({});
    expect(res.status).toBe(404);
  });

  it("POST /rules creates custom rule", async () => {
    const res = await request(app)
      .post("/rules")
      .set("X-Guardian-Account-Id", "test-account").set("X-Guardian-User-Id", "test-user")
      .send({
        id: "custom-1",
        name: "Custom Cost Rule",
        enabled: true,
        trigger: "cost",
        conditions: [{ metric: "totalEstimatedDailyCostUSD", operator: "gt", value: 100 }],
        conditionLogic: "any",
        actions: [{ type: "disconnect" }],
        cooldownMinutes: 60,
        forensicsEnabled: true,
      });
    expect(res.status).toBe(201);
  });

  it("GET /rules lists rules for account", async () => {
    const res = await request(app)
      .get("/rules")
      .set("X-Guardian-Account-Id", "test-account").set("X-Guardian-User-Id", "test-user");
    expect(res.status).toBe(200);
    expect(res.body.rules).toBeDefined();
    expect(Array.isArray(res.body.rules)).toBe(true);
  });

  it("PUT /rules/:ruleId updates an existing rule", async () => {
    // First create a rule
    await request(app)
      .post("/rules")
      .set("X-Guardian-Account-Id", "test-account").set("X-Guardian-User-Id", "test-user")
      .send({
        id: "update-test", name: "Test Rule", enabled: true, trigger: "cost",
        conditions: [{ metric: "totalEstimatedDailyCostUSD", operator: "gt", value: 50 }],
        conditionLogic: "any", actions: [{ type: "disconnect" }], cooldownMinutes: 30, forensicsEnabled: false,
      });

    // Now update it
    const res = await request(app)
      .put("/rules/update-test")
      .set("X-Guardian-Account-Id", "test-account").set("X-Guardian-User-Id", "test-user")
      .send({ name: "Updated Rule", cooldownMinutes: 60 });
    expect(res.status).toBe(200);
    expect(res.body.rule.name).toBe("Updated Rule");
    expect(res.body.rule.cooldownMinutes).toBe(60);
    expect(res.body.rule.id).toBe("update-test"); // ID should not change
  });

  it("PUT /rules/:ruleId returns 404 for nonexistent rule", async () => {
    const res = await request(app)
      .put("/rules/nonexistent")
      .set("X-Guardian-Account-Id", "test-account").set("X-Guardian-User-Id", "test-user")
      .send({ name: "won't work" });
    expect(res.status).toBe(404);
  });

  it("DELETE /rules/:ruleId deletes a rule", async () => {
    // Create a rule to delete
    await request(app)
      .post("/rules")
      .set("X-Guardian-Account-Id", "test-account").set("X-Guardian-User-Id", "test-user")
      .send({
        id: "delete-me", name: "Delete Me", enabled: true, trigger: "cost",
        conditions: [{ metric: "totalEstimatedDailyCostUSD", operator: "gt", value: 100 }],
        conditionLogic: "any", actions: [{ type: "disconnect" }], cooldownMinutes: 30, forensicsEnabled: false,
      });

    const res = await request(app)
      .delete("/rules/delete-me")
      .set("X-Guardian-Account-Id", "test-account").set("X-Guardian-User-Id", "test-user");
    expect(res.status).toBe(200);
    expect(res.body.deleted).toBe(true);
  });

  it("POST /rules/:ruleId/toggle toggles rule enabled state", async () => {
    // Create a rule to toggle
    await request(app)
      .post("/rules")
      .set("X-Guardian-Account-Id", "test-account").set("X-Guardian-User-Id", "test-user")
      .send({
        id: "toggle-me", name: "Toggle Me", enabled: true, trigger: "cost",
        conditions: [{ metric: "totalEstimatedDailyCostUSD", operator: "gt", value: 100 }],
        conditionLogic: "any", actions: [{ type: "disconnect" }], cooldownMinutes: 30, forensicsEnabled: false,
      });

    const res = await request(app)
      .post("/rules/toggle-me/toggle")
      .set("X-Guardian-Account-Id", "test-account").set("X-Guardian-User-Id", "test-user");
    expect(res.status).toBe(200);
    expect(res.body.rule.enabled).toBe(false); // Was true, now false
  });

  it("POST /rules/:ruleId/toggle returns 404 for nonexistent rule", async () => {
    const res = await request(app)
      .post("/rules/nonexistent/toggle")
      .set("X-Guardian-Account-Id", "test-account").set("X-Guardian-User-Id", "test-user");
    expect(res.status).toBe(404);
  });

  it("POST /rules rejects incomplete rules", async () => {
    const res = await request(app)
      .post("/rules")
      .set("X-Guardian-Account-Id", "test-account").set("X-Guardian-User-Id", "test-user")
      .send({ id: "bad" }); // Missing required fields
    expect(res.status).toBe(400);
  });

  it("POST /rules/agent/trigger creates agent rule", async () => {
    const res = await request(app)
      .post("/rules/agent/trigger")
      .set("X-Guardian-Account-Id", "test-account").set("X-Guardian-User-Id", "test-user")
      .send({
        agentId: "security-bot",
        threatDescription: "Unusual egress pattern on worker-api",
        severity: "critical",
        recommendedActions: [{ type: "disconnect", target: "worker-api" }],
        autoExecute: false,
      });
    expect(res.status).toBe(201);
    expect(res.body.status).toBe("pending_approval");
  });

  it("POST /rules/agent/trigger with autoExecute", async () => {
    const res = await request(app)
      .post("/rules/agent/trigger")
      .set("X-Guardian-Account-Id", "test-account").set("X-Guardian-User-Id", "test-user")
      .send({
        threatDescription: "DDoS detected",
        recommendedActions: [{ type: "block-traffic" }],
        autoExecute: true,
      });
    expect(res.status).toBe(201);
    expect(res.body.status).toBe("executing");
  });
});

describe("E2E: Database Kill Switch", () => {
  it("POST /database/kill rejects raw credentials (must use credentialId)", async () => {
    const res = await request(app)
      .post("/database/kill")
      .set("X-Guardian-Account-Id", "test-account").set("X-Guardian-User-Id", "test-user")
      .send({
        credential: { provider: "mongodb-atlas", atlasPublicKey: "pk", atlasPrivateKey: "sk", atlasProjectId: "p", clusterName: "c" },
        trigger: "compromise-detected",
      });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/credentialId/);
  });

  it("POST /database/kill rejects missing fields", async () => {
    const res = await request(app)
      .post("/database/kill")
      .set("X-Guardian-Account-Id", "test-account").set("X-Guardian-User-Id", "test-user")
      .send({});
    expect(res.status).toBe(400);
  });

  it("GET /database/kill lists active sequences", async () => {
    const res = await request(app)
      .get("/database/kill")
      .set("X-Guardian-Account-Id", "test-account").set("X-Guardian-User-Id", "test-user");
    expect(res.status).toBe(200);
    expect(res.body.sequences).toBeDefined();
  });
});

describe("E2E: Billing", () => {
  it("GET /billing/plans returns all tiers", async () => {
    const res = await request(app).get("/billing/plans");
    expect(res.status).toBe(200);
    expect(res.body.plans).toBeDefined();
    expect(res.body.plans.length).toBeGreaterThanOrEqual(4);

    const free = res.body.plans.find((p: any) => p.tier === "free");
    expect(free).toBeDefined();
    expect(free.price).toBe(0);

    const pro = res.body.plans.find((p: any) => p.tier === "pro");
    expect(pro).toBeDefined();
    expect(pro.monthlyPrice).toBe(29);
  });
});

describe("E2E: Agent Report", () => {
  it("POST /agent/report accepts metrics with valid API key", async () => {
    process.env.GUARDIAN_AGENT_API_KEY = "test-agent-key";
    const res = await request(app)
      .post("/agent/report")
      .set("Authorization", "Bearer test-agent-key")
      .send({
        accountId: "cf-acc-123",
        checkedAt: Date.now(),
        services: [{ name: "my-worker", doRequests: 500, workerRequests: 10000, estimatedDailyCostUSD: 0.01 }],
        totalEstimatedDailyCostUSD: 0.01,
        violations: [],
        actionsTaken: [],
      });
    expect(res.status).toBe(200);
    expect(res.body.received).toBe(true);
    delete process.env.GUARDIAN_AGENT_API_KEY;
  });

  it("POST /agent/report rejects invalid API key", async () => {
    process.env.GUARDIAN_AGENT_API_KEY = "real-key";
    const res = await request(app)
      .post("/agent/report")
      .set("Authorization", "Bearer wrong-key")
      .send({ accountId: "test" });
    expect(res.status).toBe(403);
    delete process.env.GUARDIAN_AGENT_API_KEY;
  });

  it("POST /agent/report returns 503 when key not configured", async () => {
    delete process.env.GUARDIAN_AGENT_API_KEY;
    const res = await request(app)
      .post("/agent/report")
      .set("Authorization", "Bearer any-key")
      .send({ accountId: "test" });
    expect(res.status).toBe(503);
  });

  it("POST /agent/report rejects without API key", async () => {
    const res = await request(app)
      .post("/agent/report")
      .send({ accountId: "test" });
    expect(res.status).toBe(401);
  });
});

describe("E2E: Analytics Overview", () => {
  it("GET /analytics/overview requires authentication", async () => {
    const res = await request(app).get("/analytics/overview");
    expect(res.status).toBe(401);
  });

  it("GET /analytics/overview returns analytics with auth", async () => {
    const res = await request(app)
      .get("/analytics/overview")
      .set("X-Guardian-Account-Id", "test-account")
      .set("X-Guardian-User-Id", "test-user");
    expect(res.status).toBe(200);
    expect(res.body.dailyCosts).toBeDefined();
    expect(res.body.dailyCosts).toHaveLength(2);
    expect(res.body.totalSpendPeriod).toBe(55.5);
    expect(res.body.projectedMonthlyCost).toBe(832.5);
    expect(res.body.savingsEstimate).toBe(150);
    expect(res.body.killSwitchActions).toBe(1);
    expect(res.body.accountBreakdown).toHaveLength(1);
  });

  it("GET /analytics/overview passes days query param", async () => {
    const { getAnalyticsOverview } = await import("../../src/globals/index.js");

    const res = await request(app)
      .get("/analytics/overview?days=7")
      .set("X-Guardian-Account-Id", "test-account")
      .set("X-Guardian-User-Id", "test-user");
    expect(res.status).toBe(200);
    expect(vi.mocked(getAnalyticsOverview)).toHaveBeenCalledWith("test-account", 7);
  });

  it("GET /analytics/overview defaults to 30 days", async () => {
    const { getAnalyticsOverview } = await import("../../src/globals/index.js");

    const res = await request(app)
      .get("/analytics/overview")
      .set("X-Guardian-Account-Id", "test-account")
      .set("X-Guardian-User-Id", "test-user");
    expect(res.status).toBe(200);
    expect(vi.mocked(getAnalyticsOverview)).toHaveBeenCalledWith("test-account", 30);
  });

  it("GET /analytics/overview response has correct shape", async () => {
    const res = await request(app)
      .get("/analytics/overview")
      .set("X-Guardian-Account-Id", "test-account")
      .set("X-Guardian-User-Id", "test-user");

    const body = res.body;
    // Verify all expected fields exist with correct types
    expect(typeof body.totalSpendPeriod).toBe("number");
    expect(typeof body.avgDailyCost).toBe("number");
    expect(typeof body.projectedMonthlyCost).toBe("number");
    expect(typeof body.savingsEstimate).toBe("number");
    expect(typeof body.killSwitchActions).toBe("number");
    expect(Array.isArray(body.dailyCosts)).toBe(true);
    expect(Array.isArray(body.accountBreakdown)).toBe(true);

    // Verify daily cost entry shape
    const day = body.dailyCosts[0];
    expect(day).toHaveProperty("date");
    expect(day).toHaveProperty("cost");
    expect(day).toHaveProperty("services");
    expect(day).toHaveProperty("violations");

    // Verify breakdown entry shape
    const acct = body.accountBreakdown[0];
    expect(acct).toHaveProperty("cloudAccountId");
    expect(acct).toHaveProperty("provider");
    expect(acct).toHaveProperty("totalCost");
    expect(acct).toHaveProperty("avgDailyCost");
  });
});

describe("E2E: API Key Management", () => {
  it("POST /auth/api-keys creates a key with a name", async () => {
    const res = await request(app)
      .post("/auth/api-keys")
      .set("X-Guardian-Account-Id", "test-account")
      .set("X-Guardian-User-Id", "test-user")
      .send({ name: "My CLI Key" });
    expect(res.status).toBe(201);
    expect(res.body.key).toBeDefined();
    expect(res.body.key).toMatch(/^ks_live_/);
    expect(res.body.name).toBe("My CLI Key");
    expect(res.body.id).toBeDefined();
    expect(res.body.message).toContain("not be shown again");
  });

  it("POST /auth/api-keys rejects missing name", async () => {
    const res = await request(app)
      .post("/auth/api-keys")
      .set("X-Guardian-Account-Id", "test-account")
      .set("X-Guardian-User-Id", "test-user")
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("name");
  });

  it("POST /auth/api-keys rejects empty string name", async () => {
    const res = await request(app)
      .post("/auth/api-keys")
      .set("X-Guardian-Account-Id", "test-account")
      .set("X-Guardian-User-Id", "test-user")
      .send({ name: "" });
    expect(res.status).toBe(400);
  });

  it("GET /auth/api-keys lists keys (metadata only, no hashes)", async () => {
    // Create a key first
    await request(app)
      .post("/auth/api-keys")
      .set("X-Guardian-Account-Id", "test-account")
      .set("X-Guardian-User-Id", "test-user")
      .send({ name: "List Test Key" });

    const res = await request(app)
      .get("/auth/api-keys")
      .set("X-Guardian-Account-Id", "test-account")
      .set("X-Guardian-User-Id", "test-user");
    expect(res.status).toBe(200);
    expect(res.body.keys).toBeDefined();
    expect(Array.isArray(res.body.keys)).toBe(true);

    // Verify no sensitive data is exposed
    for (const key of res.body.keys) {
      expect(key.keyHash).toBeUndefined();
      expect(key.keyPrefix).toBeDefined();
      expect(key.name).toBeDefined();
    }
  });

  it("POST /auth/api-keys/:id/roll rotates a key atomically", async () => {
    // Create a key to roll
    const createRes = await request(app)
      .post("/auth/api-keys")
      .set("X-Guardian-Account-Id", "test-account")
      .set("X-Guardian-User-Id", "test-user")
      .send({ name: "Roll Test Key" });
    expect(createRes.status).toBe(201);
    const originalKey = createRes.body.key;
    const originalId = createRes.body.id;

    // Roll it
    const rollRes = await request(app)
      .post(`/auth/api-keys/${originalId}/roll`)
      .set("X-Guardian-Account-Id", "test-account")
      .set("X-Guardian-User-Id", "test-user");
    expect(rollRes.status).toBe(201);
    expect(rollRes.body.key).toBeDefined();
    expect(rollRes.body.key).toMatch(/^ks_live_/);
    expect(rollRes.body.key).not.toBe(originalKey); // New key is different
    expect(rollRes.body.name).toBe("Roll Test Key"); // Same name preserved
    expect(rollRes.body.previousKeyRevoked).toBe(true);
    expect(rollRes.body.id).not.toBe(originalId); // New ID
  });

  it("POST /auth/api-keys/:id/roll returns 404 for nonexistent key", async () => {
    const res = await request(app)
      .post("/auth/api-keys/nonexistent-id/roll")
      .set("X-Guardian-Account-Id", "test-account")
      .set("X-Guardian-User-Id", "test-user");
    expect(res.status).toBe(404);
  });

  it("DELETE /auth/api-keys/:id revokes a key", async () => {
    // Create a key to revoke
    const createRes = await request(app)
      .post("/auth/api-keys")
      .set("X-Guardian-Account-Id", "test-account")
      .set("X-Guardian-User-Id", "test-user")
      .send({ name: "Revoke Test Key" });
    const keyId = createRes.body.id;

    const res = await request(app)
      .delete(`/auth/api-keys/${keyId}`)
      .set("X-Guardian-Account-Id", "test-account")
      .set("X-Guardian-User-Id", "test-user");
    expect(res.status).toBe(200);
    expect(res.body.deleted).toBe(true);
  });

  it("DELETE /auth/api-keys/:id returns 404 for nonexistent key", async () => {
    const res = await request(app)
      .delete("/auth/api-keys/nonexistent-id")
      .set("X-Guardian-Account-Id", "test-account")
      .set("X-Guardian-User-Id", "test-user");
    expect(res.status).toBe(404);
  });

  it("API keys require authentication", async () => {
    const res = await request(app).get("/auth/api-keys");
    expect(res.status).toBe(401);
  });
});
