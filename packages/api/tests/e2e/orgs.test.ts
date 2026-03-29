/**
 * Organizations API Tests
 *
 * Tests org CRUD, switching, tier enforcement, and IDOR protection.
 */

import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import request from "supertest";
import { createApp } from "../../src/app.js";
import type { Express } from "express";

// ─── Mocks (same pattern as team.test.ts) ─────────────────────────────────

const { mockStores, mockIdCounter, mockGetStore, mockMatchesQuery } = vi.hoisted(() => {
  const mockStores: Record<string, Map<string, any>> = {};
  const mockIdCounter = { v: 1 };
  function mockGetStore(name: string) { if (!mockStores[name]) mockStores[name] = new Map(); return mockStores[name]; }
  function mockMatchesQuery(doc: any, query: any): boolean {
    for (const [k, v] of Object.entries(query || {})) {
      if (v === null || v === undefined) continue;
      if (typeof v === "object" && "$gt" in v) { if (!(doc[k] > (v as any).$gt)) return false; continue; }
      if (typeof v === "object" && "$in" in v) { if (!(v as any).$in.includes(doc[k])) return false; continue; }
      if (typeof v === "object" && "$or" in v) continue;
      if (typeof v === "object" && "$ne" in v) { if (doc[k] === (v as any).$ne) return false; continue; }
      if (typeof v === "object" && "$exists" in v) { if ((v as any).$exists ? !(k in doc) : (k in doc)) return false; continue; }
      if (typeof v === "object") continue;
      if (doc[k] !== v) return false;
    }
    return true;
  }
  return { mockStores, mockIdCounter, mockGetStore, mockMatchesQuery };
});

function resetStores() { for (const key of Object.keys(mockStores)) mockStores[key].clear(); mockIdCounter.v = 1; }

vi.mock("mongoose", () => {
  function chainable<T>(fn: () => Promise<T>) { const p = { then: (r: any, e: any) => fn().then(r, e), lean: () => chainable(fn) }; return p; }
  const createMockModel = (name: string) => {
    const store = mockGetStore(name);
    return {
      create: vi.fn(async (data: any) => { const doc = { _id: `${name}-${mockIdCounter.v++}`, ...data, save: vi.fn() }; store.set(doc._id, doc); return doc; }),
      find: vi.fn((query: any) => chainable(async () => Array.from(store.values()).filter(d => mockMatchesQuery(d, query)))),
      findById: vi.fn((id: string) => chainable(async () => store.get(id) || null)),
      findOne: vi.fn((query: any) => chainable(async () => Array.from(store.values()).find(d => mockMatchesQuery(d, query)) || null)),
      findByIdAndUpdate: vi.fn((id: string, update: any) => {
        const fn = async () => { const doc = store.get(id); if (!doc) return null; if (update.$set) Object.assign(doc, update.$set); else if (update.$setOnInsert) { /* upsert */ } else Object.assign(doc, update); return doc; };
        return { then: (r: any, e: any) => fn().then(r, e), lean: () => ({ then: (r: any, e: any) => fn().then(r, e) }) };
      }),
      findByIdAndDelete: vi.fn(async (id: string) => { const doc = store.get(id); store.delete(id); return doc; }),
      findOneAndUpdate: vi.fn(async (query: any, update: any, opts?: any) => {
        let doc = Array.from(store.values()).find(d => mockMatchesQuery(d, query));
        if (!doc && opts?.upsert) { doc = { _id: `${name}-${mockIdCounter.v++}`, ...(update.$setOnInsert || update.$set || {}) }; store.set(doc._id, doc); }
        if (doc && update.$set) Object.assign(doc, update.$set);
        return doc;
      }),
      findOneAndDelete: vi.fn(async (query: any) => { const e = Array.from(store.entries()).find(([_, d]) => mockMatchesQuery(d, query)); if (!e) return null; store.delete(e[0]); return e[1]; }),
      countDocuments: vi.fn(async (query: any) => Array.from(store.values()).filter(d => mockMatchesQuery(d, query)).length),
      deleteMany: vi.fn(async (query: any) => { let c = 0; for (const [id, d] of store.entries()) { if (mockMatchesQuery(d, query)) { store.delete(id); c++; } } return { deletedCount: c }; }),
      updateMany: vi.fn(async (query: any, update: any) => { let c = 0; for (const d of store.values()) { if (mockMatchesQuery(d, query)) { if (update.$set) Object.assign(d, update.$set); c++; } } return { modifiedCount: c }; }),
      updateOne: vi.fn(async (query: any, update: any) => { const d = Array.from(store.values()).find(d => mockMatchesQuery(d, query)); if (d && update.$set) Object.assign(d, update.$set); return { modifiedCount: d ? 1 : 0 }; }),
    };
  };
  class MockSchema { static Types = { Mixed: "Mixed", ObjectId: "ObjectId" }; constructor() {} pre() { return this; } post() { return this; } index() { return this; } virtual() { return { get: () => {} }; } }
  return { default: { Schema: MockSchema, model: vi.fn((name: string) => createMockModel(name)), models: {}, connect: vi.fn(), connection: { db: null } }, Schema: MockSchema };
});

