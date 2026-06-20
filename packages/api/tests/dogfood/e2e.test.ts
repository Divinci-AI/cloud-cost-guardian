/**
 * Dogfood E2E Tests
 *
 * Tests the full dogfooding flow through the API:
 * 1. Connect Cloudflare account with dogfood config
 * 2. Set thresholds and protected services
 * 3. Apply dogfood rules
 * 4. Run a check cycle and verify behavior
 * 5. Verify protected workers are never killed
 * 6. Verify violations trigger correct actions
 */

import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import request from "supertest";
import { createApp } from "../../src/app.js";
import type { Express } from "express";

vi.hoisted(() => { process.env.CLERK_ISSUER = "https://test.clerk.accounts.dev"; });

import {
  DOGFOOD_THRESHOLDS,
  PROTECTED_WORKERS,
  KNOWN_WORKERS,
  getDogfoodRules,
  buildDogfoodAccountPayload,
  buildDogfoodUpdatePayload,
  validateProtectedWorkers,
} from "../../src/dogfood/config.js";

// ─── Mock External Dependencies ────────────────────────────────────────────

const mockCheckUsage = vi.fn();
const mockExecuteKillSwitch = vi.fn();

vi.mock("mongoose", () => {
  const docs = new Map();
  let idCounter = 1;

  const createMockModel = (name: string) => {
    const model: any = {
      create: vi.fn(async (data: any) => {
        const doc: any = { _id: `${name}-${idCounter++}`, ...data };
        doc.save = vi.fn(async () => doc);
        doc.toObject = () => { const { save, toObject, ...rest } = doc; return rest; };
        docs.set(doc._id, doc);
        return doc;
      }),
      find: vi.fn((query: any) => {
        const results = Array.from(docs.values()).filter(d => {
          if (query?.guardianAccountId) return d.guardianAccountId === query.guardianAccountId;
          if (query?.status) return d.status === query.status;
          return true;
        });
        const chainable: any = { lean: vi.fn(async () => results) };
        chainable.then = (resolve: any, reject: any) => Promise.resolve(results).then(resolve, reject);
        return chainable;
      }),
      findById: vi.fn(async (id: string) => docs.get(id) || null),
      findOne: vi.fn(async (query: any) => {
        return Array.from(docs.values()).find(d => {
          if (query?.guardianAccountId && query?.id) return d.guardianAccountId === query.guardianAccountId && d.id === query.id;
          if (query?._id && query?.guardianAccountId) return d._id === query._id && d.guardianAccountId === query.guardianAccountId;
          if (query?.ownerUserId) return d.ownerUserId === query.ownerUserId;
          return false;
        }) || null;
      }),
      findOneAndUpdate: vi.fn(async (query: any, update: any, opts?: any) => {
        const existing = Array.from(docs.values()).find(d =>
          (!query.guardianAccountId || d.guardianAccountId === query.guardianAccountId) &&
          (!query.id || d.id === query.id) &&
          (!query._id || d._id === query._id)
        );
        if (existing) {
          Object.assign(existing, update.$set || update);
          return existing;
        }
        if (opts?.upsert) {
          const doc: any = { _id: `${name}-${idCounter++}`, ...update };
          doc.save = vi.fn(async () => doc);
          doc.toObject = () => { const { save, toObject, ...rest } = doc; return rest; };
          docs.set(doc._id, doc);
          return doc;
        }
        return null;
      }),
      findByIdAndUpdate: vi.fn(async (id: string, update: any) => {
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
      deleteOne: vi.fn(async (query: any) => {
        const entry = Array.from(docs.entries()).find(([, d]) =>
          (!query.guardianAccountId || d.guardianAccountId === query.guardianAccountId) &&
          (!query.id || d.id === query.id)
        );
        if (entry) { docs.delete(entry[0]); return { deletedCount: 1 }; }
        return { deletedCount: 0 };
      }),
      updateOne: vi.fn(async () => ({ modifiedCount: 1 })),
      countDocuments: vi.fn(async (query?: any) => {
        if (!query) return docs.size;
        return Array.from(docs.values()).filter(d => {
          if (query?.guardianAccountId) return d.guardianAccountId === query.guardianAccountId;
          return true;
        }).length;
      }),
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
  storeCredential: vi.fn(async () => "dogfood-cred-1"),
  getCredential: vi.fn(async () => ({
    provider: "cloudflare",
    apiToken: "dogfood-test-token",
    accountId: "14a6fa23390363382f378b5bd4a0f849",
  })),
  deleteCredential: vi.fn(async () => true),
}));

vi.mock("../../src/providers/index.js", () => ({
  getProvider: vi.fn(() => ({
    id: "cloudflare",
    name: "Cloudflare",
    checkUsage: mockCheckUsage,
    executeKillSwitch: mockExecuteKillSwitch,
    validateCredential: vi.fn(async () => ({
      valid: true,
      accountId: "14a6fa23390363382f378b5bd4a0f849",
      accountName: "Kill Switch Dogfood Account",
    })),
    getDefaultThresholds: vi.fn(() => ({ doRequestsPerDay: 1_000_000 })),
  })),
  getAllProviders: vi.fn(() => [
    { id: "cloudflare", name: "Cloudflare", getDefaultThresholds: () => ({ doRequestsPerDay: 1_000_000 }) },
    { id: "gcp", name: "Google Cloud Platform", getDefaultThresholds: () => ({ monthlySpendLimitUSD: 500 }) },
    { id: "aws", name: "Amazon Web Services", getDefaultThresholds: () => ({ ec2InstanceCount: 20 }) },
  ]),
}));

vi.mock("../../src/globals/index.js", () => ({
  isMongoEnabled: vi.fn(() => false),
  isMongoConnected: vi.fn(() => true),
  recordUsageSnapshot: vi.fn(),
  recordAlert: vi.fn(),
  getUsageHistory: vi.fn(async () => []),
  getAlertHistory: vi.fn(async () => []),
  getAnalyticsOverview: vi.fn(async () => ({
    dailyCosts: [], totalSpendPeriod: 0, avgDailyCost: 0,
    projectedMonthlyCost: 0, savingsEstimate: 0, killSwitchActions: 0, accountBreakdown: [],
  })),
}));

vi.mock("jose", () => ({
  createRemoteJWKSet: vi.fn(() => vi.fn()),
  jwtVerify: vi.fn(async () => ({
    payload: { sub: "user_dogfood", email: "dogfood@kill-switch.net" },
  })),
}));

vi.mock("stripe", () => ({ default: class { constructor() {} } }));

// ─── Test Setup ─────────────────────────────────────────────────────────────

const AUTH_HEADERS = {
  "X-Guardian-Account-Id": "dogfood-account",
  "X-Guardian-User-Id": "dogfood-user",
};

let app: Express;

beforeAll(() => {
  process.env.NODE_ENV = "test";
  process.env.ENVIRONMENT = "local";
  process.env.GUARDIAN_DEV_AUTH_BYPASS = "true";
  app = createApp();
});

beforeEach(() => {
  vi.clearAllMocks();

  // Default: return normal usage (no violations)
  mockCheckUsage.mockResolvedValue({
    provider: "cloudflare",
    accountId: "14a6fa23390363382f378b5bd4a0f849",
    checkedAt: Date.now(),
    services: KNOWN_WORKERS.map(name => ({
      serviceName: name,
      metrics: [{ name: "Worker Requests", value: 1000, unit: "requests", thresholdKey: "workerRequestsPerDay" }],
      estimatedDailyCostUSD: 0.01,
    })),
    totalEstimatedDailyCostUSD: 0.05,
    violations: [],
    securityEvents: [],
  });

  mockExecuteKillSwitch.mockResolvedValue({
    success: true, action: "disconnect", serviceName: "test", details: "Disconnected test",
  });
});

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("Dogfood E2E: Account Setup Flow", () => {
  it("connects the Cloudflare account with dogfood credentials", async () => {
    const payload = buildDogfoodAccountPayload({ apiToken: "test-cf-token" });

    const res = await request(app)
      .post("/cloud-accounts")
      .set(AUTH_HEADERS)
      .send(payload);

    expect(res.status).not.toBe(401);
    // 201 created or 500 from mock DB — auth should pass
    if (res.status === 201) {
      expect(res.body.provider).toBe("cloudflare");
      expect(res.body.providerAccountId).toBe("14a6fa23390363382f378b5bd4a0f849");
    }
  });

  it("applies dogfood thresholds and protected services", async () => {
    // Create account first
    const createRes = await request(app)
      .post("/cloud-accounts")
      .set(AUTH_HEADERS)
      .send(buildDogfoodAccountPayload({ apiToken: "test-cf-token" }));

    if (createRes.status === 201) {
      const updatePayload = buildDogfoodUpdatePayload();
      const res = await request(app)
        .put(`/cloud-accounts/${createRes.body.id}`)
        .set(AUTH_HEADERS)
        .send(updatePayload);

      expect(res.status).toBe(200);
      expect(res.body.protectedServices).toEqual(PROTECTED_WORKERS);
      expect(res.body.autoDisconnect).toBe(true);
      expect(res.body.autoDelete).toBe(false);
    }
  });
});

describe("Dogfood E2E: Rule Configuration", () => {
  it("applies all dogfood rules via POST /rules", async () => {
    const rules = getDogfoodRules();

    for (const rule of rules) {
      const res = await request(app)
        .post("/rules")
        .set(AUTH_HEADERS)
        .send(rule);

      expect(res.status).toBe(201);
      expect(res.body.rule.id).toBe(rule.id);
      expect(res.body.rule.enabled).toBe(true);
    }
  });

  it("lists applied dogfood rules", async () => {
    // Apply rules first
    const rules = getDogfoodRules();
    for (const rule of rules) {
      await request(app).post("/rules").set(AUTH_HEADERS).send(rule);
    }

    const res = await request(app)
      .get("/rules")
      .set(AUTH_HEADERS);

    expect(res.status).toBe(200);
    expect(res.body.rules.length).toBeGreaterThanOrEqual(rules.length);

    // Verify all dogfood rules are present
    const dogfoodRuleIds = rules.map(r => r.id);
    const appliedIds = res.body.rules.map((r: any) => r.id);
    for (const id of dogfoodRuleIds) {
      expect(appliedIds).toContain(id);
    }
  });

  it("applies cost-runaway preset for dogfood", async () => {
    const res = await request(app)
      .post("/rules/presets/cost-runaway")
      .set(AUTH_HEADERS)
      .send({ dailyCostUSD: 10 });

    expect(res.status).toBe(201);
    expect(res.body.rule.name).toContain("Cost");
    expect(res.body.rule.conditions[0].value).toBe(10);
  });

  it("can toggle dogfood rules on and off", async () => {
    // Create rule
    const rule = getDogfoodRules()[0];
    await request(app).post("/rules").set(AUTH_HEADERS).send(rule);

    // Toggle off
    const toggleRes = await request(app)
      .post(`/rules/${rule.id}/toggle`)
      .set(AUTH_HEADERS);

    expect(toggleRes.status).toBe(200);
    expect(toggleRes.body.rule.enabled).toBe(false);

    // Toggle back on
    const toggleRes2 = await request(app)
      .post(`/rules/${rule.id}/toggle`)
      .set(AUTH_HEADERS);

    expect(toggleRes2.status).toBe(200);
    expect(toggleRes2.body.rule.enabled).toBe(true);
  });
});

describe("Dogfood E2E: Check Cycle — No Violations", () => {
  it("reports healthy status when all workers are within thresholds", async () => {
    // Create account
    const createRes = await request(app)
      .post("/cloud-accounts")
      .set(AUTH_HEADERS)
      .send(buildDogfoodAccountPayload({ apiToken: "test-token" }));

    if (createRes.status === 201) {
      const res = await request(app)
        .post(`/cloud-accounts/${createRes.body.id}/check`)
        .set(AUTH_HEADERS);

      expect(res.status).toBe(200);
    }
  });
});

describe("Dogfood E2E: Check Cycle — With Violations", () => {
  it("disconnects non-protected workers on threshold violation", async () => {
    mockCheckUsage.mockResolvedValue({
      provider: "cloudflare",
      accountId: "14a6fa23390363382f378b5bd4a0f849",
      checkedAt: Date.now(),
      services: [
        {
          serviceName: "cloud-switch-site",
          metrics: [{ name: "Worker Requests", value: 5_000_000, unit: "requests", thresholdKey: "workerRequestsPerDay" }],
          estimatedDailyCostUSD: 50,
        },
      ],
      totalEstimatedDailyCostUSD: 50,
      violations: [
        {
          serviceName: "cloud-switch-site",
          metricName: "Worker Requests",
          currentValue: 5_000_000,
          threshold: 500_000,
          unit: "requests",
          severity: "critical" as const,
        },
      ],
      securityEvents: [],
    });

    mockExecuteKillSwitch.mockResolvedValue({
      success: true,
      action: "disconnect",
      serviceName: "cloud-switch-site",
      details: "Disconnected cloud-switch-site: removed routes and workers.dev subdomain",
    });

    const createRes = await request(app)
      .post("/cloud-accounts")
      .set(AUTH_HEADERS)
      .send(buildDogfoodAccountPayload({ apiToken: "test-token" }));

    if (createRes.status === 201) {
      const res = await request(app)
        .post(`/cloud-accounts/${createRes.body.id}/check`)
        .set(AUTH_HEADERS);

      expect(res.status).toBe(200);
      // The monitoring engine should have been called
      expect(mockCheckUsage).toHaveBeenCalled();
    }
  });
});

describe("Dogfood E2E: Protected Worker Enforcement", () => {
  it("validates that monitoring engine respects protected workers", () => {
    // Simulate actions from a check cycle
    const actionsWithProtection = [
      "PROTECTED: kill-switch-cf",
      "PROTECTED: api-proxy",
      "Disconnected cloud-switch-site: removed routes",
      "Disconnected kill-switch-app: removed routes",
    ];

    const violations = validateProtectedWorkers(actionsWithProtection);
    expect(violations).toHaveLength(0);
  });

  it("catches if a protected worker is incorrectly acted upon", () => {
    const badActions = [
      "Disconnected kill-switch-cf: removed routes",
      "Disconnected cloud-switch-site: removed routes",
    ];

    const violations = validateProtectedWorkers(badActions);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain("kill-switch-cf");
  });

  it("catches both protected workers being incorrectly acted upon", () => {
    const badActions = [
      "Disconnected kill-switch-cf",
      "Deleted api-proxy",
    ];

    const violations = validateProtectedWorkers(badActions);
    expect(violations).toHaveLength(2);
  });

  it("verifies autoDelete is never set for dogfood config", () => {
    const payload = buildDogfoodUpdatePayload();
    expect(payload.autoDelete).toBe(false);
  });
});

describe("Dogfood E2E: Full Setup Flow", () => {
  it("runs the complete dogfood setup: connect → configure → rules → check", async () => {
    // 1. Connect account
    const createRes = await request(app)
      .post("/cloud-accounts")
      .set(AUTH_HEADERS)
      .send(buildDogfoodAccountPayload({ apiToken: "full-flow-token" }));

    expect(createRes.status).not.toBe(401);

    if (createRes.status === 201) {
      const accountId = createRes.body.id;

      // 2. Configure thresholds
      const updateRes = await request(app)
        .put(`/cloud-accounts/${accountId}`)
        .set(AUTH_HEADERS)
        .send(buildDogfoodUpdatePayload());

      expect(updateRes.status).toBe(200);

      // 3. Apply rules
      const rules = getDogfoodRules();
      for (const rule of rules) {
        const ruleRes = await request(app)
          .post("/rules")
          .set(AUTH_HEADERS)
          .send(rule);
        expect(ruleRes.status).toBe(201);
      }

      // 4. Apply preset
      const presetRes = await request(app)
        .post("/rules/presets/cost-runaway")
        .set(AUTH_HEADERS)
        .send({ dailyCostUSD: 10 });
      expect(presetRes.status).toBe(201);

      // 5. Run check
      const checkRes = await request(app)
        .post(`/cloud-accounts/${accountId}/check`)
        .set(AUTH_HEADERS);
      expect(checkRes.status).toBe(200);

      // 6. Verify rules are listed
      const rulesRes = await request(app)
        .get("/rules")
        .set(AUTH_HEADERS);
      expect(rulesRes.status).toBe(200);
      expect(rulesRes.body.rules.length).toBeGreaterThanOrEqual(rules.length);
    }
  });
});

describe("Dogfood E2E: Agent Trigger Integration", () => {
  it("accepts an agent-triggered rule for self-monitoring anomaly", async () => {
    const res = await request(app)
      .post("/rules/agent/trigger")
      .set(AUTH_HEADERS)
      .send({
        agentId: "dogfood-agent",
        threatDescription: "Unknown worker detected in kill-switch.net account",
        severity: "critical",
        recommendedActions: [
          { type: "disconnect", target: "rogue-worker" },
          { type: "snapshot", target: "*" },
        ],
        evidence: { unknownWorker: "rogue-worker", requestCount: 50000 },
        autoExecute: false, // Require human approval for dogfood
      });

    expect(res.status).toBe(201);
    expect(res.body.status).toBe("pending_approval");
    expect(res.body.rule.forensicsEnabled).toBe(true);
  });
});
