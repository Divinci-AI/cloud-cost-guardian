/**
 * Activity Log API Tests
 *
 * Tests activity log querying, permission enforcement, and filtering.
 */

import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import request from "supertest";
import { createApp } from "../../src/app.js";
import type { Express } from "express";

// Mock everything needed for the app to start
vi.mock("mongoose", () => {
  const store = new Map();
  let idCounter = 1;
  const createMockModel = (name: string) => ({
    create: vi.fn(async (data: any) => { const doc = { _id: `${name}-${idCounter++}`, ...data }; store.set(doc._id, doc); return doc; }),
    find: vi.fn(async () => []),
    findById: vi.fn(async (id: string) => store.get(id) || null),
    findOne: vi.fn(async () => null),
    findByIdAndUpdate: vi.fn(async (id: string, update: any) => { const doc = store.get(id); if (doc && update.$set) Object.assign(doc, update.$set); return doc; }),
    findByIdAndDelete: vi.fn(async (id: string) => { const doc = store.get(id); store.delete(id); return doc; }),
    findOneAndUpdate: vi.fn(async (_q: any, update: any, opts?: any) => {
      if (opts?.upsert) { const doc = { _id: `mock-${idCounter++}`, ...(update.$setOnInsert || update.$set || {}) }; store.set(doc._id, doc); return doc; }
      return null;
    }),
    countDocuments: vi.fn(async () => 0),
    deleteMany: vi.fn(async () => ({ deletedCount: 0 })),
    updateMany: vi.fn(async () => ({ modifiedCount: 0 })),
    updateOne: vi.fn(async () => ({ modifiedCount: 0 })),
  });
  class MockSchema { static Types = { Mixed: "Mixed", ObjectId: "ObjectId" }; constructor() {} pre() { return this; } post() { return this; } index() { return this; } virtual() { return { get: () => {} }; } }
  return { default: { Schema: MockSchema, model: vi.fn((name: string) => createMockModel(name)), models: {}, connect: vi.fn(), connection: { db: null } }, Schema: MockSchema };
});

vi.mock("../../src/models/encrypted-credential/schema.js", () => ({
  EncryptedCredentialModel: {}, storeCredential: vi.fn(), getCredential: vi.fn(), deleteCredential: vi.fn(),
  deleteAllCredentialsForAccount: vi.fn(async () => 0),
}));
vi.mock("../../src/models/api-key/schema.js", () => ({
  PersonalApiKeyModel: {}, createApiKey: vi.fn(), validateApiKey: vi.fn(), listApiKeys: vi.fn(async () => []),
  deleteApiKey: vi.fn(), deleteAllApiKeysForAccount: vi.fn(async () => 0),
}));
vi.mock("../../src/providers/index.js", () => ({
  getProvider: vi.fn(() => ({ id: "cloudflare", name: "Cloudflare", checkUsage: vi.fn(), executeKillSwitch: vi.fn(), validateCredential: vi.fn(async () => ({ valid: true })), getDefaultThresholds: vi.fn(() => ({})) })),
  getAllProviders: vi.fn(() => [{ id: "cloudflare", name: "Cloudflare", getDefaultThresholds: () => ({}) }]),
}));

const mockPgQuery = vi.fn();
vi.mock("../../src/globals/index.js", () => ({
  recordUsageSnapshot: vi.fn(), recordAlert: vi.fn(), getUsageHistory: vi.fn(async () => []),
  getAlertHistory: vi.fn(async () => []),
  getAnalyticsOverview: vi.fn(async () => ({ dailyCosts: [], totalSpendPeriod: 0, avgDailyCost: 0, projectedMonthlyCost: 0, savingsEstimate: 0, killSwitchActions: 0, accountBreakdown: [] })),
  getPostgresPool: vi.fn(() => ({ query: mockPgQuery })),
}));
vi.mock("jose", () => ({ createRemoteJWKSet: vi.fn(() => vi.fn()), jwtVerify: vi.fn(async () => ({ payload: { sub: "user_owner" } })) }));
vi.mock("stripe", () => ({ default: class { constructor() {} } }));

let app: Express;

beforeAll(() => {
  process.env.NODE_ENV = "test";
  process.env.ENVIRONMENT = "local";
  process.env.GUARDIAN_DEV_AUTH_BYPASS = "true";
  app = createApp();
});

const auth = (accountId: string, userId: string = "owner-user", role: string = "owner") => ({
  "x-guardian-account-id": accountId,
  "x-guardian-user-id": userId,
  "x-guardian-role": role,
});

describe("Activity Log API", () => {
  beforeEach(() => {
    mockPgQuery.mockReset();
  });

  describe("GET /activity", () => {
    it("returns paginated activity log for owner", async () => {
      mockPgQuery
        .mockResolvedValueOnce({ rows: [{ count: "2" }] })  // COUNT query
        .mockResolvedValueOnce({ rows: [                     // SELECT query
          { id: 1, org_id: "test", actor_user_id: "user-1", action: "cloud_account.create", resource_type: "cloud_account", created_at: new Date() },
          { id: 2, org_id: "test", actor_user_id: "user-1", action: "rule.create", resource_type: "rule", created_at: new Date() },
        ]});

      const res = await request(app)
        .get("/activity")
        .set(auth("test-account"));

      expect(res.status).toBe(200);
      expect(res.body.entries).toHaveLength(2);
      expect(res.body.total).toBe(2);
      expect(res.body.page).toBe(1);
      expect(res.body.limit).toBe(50);
    });

    it("supports pagination", async () => {
      mockPgQuery
        .mockResolvedValueOnce({ rows: [{ count: "100" }] })
        .mockResolvedValueOnce({ rows: [] });

      const res = await request(app)
        .get("/activity?page=3&limit=10")
        .set(auth("test-account"));

      expect(res.status).toBe(200);
      expect(res.body.page).toBe(3);
      expect(res.body.limit).toBe(10);
    });

    it("supports action filter", async () => {
      mockPgQuery
        .mockResolvedValueOnce({ rows: [{ count: "1" }] })
        .mockResolvedValueOnce({ rows: [{ id: 1, action: "cloud_account.create" }] });

      const res = await request(app)
        .get("/activity?action=cloud_account")
        .set(auth("test-account"));

      expect(res.status).toBe(200);
      // Verify the LIKE query was used
      const countCall = mockPgQuery.mock.calls[0];
      expect(countCall[0]).toContain("LIKE");
      expect(countCall[1]).toContain("cloud_account%");
    });

    it("denies access for viewer role", async () => {
      const res = await request(app)
        .get("/activity")
        .set(auth("test-account", "viewer-user", "viewer"));

      expect(res.status).toBe(403);
    });

    it("denies access for member role", async () => {
      const res = await request(app)
        .get("/activity")
        .set(auth("test-account", "member-user", "member"));

      expect(res.status).toBe(403);
    });

    it("allows access for admin role", async () => {
      mockPgQuery
        .mockResolvedValueOnce({ rows: [{ count: "0" }] })
        .mockResolvedValueOnce({ rows: [] });

      const res = await request(app)
        .get("/activity")
        .set(auth("test-account", "admin-user", "admin"));

      expect(res.status).toBe(200);
    });
  });
});