vi.mock("../../src/models/encrypted-credential/schema.js", () => ({
  EncryptedCredentialModel: {}, storeCredential: vi.fn(async () => "cred-123"), getCredential: vi.fn(async () => null),
  deleteCredential: vi.fn(async () => true), deleteAllCredentialsForAccount: vi.fn(async () => 0),
}));
vi.mock("../../src/models/api-key/schema.js", () => ({
  PersonalApiKeyModel: {}, createApiKey: vi.fn(), validateApiKey: vi.fn(), listApiKeys: vi.fn(async () => []),
  deleteApiKey: vi.fn(), deleteAllApiKeysForAccount: vi.fn(async () => 0),
}));
vi.mock("../../src/providers/index.js", () => ({
  getProvider: vi.fn(() => ({ id: "cloudflare", name: "Cloudflare", checkUsage: vi.fn(), executeKillSwitch: vi.fn(), validateCredential: vi.fn(async () => ({ valid: true })), getDefaultThresholds: vi.fn(() => ({})) })),
  getAllProviders: vi.fn(() => [{ id: "cloudflare", name: "Cloudflare", getDefaultThresholds: () => ({}) }]),
}));
vi.mock("../../src/globals/index.js", () => ({
  recordUsageSnapshot: vi.fn(), recordAlert: vi.fn(), getUsageHistory: vi.fn(async () => []),
  getAlertHistory: vi.fn(async () => []), getAnalyticsOverview: vi.fn(async () => ({ dailyCosts: [], totalSpendPeriod: 0, avgDailyCost: 0, projectedMonthlyCost: 0, savingsEstimate: 0, killSwitchActions: 0, accountBreakdown: [] })),
  getPostgresPool: vi.fn(() => { throw new Error("No PG"); }),
}));
vi.mock("jose", () => ({ createRemoteJWKSet: vi.fn(() => vi.fn()), jwtVerify: vi.fn(async () => ({ payload: { sub: "user_owner" } })) }));
vi.mock("stripe", () => ({ default: class { constructor() {} } }));
vi.mock("crypto", async () => { const actual = await vi.importActual("crypto"); return { ...actual as any, randomBytes: (n: number) => Buffer.alloc(n, "ab") }; });

let app: Express;
beforeAll(() => { process.env.NODE_ENV = "test"; process.env.ENVIRONMENT = "local"; process.env.GUARDIAN_DEV_AUTH_BYPASS = "true"; app = createApp(); });

function seedAccount(opts: { owner?: string; tier?: string; type?: string; slug?: string } = {}) {
  const id = `GuardianAccount-${mockIdCounter.v++}`;
  mockGetStore("GuardianAccount").set(id, {
    _id: id, ownerUserId: opts.owner || "owner-user", name: "Test Account",
    tier: opts.tier || "team", type: opts.type || "personal", slug: opts.slug || `slug-${id}`,
    alertChannels: [], onboardingCompleted: true,
    settings: { checkIntervalMinutes: 5, dailyReportEnabled: false },
    createdAt: Date.now(), updatedAt: Date.now(),
  });
  return id;
}

