/**
 * Team API Tests
 *
 * Tests team invitation, acceptance, role management, and tier enforcement.
 */

import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import request from "supertest";
import { createApp } from "../../src/app.js";
import type { Express } from "express";

// ─── Mocks ────────────────────────────────────────────────────────────────────

const { mockStores, mockIdCounter, mockGetStore, mockMatchesQuery } = vi.hoisted(() => {
  const mockStores: Record<string, Map<string, any>> = {};
  const mockIdCounter = { v: 1 };

  function mockGetStore(name: string) {
    if (!mockStores[name]) mockStores[name] = new Map();
    return mockStores[name];
  }

  function mockMatchesQuery(doc: any, query: any): boolean {
    for (const [k, v] of Object.entries(query || {})) {
      if (v === null || v === undefined) continue;
      if (typeof v === "object" && "$gt" in v) {
        if (!(doc[k] > (v as any).$gt)) return false;
        continue;
      }
      if (typeof v === "object") continue;
      if (doc[k] !== v) return false;
    }
    return true;
  }

  return { mockStores, mockIdCounter, mockGetStore, mockMatchesQuery };
});

function resetStores() {
  for (const key of Object.keys(mockStores)) mockStores[key].clear();
  mockIdCounter.v = 1;
}

vi.mock("mongoose", () => {
  // Helper: make a promise-like object that also has .lean() for Mongoose compat
  function chainable<T>(fn: () => Promise<T>) {
    const p = { then: (r: any, e: any) => fn().then(r, e), lean: () => chainable(fn) };
    return p;
  }

  const createMockModel = (name: string) => {
    const store = mockGetStore(name);
    const model: any = {
      create: vi.fn(async (data: any) => {
        const doc = { _id: `${name}-${mockIdCounter.v++}`, ...data, save: vi.fn() };
        store.set(doc._id, doc);
        return doc;
      }),
      find: vi.fn((query: any) => {
        return chainable(async () => Array.from(store.values()).filter(d => mockMatchesQuery(d, query)));
      }),
      findById: vi.fn((id: string) => {
        return chainable(async () => store.get(id) || null);
      }),
      findOne: vi.fn((query: any) => {
        return chainable(async () => Array.from(store.values()).find(d => mockMatchesQuery(d, query)) || null);
      }),
      findByIdAndUpdate: vi.fn(async (id: string, update: any, _opts?: any) => {
        const doc = store.get(id);
        if (!doc) return null;
        if (update.$set) Object.assign(doc, update.$set);
        else Object.assign(doc, update);
        return doc;
      }),
      findByIdAndDelete: vi.fn(async (id: string) => {
        const doc = store.get(id);
        store.delete(id);
        return doc;
      }),
      findOneAndUpdate: vi.fn(async (query: any, update: any, _opts?: any) => {
        const doc = Array.from(store.values()).find(d => mockMatchesQuery(d, query));
        if (!doc) return null;
        if (update.$set) Object.assign(doc, update.$set);
        else Object.assign(doc, update);
        return doc;
      }),
      findOneAndDelete: vi.fn(async (query: any) => {
        const entry = Array.from(store.entries()).find(([_, d]) => mockMatchesQuery(d, query));
        if (!entry) return null;
        store.delete(entry[0]);
        return entry[1];
      }),
      countDocuments: vi.fn(async (query: any) => {
        return Array.from(store.values()).filter(d => mockMatchesQuery(d, query)).length;
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
  storeCredential: vi.fn(async () => "cred-123"),
  getCredential: vi.fn(async () => ({ provider: "cloudflare", apiToken: "tok", accountId: "acc" })),
  deleteCredential: vi.fn(async () => true),
}));

vi.mock("../../src/providers/index.js", () => ({
  getProvider: vi.fn(() => ({
    id: "cloudflare", name: "Cloudflare",
    checkUsage: vi.fn(async () => ({ provider: "cloudflare", accountId: "test", checkedAt: Date.now(), services: [], totalEstimatedDailyCostUSD: 0, violations: [], securityEvents: [] })),
    executeKillSwitch: vi.fn(async () => ({ success: true })),
    validateCredential: vi.fn(async () => ({ valid: true })),
    getDefaultThresholds: vi.fn(() => ({})),
  })),
  getAllProviders: vi.fn(() => [
    { id: "cloudflare", name: "Cloudflare", getDefaultThresholds: () => ({}) },
  ]),
}));

vi.mock("../../src/globals/index.js", () => ({
  recordUsageSnapshot: vi.fn(),
  recordAlert: vi.fn(),
  getUsageHistory: vi.fn(async () => []),
  getAlertHistory: vi.fn(async () => []),
  getAnalyticsOverview: vi.fn(async () => ({ dailyCosts: [], totalSpendPeriod: 0, avgDailyCost: 0, projectedMonthlyCost: 0, savingsEstimate: 0, killSwitchActions: 0, accountBreakdown: [] })),
}));

vi.mock("jose", () => ({
  createRemoteJWKSet: vi.fn(() => vi.fn()),
  jwtVerify: vi.fn(async () => ({
    payload: { sub: "auth0|owner-user", email: "owner@test.com" },
  })),
}));

vi.mock("stripe", () => ({ default: class { constructor() {} } }));

let app: Express;

beforeAll(() => {
  process.env.NODE_ENV = "test";
  process.env.ENVIRONMENT = "local";
  process.env.GUARDIAN_DEV_AUTH_BYPASS = "true";
  app = createApp();
});

// Helper: create a team-tier account in the GuardianAccount store
function seedTeamAccount(tier: string = "team") {
  const id = `GuardianAccount-${mockIdCounter.v++}`;
  mockGetStore("GuardianAccount").set(id, {
    _id: id,
    ownerUserId: "owner-user",
    name: "owner@test.com",
    tier,
    alertChannels: [],
    onboardingCompleted: true,
    settings: { checkIntervalMinutes: 5, dailyReportEnabled: false },
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });
  return id;
}

function seedTeamMember(accountId: string, userId: string, email: string, role: string = "member") {
  const id = `TeamMember-${mockIdCounter.v++}`;
  mockGetStore("TeamMember").set(id, {
    _id: id,
    guardianAccountId: accountId,
    userId,
    email,
    role,
    invitedBy: "owner-user",
    joinedAt: Date.now(),
  });
  return id;
}

const auth = (accountId: string, userId: string = "owner-user") => ({
  "x-guardian-account-id": accountId,
  "x-guardian-user-id": userId,
});

describe("Team API", () => {
  beforeEach(() => resetStores());

  describe("Tier enforcement", () => {
    it("rejects team routes for free tier", async () => {
      const id = seedTeamAccount("free");
      const res = await request(app).get("/team/members").set(auth(id));
      expect(res.status).toBe(403);
      expect(res.body.error).toMatch(/Team or Enterprise/);
      expect(res.body.upgradeUrl).toBe("/billing?plan=team");
    });

    it("allows team routes for team tier", async () => {
      const id = seedTeamAccount("team");
      const res = await request(app).get("/team/members").set(auth(id));
      expect(res.status).toBe(200);
      expect(res.body.members).toBeDefined();
    });

    it("allows team routes for enterprise tier", async () => {
      const id = seedTeamAccount("enterprise");
      const res = await request(app).get("/team/members").set(auth(id));
      expect(res.status).toBe(200);
    });
  });

  describe("GET /team/members", () => {
    it("returns owner as first member", async () => {
      const id = seedTeamAccount();
      const res = await request(app).get("/team/members").set(auth(id));
      expect(res.status).toBe(200);
      expect(res.body.members[0].isOwner).toBe(true);
      expect(res.body.members[0].role).toBe("owner");
      expect(res.body.members[0].email).toBe("owner@test.com");
    });

    it("includes team members after owner", async () => {
      const id = seedTeamAccount();
      seedTeamMember(id, "dev-1", "dev@test.com", "member");
      seedTeamMember(id, "admin-1", "admin@test.com", "admin");
      const res = await request(app).get("/team/members").set(auth(id));
      expect(res.body.members).toHaveLength(3);
      expect(res.body.members[1].email).toBe("dev@test.com");
      expect(res.body.members[2].email).toBe("admin@test.com");
    });

    it("returns empty invitations when none exist", async () => {
      const id = seedTeamAccount();
      const res = await request(app).get("/team/members").set(auth(id));
      expect(res.body.invitations).toEqual([]);
    });
  });

  describe("POST /team/invite", () => {
    it("creates an invitation with token", async () => {
      const id = seedTeamAccount();
      const res = await request(app)
        .post("/team/invite").set(auth(id))
        .send({ email: "new@test.com", role: "member" });
      expect(res.status).toBe(201);
      expect(res.body.invitation.email).toBe("new@test.com");
      expect(res.body.invitation.role).toBe("member");
      expect(res.body.invitation.token).toBeDefined();
      expect(res.body.invitation.token.length).toBeGreaterThan(30);
      expect(res.body.acceptUrl).toContain(res.body.invitation.token);
    });

    it("defaults role to member when not specified", async () => {
      const id = seedTeamAccount();
      const res = await request(app)
        .post("/team/invite").set(auth(id))
        .send({ email: "new@test.com" });
      expect(res.status).toBe(201);
      expect(res.body.invitation.role).toBe("member");
    });

    it("rejects missing email", async () => {
      const id = seedTeamAccount();
      const res = await request(app)
        .post("/team/invite").set(auth(id))
        .send({ role: "member" });
      expect(res.status).toBe(400);
    });

    it("rejects owner role in invite", async () => {
      const id = seedTeamAccount();
      const res = await request(app)
        .post("/team/invite").set(auth(id))
        .send({ email: "hacker@test.com", role: "owner" });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/Invalid role/);
    });

    it("rejects duplicate member invitation", async () => {
      const id = seedTeamAccount();
      seedTeamMember(id, "existing", "existing@test.com");
      const res = await request(app)
        .post("/team/invite").set(auth(id))
        .send({ email: "existing@test.com", role: "viewer" });
      expect(res.status).toBe(409);
      expect(res.body.error).toMatch(/already a team member/);
    });
  });

  describe("POST /team/invite/accept", () => {
    it("accepts a valid invitation and creates membership", async () => {
      const accountId = seedTeamAccount();
      // Create invitation
      const inviteRes = await request(app)
        .post("/team/invite").set(auth(accountId))
        .send({ email: "joiner@test.com", role: "member" });
      const token = inviteRes.body.invitation.token;

      // Accept as a different user
      const acceptRes = await request(app)
        .post("/team/invite/accept").set(auth(accountId, "joiner-user"))
        .send({ token });
      expect(acceptRes.status).toBe(200);
      expect(acceptRes.body.joined).toBe(true);
      expect(acceptRes.body.member.role).toBe("member");
      expect(acceptRes.body.member.email).toBe("joiner@test.com");
    });

    it("rejects missing token", async () => {
      const id = seedTeamAccount();
      const res = await request(app)
        .post("/team/invite/accept").set(auth(id))
        .send({});
      expect(res.status).toBe(400);
    });

    it("rejects bogus token", async () => {
      const id = seedTeamAccount();
      const res = await request(app)
        .post("/team/invite/accept").set(auth(id))
        .send({ token: "bogus-token-abc" });
      expect(res.status).toBe(404);
    });
  });

  describe("PATCH /team/members/:memberId", () => {
    it("updates a member role", async () => {
      const accountId = seedTeamAccount();
      const memberId = seedTeamMember(accountId, "dev-1", "dev@test.com", "member");
      const res = await request(app)
        .patch(`/team/members/${memberId}`).set(auth(accountId))
        .send({ role: "admin" });
      expect(res.status).toBe(200);
      expect(res.body.updated).toBe(true);
      expect(res.body.member.role).toBe("admin");
    });

    it("rejects invalid role", async () => {
      const accountId = seedTeamAccount();
      const memberId = seedTeamMember(accountId, "dev-1", "dev@test.com");
      const res = await request(app)
        .patch(`/team/members/${memberId}`).set(auth(accountId))
        .send({ role: "superadmin" });
      expect(res.status).toBe(400);
    });

    it("returns 404 for non-existent member", async () => {
      const accountId = seedTeamAccount();
      const res = await request(app)
        .patch("/team/members/nonexistent").set(auth(accountId))
        .send({ role: "admin" });
      expect(res.status).toBe(404);
    });
  });

  describe("DELETE /team/members/:memberId", () => {
    it("removes a team member", async () => {
      const accountId = seedTeamAccount();
      const memberId = seedTeamMember(accountId, "dev-2", "dev2@test.com", "viewer");
      const res = await request(app)
        .delete(`/team/members/${memberId}`).set(auth(accountId));
      expect(res.status).toBe(200);
      expect(res.body.removed).toBe(true);
      expect(res.body.email).toBe("dev2@test.com");
    });

    it("returns 404 for non-existent member", async () => {
      const accountId = seedTeamAccount();
      const res = await request(app)
        .delete("/team/members/nonexistent").set(auth(accountId));
      expect(res.status).toBe(404);
    });
  });

  describe("DELETE /team/invitations/:invitationId", () => {
    it("revokes a pending invitation", async () => {
      const accountId = seedTeamAccount();
      const inviteRes = await request(app)
        .post("/team/invite").set(auth(accountId))
        .send({ email: "revoke-me@test.com", role: "viewer" });
      const invitationId = inviteRes.body.invitation.id;

      const res = await request(app)
        .delete(`/team/invitations/${invitationId}`).set(auth(accountId));
      expect(res.status).toBe(200);
      expect(res.body.revoked).toBe(true);
      expect(res.body.email).toBe("revoke-me@test.com");
    });

    it("returns 404 for non-existent invitation", async () => {
      const accountId = seedTeamAccount();
      const res = await request(app)
        .delete("/team/invitations/nonexistent").set(auth(accountId));
      expect(res.status).toBe(404);
    });
  });
});
