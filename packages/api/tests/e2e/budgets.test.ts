/**
 * E2E / integration tests for the /budgets and /push routes.
 *
 * Uses the same createApp() + mocked-mongoose pattern as api.test.ts.
 * Postgres pool is stubbed to return zero spend so tests run offline.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";

// ── vi.hoisted — runs before vi.mock() factories, so stores are accessible ───
const {
  budgetStore, accountStore, userStore, pushStore, mockQuery,
  ORG_ID, USER_ID, TEST_TOKEN,
} = vi.hoisted(() => {
  process.env.GUARDIAN_MASTER_SECRET = "test-master-secret-at-least-32-chars!!";
  process.env.CLERK_ISSUER = "https://test.clerk.accounts.dev";
  process.env.VAPID_PUBLIC_KEY = "BCvTKuCyDf_XfFZ9FiHs5xIHpAm3XUqDGbQv7Yx4aBC";
  process.env.VAPID_PRIVATE_KEY = "kdl3mUJpMp_ABC123FAKE_PRIVATE";
  process.env.CLERK_ALLOWED_AZP = "test.app";

  type Doc = Record<string, any>;

  function qb(p: Promise<any>): any {
    const x = p as any;
    x.lean = () => p;
    x.sort = (_by?: any) => qb(p);
    return x;
  }

  function matchesDoc(doc: Doc, q: Doc): boolean {
    return Object.entries(q).every(([k, v]) => doc[k] === v);
  }

  function fakeStore(initial: Doc[] = []) {
    const store: Doc[] = initial;
    return {
      _store: store,
      find: vi.fn((q: Doc = {}) => qb(Promise.resolve(store.filter(d => matchesDoc(d, q))))),
      findOne: vi.fn((q: Doc) => {
        const raw = store.find(d => matchesDoc(d, q)) ?? null;
        if (!raw) return qb(Promise.resolve(null));
        const doc: any = {
          ...raw,
          save: vi.fn(async () => { Object.assign(raw, doc); return doc; }),
          toObject: () => { const { save: _s, toObject: _t, ...rest } = doc; return rest; },
        };
        return qb(Promise.resolve(doc));
      }),
      findById: vi.fn((id: string) => {
        const raw = store.find(d => d._id === id || d.id === id) ?? null;
        if (!raw) return qb(Promise.resolve(null));
        const doc: any = {
          ...raw,
          save: vi.fn(async () => { Object.assign(raw, doc); return doc; }),
          toObject: () => { const { save: _s, toObject: _t, ...rest } = doc; return rest; },
        };
        return qb(Promise.resolve(doc));
      }),
      countDocuments: vi.fn(async (q: Doc) => store.filter(d => matchesDoc(d, q)).length),
      create: vi.fn(async (data: Doc) => {
        const doc = { _id: `_${Math.floor(Math.random() * 1e9)}`, id: data.id || `budget-${Date.now()}`, ...data };
        store.push(doc);
        return { ...doc, toObject: () => doc };
      }),
      findOneAndUpdate: vi.fn(async (q: Doc, update: Doc, opts: any) => {
        let doc = store.find(d => matchesDoc(d, q));
        if (!doc && opts?.upsert) {
          doc = { _id: `_u${Date.now()}`, ...q };
          store.push(doc);
        }
        if (doc) Object.assign(doc, update.$set ?? update);
        return doc ?? null;
      }),
      updateOne: vi.fn(async (q: Doc, update: Doc) => {
        const doc = store.find(d => matchesDoc(d, q));
        if (doc) Object.assign(doc, update.$set ?? {});
        return { modifiedCount: doc ? 1 : 0 };
      }),
      deleteOne: vi.fn(async (q: Doc) => {
        const i = store.findIndex(d => matchesDoc(d, q));
        if (i !== -1) store.splice(i, 1);
        return { deletedCount: i !== -1 ? 1 : 0 };
      }),
    };
  }

  const mockQuery = vi.fn().mockResolvedValue({ rows: [{ total: "0", daily_rate: "0" }] });

  // Must be a valid 24-char hex MongoDB ObjectId (resolveOrgById validates this)
  const ORG_ID = "aaaaaaaaaaaaaaaaaaaaaaaa";
  const USER_ID = "user_test123";

  const budgetStore = fakeStore([]);
  const accountStore = fakeStore([
    { _id: ORG_ID, id: ORG_ID, tier: "pro", alertChannels: [], ownerUserId: USER_ID },
  ]);
  const userStore = fakeStore([
    { _id: USER_ID, clerkId: USER_ID, guardianAccountId: ORG_ID },
  ]);
  const pushStore = fakeStore([]);

  return { budgetStore, accountStore, userStore, pushStore, mockQuery, ORG_ID, USER_ID, TEST_TOKEN: "Bearer test-jwt-token" };
});

// ── Mock jose (JWT verification) ──────────────────────────────────────────────
vi.mock("jose", async actual => {
  const real = await actual<typeof import("jose")>();
  return {
    ...real,
    createRemoteJWKSet: vi.fn(),
    jwtVerify: vi.fn().mockResolvedValue({
      payload: {
        sub: "user_test123",
        azp: "test.app",
        iss: process.env.CLERK_ISSUER,
      },
    }),
  };
});

// ── Mock web-push ──────────────────────────────────────────────────────────────
vi.mock("web-push", () => ({
  default: {
    setVapidDetails: vi.fn(),
    sendNotification: vi.fn().mockResolvedValue({}),
  },
}));

vi.mock("mongoose", async actual => {
  const real = await actual<typeof import("mongoose")>();
  return { ...real, connect: vi.fn().mockResolvedValue(undefined) };
});

vi.mock("../../src/models/user-budget/schema.js", () => ({ UserBudgetModel: budgetStore }));
vi.mock("../../src/models/guardian-account/schema.js", () => ({
  GuardianAccountModel: accountStore,
  generateSlug: vi.fn((name: string) => name.toLowerCase().replace(/\s+/g, "-")),
}));
vi.mock("../../src/models/user/schema.js", () => ({ UserModel: userStore }));
vi.mock("../../src/models/push-subscription/schema.js", () => ({ PushSubscriptionModel: pushStore }));
vi.mock("../../src/models/team/schema.js", () => ({
  TeamMemberModel: { findOne: vi.fn().mockResolvedValue(null) },
}));
vi.mock("../../src/models/user-profile/schema.js", () => ({
  UserProfileModel: {
    findOne: vi.fn().mockResolvedValue(null),
    findOneAndUpdate: vi.fn().mockResolvedValue(null),
  },
}));
vi.mock("../../src/globals/index.js", () => ({
  isMongoEnabled: vi.fn(() => false),
  isMongoConnected: vi.fn(() => true),
  getPostgresPool: () => ({ query: mockQuery }),
}));

// ── Create app ────────────────────────────────────────────────────────────────
import { createApp } from "../../src/app.js";
const app = createApp();

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────
const authHeader = { Authorization: TEST_TOKEN };
const orgHeader = { "x-org-id": ORG_ID };
const headers = { ...authHeader, ...orgHeader };

// ─────────────────────────────────────────────────────────────────────────────
describe("GET /budgets", () => {
  beforeEach(() => {
    budgetStore._store.length = 0;
  });

  it("requires authentication", async () => {
    const res = await request(app).get("/budgets");
    expect(res.status).toBe(401);
  });

  it("returns empty array when no budgets", async () => {
    const res = await request(app).get("/budgets").set(headers);
    expect(res.status).toBe(200);
    expect(res.body.budgets).toEqual([]);
  });

  it("lists existing budgets without notifiedThresholds", async () => {
    budgetStore._store.push({
      _id: "b1", id: "budget-b1", guardianAccountId: ORG_ID,
      name: "My Budget", period: "day", budgetAmountUsd: 100,
      thresholdPcts: [75, 90], channels: "all",
      enabled: true, notifiedThresholds: [75],
      periodStartedAt: Date.now(),
    });

    const res = await request(app).get("/budgets").set(headers);
    expect(res.status).toBe(200);
    expect(res.body.budgets).toHaveLength(1);
    expect(res.body.budgets[0].notifiedThresholds).toBeUndefined();
    expect(res.body.budgets[0].name).toBe("My Budget");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("POST /budgets", () => {
  beforeEach(() => {
    budgetStore._store.length = 0;
  });

  it("rejects unauthenticated requests", async () => {
    const res = await request(app).post("/budgets").send({ name: "x", period: "day", budgetAmountUsd: 10 });
    expect(res.status).toBe(401);
  });

  it("creates a budget with valid payload", async () => {
    const res = await request(app)
      .post("/budgets")
      .set(headers)
      .send({ name: "Dev Spend", period: "day", budgetAmountUsd: 50, thresholdPcts: [75, 100] });

    expect(res.status).toBe(201);
    expect(res.body.budget.name).toBe("Dev Spend");
    expect(res.body.budget.period).toBe("day");
    expect(res.body.budget.notifiedThresholds).toBeUndefined();
  });

  it("rejects invalid period", async () => {
    const res = await request(app)
      .post("/budgets")
      .set(headers)
      .send({ name: "Bad", period: "quarterly", budgetAmountUsd: 50 });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("period");
  });

  it("rejects negative budgetAmountUsd", async () => {
    const res = await request(app)
      .post("/budgets")
      .set(headers)
      .send({ name: "Bad", period: "day", budgetAmountUsd: -10 });
    expect(res.status).toBe(400);
  });

  it("rejects budgetAmountUsd exceeding $10M", async () => {
    const res = await request(app)
      .post("/budgets")
      .set(headers)
      .send({ name: "Whale", period: "year", budgetAmountUsd: 20_000_000 });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("10,000,000");
  });

  it("enforces tier budget limit (pro = 10)", async () => {
    for (let i = 0; i < 10; i++) {
      budgetStore._store.push({
        _id: `b${i}`, id: `budget-${i}`, guardianAccountId: ORG_ID,
        name: `Budget ${i}`, period: "day", budgetAmountUsd: 10,
        thresholdPcts: [75], channels: "all", enabled: true,
        notifiedThresholds: [], periodStartedAt: Date.now(),
      });
    }

    const res = await request(app)
      .post("/budgets")
      .set(headers)
      .send({ name: "Over limit", period: "day", budgetAmountUsd: 10 });

    expect(res.status).toBe(403);
    expect(res.body.error).toContain("plan");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("PATCH /budgets/:id", () => {
  beforeEach(() => {
    budgetStore._store.length = 0;
    budgetStore._store.push({
      _id: "bpatch", id: "budget-patch", guardianAccountId: ORG_ID,
      name: "Patchable", period: "day", budgetAmountUsd: 100,
      thresholdPcts: [75], channels: "all", enabled: true,
      notifiedThresholds: [], periodStartedAt: Date.now(),
    });
  });

  it("returns 404 for unknown budget", async () => {
    const res = await request(app)
      .patch("/budgets/budget-nope")
      .set(headers)
      .send({ enabled: false });
    expect(res.status).toBe(404);
  });

  it("updates name and enabled flag", async () => {
    const res = await request(app)
      .patch("/budgets/budget-patch")
      .set(headers)
      .send({ name: "Updated Name", enabled: false });
    expect(res.status).toBe(200);
    expect(res.body.budget.name).toBe("Updated Name");
    expect(res.body.budget.enabled).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("DELETE /budgets/:id", () => {
  it("deletes a budget by id", async () => {
    budgetStore._store.push({
      _id: "bdel", id: "budget-del", guardianAccountId: ORG_ID,
      name: "To Delete", period: "day", budgetAmountUsd: 10,
      thresholdPcts: [75], channels: "all", enabled: true,
      notifiedThresholds: [], periodStartedAt: Date.now(),
    });

    const res = await request(app)
      .delete("/budgets/budget-del")
      .set(headers);
    expect(res.status).toBe(200);
    expect(res.body.deleted).toBe(true);
  });

  it("returns 404 for missing budget", async () => {
    budgetStore._store.length = 0;
    const res = await request(app)
      .delete("/budgets/budget-missing")
      .set(headers);
    expect(res.status).toBe(404);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("GET /push/vapid-public-key", () => {
  it("returns public key without auth", async () => {
    const res = await request(app).get("/push/vapid-public-key");
    expect(res.status).toBe(200);
    expect(res.body.publicKey).toBeTruthy();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("POST /push/subscribe", () => {
  beforeEach(() => {
    pushStore._store.length = 0;
  });

  it("requires auth", async () => {
    const res = await request(app).post("/push/subscribe").send({
      endpoint: "https://fcm.googleapis.com/fcm/send/test",
      keys: { p256dh: "key1", auth: "auth1" },
    });
    expect(res.status).toBe(401);
  });

  it("rejects HTTP endpoint (SSRF guard)", async () => {
    const res = await request(app)
      .post("/push/subscribe")
      .set(headers)
      .send({
        endpoint: "http://fcm.googleapis.com/fcm/send/test",
        keys: { p256dh: "key1", auth: "auth1" },
      });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("endpoint");
  });

  it("rejects localhost endpoint (SSRF guard)", async () => {
    const res = await request(app)
      .post("/push/subscribe")
      .set(headers)
      .send({
        endpoint: "https://localhost/push",
        keys: { p256dh: "key1", auth: "auth1" },
      });
    expect(res.status).toBe(400);
  });

  it("rejects GCP metadata endpoint (SSRF guard)", async () => {
    const res = await request(app)
      .post("/push/subscribe")
      .set(headers)
      .send({
        endpoint: "https://169.254.169.254/computeMetadata/v1/",
        keys: { p256dh: "key1", auth: "auth1" },
      });
    expect(res.status).toBe(400);
  });

  it("rejects unknown push provider (allowlist enforcement)", async () => {
    const res = await request(app)
      .post("/push/subscribe")
      .set(headers)
      .send({
        endpoint: "https://malicious-push-server.example.com/push",
        keys: { p256dh: "key1", auth: "auth1" },
      });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("endpoint");
  });

  it("allows Mozilla autopush endpoint", async () => {
    const res = await request(app)
      .post("/push/subscribe")
      .set(headers)
      .send({
        endpoint: "https://updates.push.services.mozilla.com/wpush/v2/gAAAAAB123",
        keys: { p256dh: "p256dhKey", auth: "authKey" },
      });
    expect(res.status).toBe(200);
    expect(res.body.subscribed).toBe(true);
  });

  it("registers a valid subscription", async () => {
    const res = await request(app)
      .post("/push/subscribe")
      .set(headers)
      .send({
        endpoint: "https://fcm.googleapis.com/fcm/send/abc123",
        keys: { p256dh: "p256dhKey", auth: "authKey" },
      });
    expect(res.status).toBe(200);
    expect(res.body.subscribed).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("DELETE /push/subscribe", () => {
  it("removes a push subscription", async () => {
    pushStore._store.push({
      _id: "ps1", userId: "user_test123", guardianAccountId: ORG_ID,
      endpoint: "https://fcm.googleapis.com/fcm/send/xyz",
      keys: { p256dh: "k1", auth: "a1" },
    });

    const res = await request(app)
      .delete("/push/subscribe")
      .set(authHeader)
      .send({ endpoint: "https://fcm.googleapis.com/fcm/send/xyz" });
    expect(res.status).toBe(200);
    expect(res.body.unsubscribed).toBe(true);
  });
});