const auth = (accountId: string, userId: string = "owner-user", role: string = "owner") => ({
  "x-guardian-account-id": accountId, "x-guardian-user-id": userId, "x-guardian-role": role,
});

describe("Organizations API", () => {
  beforeEach(() => resetStores());

  describe("GET /orgs", () => {
    it("lists orgs the user owns", async () => {
      const id = seedAccount();
      const res = await request(app).get("/orgs").set(auth(id));
      expect(res.status).toBe(200);
      expect(res.body.orgs).toBeDefined();
    });
  });

  describe("POST /orgs", () => {
    it("creates a new organization for team-tier users", async () => {
      const personalId = seedAccount({ tier: "team", type: "personal" });
      const res = await request(app).post("/orgs").set(auth(personalId)).send({ name: "My Org" });
      expect(res.status).toBe(201);
      expect(res.body.name).toBe("My Org");
      expect(res.body.type).toBe("organization");
    });

    it("rejects org creation for free-tier users", async () => {
      const personalId = seedAccount({ tier: "free", type: "personal" });
      const res = await request(app).post("/orgs").set(auth(personalId)).send({ name: "My Org" });
      expect(res.status).toBe(403);
      expect(res.body.error).toContain("Team or Enterprise");
    });

    it("rejects org with short name", async () => {
      const personalId = seedAccount({ tier: "team", type: "personal" });
      const res = await request(app).post("/orgs").set(auth(personalId)).send({ name: "X" });
      expect(res.status).toBe(400);
    });
  });

  describe("PATCH /orgs/:orgId", () => {
    it("updates org name for owner", async () => {
      const id = seedAccount({ type: "organization" });
      const res = await request(app).patch(`/orgs/${id}`).set(auth(id)).send({ name: "New Name" });
      expect(res.status).toBe(200);
      expect(res.body.name).toBe("New Name");
    });

    it("rejects IDOR — cannot update different org", async () => {
      const myOrg = seedAccount({ owner: "user-a" });
      const otherOrg = seedAccount({ owner: "user-b" });
      const res = await request(app).patch(`/orgs/${otherOrg}`).set(auth(myOrg, "user-a"));
      expect(res.status).toBe(403);
      expect(res.body.error).toContain("currently in");
    });
  });

  describe("DELETE /orgs/:orgId", () => {
    it("deletes an organization", async () => {
      const id = seedAccount({ type: "organization" });
      const res = await request(app).delete(`/orgs/${id}`).set(auth(id));
      expect(res.status).toBe(200);
      expect(res.body.deleted).toBe(true);
    });

    it("cannot delete personal workspace", async () => {
      const id = seedAccount({ type: "personal" });
      const res = await request(app).delete(`/orgs/${id}`).set(auth(id));
      expect(res.status).toBe(400);
      expect(res.body.error).toContain("personal workspace");
    });

    it("rejects IDOR — cannot delete different org", async () => {
      const myOrg = seedAccount({ owner: "user-a" });
      const otherOrg = seedAccount({ owner: "user-b", type: "organization" });
      const res = await request(app).delete(`/orgs/${otherOrg}`).set(auth(myOrg, "user-a"));
      expect(res.status).toBe(403);
    });
  });

  describe("POST /orgs/:orgId/switch", () => {
    it("switches active org", async () => {
      const id = seedAccount();
      const res = await request(app).post(`/orgs/${id}/switch`).set(auth(id));
      expect(res.status).toBe(200);
      expect(res.body.switched).toBe(true);
    });
  });

  describe("GET /accounts/me", () => {
    it("returns orgs list and activeOrgId", async () => {
      const id = seedAccount();
      const res = await request(app).get("/accounts/me").set(auth(id));
      expect(res.status).toBe(200);
      expect(res.body.orgs).toBeDefined();
      expect(Array.isArray(res.body.orgs)).toBe(true);
      expect(res.body.teamRole).toBeDefined();
    });
  });
});
