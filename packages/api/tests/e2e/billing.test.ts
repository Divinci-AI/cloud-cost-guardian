/**
 * Billing E2E Tests
 *
 * Tests the full billing flow: plans, checkout, portal, webhooks,
 * tier enforcement, and subscription lifecycle.
 */

import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import request from "supertest";
import { createApp } from "../../src/app.js";
import type { Express } from "express";

// Set env vars via vi.hoisted so they're set BEFORE module loading
vi.hoisted(() => {
  process.env.NODE_ENV = "test";
  process.env.ENVIRONMENT = "local";
  process.env.GUARDIAN_DEV_AUTH_BYPASS = "true";
  process.env.CLERK_ISSUER = "https://test.clerk.accounts.dev";
  process.env.STRIPE_API_SECRET_KEY = "sk_test_fake";
  process.env.STRIPE_WEBHOOK_SECRET_GUARDIAN = "whsec_test_fake";
});

// ─── Shared mock state ─────────────────────────────────────────────────────

const { mockStores, mockIdCounter, mockGetStore } = vi.hoisted(() => {
  const mockStores: Record<string, Map<string, any>> = {};
  const mockIdCounter = { v: 1 };
  function mockGetStore(name: string) {
    if (!mockStores[name]) mockStores[name] = new Map();
    return mockStores[name];
  }
  return { mockStores, mockIdCounter, mockGetStore };
});

function resetStores() {
  for (const key of Object.keys(mockStores)) mockStores[key].clear();
  mockIdCounter.v = 1;
}

// ─── Mongoose mock with .lean() support ────────────────────────────────────

vi.mock("mongoose", () => {
  function chainable<T>(fn: () => Promise<T>) {
    const p: any = { then: (r: any, e: any) => fn().then(r, e), lean: () => chainable(fn) };
    return p;
  }

  class MockSchema {
    static Types = { Mixed: "Mixed", ObjectId: "ObjectId" };
    constructor() {}
    pre() { return this; }
    post() { return this; }
    index() { return this; }
    virtual() { return { get: () => {} }; }
  }

  const createMockModel = (name: string) => {
    const store = mockGetStore(name);
    const model: any = {
      create: vi.fn(async (data: any) => {
        const doc = {
          _id: `${name}-${mockIdCounter.v++}`,
          ...data,
          settings: data.settings || { checkIntervalMinutes: 360 },
          save: vi.fn(async function(this: any) { store.set(this._id, this); return this; }),
        };
        store.set(doc._id, doc);
        return doc;
      }),
      find: vi.fn((query: any) => {
        return chainable(async () => {
          return Array.from(store.values()).filter(d => {
            for (const [k, v] of Object.entries(query || {})) {
              if (v && typeof v === "object" && "$in" in v) {
                if (!(v as any).$in.includes(d[k])) return false;
                continue;
              }
              if (v === null || v === undefined) continue;
              if (typeof v === "object") continue;
              if (d[k] !== v) return false;
            }
            return true;
          });
        });
      }),
      findById: vi.fn((id: string) => {
        return chainable(async () => store.get(id) || null);
      }),
      findOne: vi.fn((query: any) => {
        return chainable(async () => {
          return Array.from(store.values()).find(d => {
            for (const [k, v] of Object.entries(query || {})) {
              if (v === null || v === undefined) continue;
              if (typeof v === "object") continue;
              if (d[k] !== v) return false;
            }
            return true;
          }) || null;
        });
      }),
      findByIdAndUpdate: vi.fn((id: string, update: any, _opts?: any) => {
        return chainable(async () => {
          const doc = store.get(id);
          if (!doc) return null;
          const flat = update.$set || update;
          for (const [k, v] of Object.entries(flat)) {
            if (k.includes(".")) {
              const parts = k.split(".");
              let obj = doc;
              for (let i = 0; i < parts.length - 1; i++) {
                obj[parts[i]] = obj[parts[i]] || {};
                obj = obj[parts[i]];
              }
              obj[parts[parts.length - 1]] = v;
            } else {
              doc[k] = v;
            }
          }
          return doc;
        });
      }),
      findByIdAndDelete: vi.fn(async (id: string) => {
        const doc = store.get(id);
        store.delete(id);
        return doc;
      }),
      countDocuments: vi.fn(async (query: any) => {
        return Array.from(store.values()).filter(d => {
          for (const [k, v] of Object.entries(query || {})) {
            if (v === null || v === undefined) continue;
            if (typeof v === "object") continue;
            if (d[k] !== v) return false;
          }
          return true;
        }).length;
      }),
    };
    return model;
  };

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

// ─── Mock Stripe with full checkout/portal/webhook support ─────────────────

const { mockStripeInstance } = vi.hoisted(() => {
  const mockStripeInstance = {
    customers: {
      create: vi.fn(async (data: any) => ({ id: "cus_test_new", ...data })),
    },
    checkout: {
      sessions: {
        create: vi.fn(async (params: any) => ({
          id: "cs_test_session_123",
          url: "https://checkout.stripe.com/test",
          customer: params.customer,
          metadata: params.metadata || {},
        })),
      },
    },
    billingPortal: {
      sessions: {
        create: vi.fn(async () => ({
          id: "bps_test_123",
          url: "https://billing.stripe.com/portal/test",
        })),
      },
    },
    subscriptions: {
      retrieve: vi.fn(async () => ({
        id: "sub_test_123",
        status: "active",
        current_period_end: Math.floor(Date.now() / 1000) + 86400 * 30,
        cancel_at_period_end: false,
      })),
    },
    webhooks: {
      constructEvent: vi.fn((body: any, _sig: string, _secret: string) => {
        const parsed = typeof body === "string" ? JSON.parse(body) : JSON.parse(body.toString());
        return parsed;
      }),
    },
  };
  return { mockStripeInstance };
});

vi.mock("stripe", () => {
  return {
    default: class {
      constructor() {
        return mockStripeInstance;
      }
    },
  };
});

// ─── Other mocks ───────────────────────────────────────────────────────────

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
      services: [], totalEstimatedDailyCostUSD: 0, violations: [], securityEvents: [],
    })),
    executeKillSwitch: vi.fn(async () => ({ success: true })),
    validateCredential: vi.fn(async () => ({ valid: true, accountId: "acc-123", accountName: "Test" })),
    getDefaultThresholds: vi.fn(() => ({})),
  })),
  getAllProviders: vi.fn(() => [
    { id: "cloudflare", name: "Cloudflare", getDefaultThresholds: () => ({}) },
    { id: "gcp", name: "GCP", getDefaultThresholds: () => ({}) },
    { id: "aws", name: "AWS", getDefaultThresholds: () => ({}) },
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
    projectedMonthlyCost: 0, savingsEstimate: 0, killSwitchActions: 0,
    accountBreakdown: [],
  })),
}));

vi.mock("jose", () => ({
  createRemoteJWKSet: vi.fn(() => vi.fn()),
  jwtVerify: vi.fn(async () => ({
    payload: { sub: "user_billing_test", email: "billing@example.com" },
  })),
}));

vi.mock("../../src/middleware/permissions.js", () => ({
  requirePermission: () => (_req: any, _res: any, next: any) => next(),
}));

vi.mock("../../src/services/activity-logger.js", () => ({
  logActivity: vi.fn(),
}));

vi.mock("../../src/models/api-key/schema.js", () => ({
  createApiKey: vi.fn(async () => ({ key: "ks_live_test", id: "key-1" })),
  listApiKeys: vi.fn(async () => []),
  deleteApiKey: vi.fn(async () => true),
  validateApiKey: vi.fn(async () => null),
  PersonalApiKeyModel: {},
  deleteAllApiKeysForAccount: vi.fn(async () => 0),
}));

let app: Express;
const AUTH_HEADERS = {
  "X-Guardian-Account-Id": "billing-acct",
  "X-Guardian-User-Id": "billing-user",
};

beforeAll(() => {
  app = createApp();
});

beforeEach(() => {
  resetStores();
  vi.clearAllMocks();

  // Seed a test account in GuardianAccount store (matches mongoose.model("GuardianAccount"))
  const store = mockGetStore("GuardianAccount");
  store.set("billing-acct", {
    _id: "billing-acct",
    ownerUserId: "billing-user",
    type: "personal", // mongoose hydration applies this schema default in production
    tier: "free",
    stripeCustomerId: null,
    stripeSubscriptionId: null,
    onboardingCompleted: false,
    settings: { checkIntervalMinutes: 360 },
    save: vi.fn(async function(this: any) { store.set(this._id, this); return this; }),
  });
});

// ─── Tests ─────────────────────────────────────────────────────────────────

describe("Billing: Plans", () => {
  it("GET /billing/plans returns Free + 3 paid tiers (Free first)", async () => {
    const res = await request(app).get("/billing/plans");
    expect(res.status).toBe(200);
    expect(res.body.plans).toHaveLength(4);

    const tiers = res.body.plans.map((p: any) => p.tier);
    expect(tiers).toEqual(["free", "pro", "team", "enterprise"]);

    const byTier = Object.fromEntries(res.body.plans.map((p: any) => [p.tier, p]));
    expect(byTier.free.monthlyPrice).toBe(0);
    expect(byTier.pro.monthlyPrice).toBe(29);
    expect(byTier.pro.annualPrice).toBe(290);
    expect(byTier.team.monthlyPrice).toBe(99);
    expect(byTier.team.annualPrice).toBe(990);
    expect(byTier.enterprise.contactUs).toBe(true);
  });

  it("GET /billing/plans is public (no auth required)", async () => {
    const res = await request(app).get("/billing/plans");
    expect(res.status).toBe(200);
  });

  it("paid tiers include Stripe price IDs", async () => {
    const res = await request(app).get("/billing/plans");
    const pro = res.body.plans.find((p: any) => p.tier === "pro");
    expect(pro.priceIds).toBeDefined();
    expect(pro.priceIds.monthly).toBeTruthy();
    expect(pro.priceIds.annual).toBeTruthy();

    const team = res.body.plans.find((p: any) => p.tier === "team");
    expect(team.priceIds).toBeDefined();

    // Free tier is listed for visibility, but has no Stripe price IDs (no self-serve checkout).
    const free = res.body.plans.find((p: any) => p.tier === "free");
    expect(free).toBeDefined();
    expect(free.priceIds).toBeUndefined();
  });

  it("pro tier has correct limits", async () => {
    const res = await request(app).get("/billing/plans");
    const pro = res.body.plans.find((p: any) => p.tier === "pro");
    expect(pro.limits.cloudAccounts).toBe(3);
    expect(pro.limits.checkIntervalMinutes).toBe(5);
    expect(pro.limits.alertChannels).toBe(10);
  });
});

describe("Billing: Status", () => {
  it("GET /billing/status returns tier and limits", async () => {
    const res = await request(app)
      .get("/billing/status")
      .set(AUTH_HEADERS);
    expect(res.status).toBe(200);
    expect(res.body.tier).toBe("free");
    expect(res.body.limits.cloudAccounts).toBe(1);
    expect(res.body.subscription).toBeNull();
  });

  it("GET /billing/status returns subscription info for paying user", async () => {
    const store = mockGetStore("GuardianAccount");
    const account = store.get("billing-acct")!;
    account.tier = "pro";
    account.stripeCustomerId = "cus_test_123";
    account.stripeSubscriptionId = "sub_test_123";

    const res = await request(app)
      .get("/billing/status")
      .set(AUTH_HEADERS);
    expect(res.status).toBe(200);
    expect(res.body.tier).toBe("pro");
    expect(res.body.subscription).toBeDefined();
    expect(res.body.subscription.id).toBe("sub_test_123");
    expect(res.body.subscription.status).toBe("active");
  });

  it("GET /billing/status does not leak stripeCustomerId", async () => {
    const store = mockGetStore("GuardianAccount");
    store.get("billing-acct")!.stripeCustomerId = "cus_secret_123";

    const res = await request(app)
      .get("/billing/status")
      .set(AUTH_HEADERS);
    expect(res.status).toBe(200);
    expect(res.body.stripeCustomerId).toBeUndefined();
  });

  it("GET /billing/status requires authentication", async () => {
    const res = await request(app).get("/billing/status");
    expect(res.status).toBe(401);
  });
});

describe("Billing: Status self-heal (stale paid tier w/o live subscription)", () => {
  it("heals a paid tier with NO subscription id down to free", async () => {
    const store = mockGetStore("GuardianAccount");
    const account = store.get("billing-acct")!;
    account.tier = "team";
    account.stripeSubscriptionId = null; // tier set out-of-band; no Stripe sub backs it

    const res = await request(app).get("/billing/status").set(AUTH_HEADERS);
    expect(res.status).toBe(200);
    expect(res.body.tier).toBe("free");
    expect(res.body.limits.cloudAccounts).toBe(1);
    expect(res.body.subscription).toBeNull();
    // Persisted, not just masked in the response.
    expect(store.get("billing-acct")!.tier).toBe("free");
  });

  it("heals a paid tier whose subscription is canceled down to free", async () => {
    const store = mockGetStore("GuardianAccount");
    const account = store.get("billing-acct")!;
    account.tier = "pro";
    account.stripeSubscriptionId = "sub_dead_123";
    mockStripeInstance.subscriptions.retrieve.mockResolvedValueOnce({
      id: "sub_dead_123",
      status: "canceled",
      cancel_at_period_end: false,
    } as any);

    const res = await request(app).get("/billing/status").set(AUTH_HEADERS);
    expect(res.status).toBe(200);
    expect(res.body.tier).toBe("free");
    expect(store.get("billing-acct")!.tier).toBe("free");
  });

  it("does NOT downgrade on a transient Stripe error (keeps the paid tier)", async () => {
    const store = mockGetStore("GuardianAccount");
    const account = store.get("billing-acct")!;
    account.tier = "pro";
    account.stripeSubscriptionId = "sub_live_but_flaky";
    mockStripeInstance.subscriptions.retrieve.mockRejectedValueOnce(new Error("ETIMEDOUT"));

    const res = await request(app).get("/billing/status").set(AUTH_HEADERS);
    expect(res.status).toBe(200);
    expect(res.body.tier).toBe("pro"); // not stripped on a blip
    expect(store.get("billing-acct")!.tier).toBe("pro");
  });

  it("does NOT touch a sales-led enterprise tier without a subscription", async () => {
    const store = mockGetStore("GuardianAccount");
    const account = store.get("billing-acct")!;
    account.tier = "enterprise";
    account.stripeSubscriptionId = null;

    const res = await request(app).get("/billing/status").set(AUTH_HEADERS);
    expect(res.status).toBe(200);
    expect(res.body.tier).toBe("enterprise");
    expect(store.get("billing-acct")!.tier).toBe("enterprise");
  });
});

describe("Billing: Status self-heal for organizations (owner-backed tier)", () => {
  // Orgs carry no subscription of their own — their tier is backed by the
  // OWNER's personal subscription (commit 2e1bb29).
  const seedOrg = (opts: { orgTier: string; ownerSubId: string | null; ownerTier?: string }) => {
    const store = mockGetStore("GuardianAccount");
    const org = store.get("billing-acct")!;
    org.type = "organization";
    org.tier = opts.orgTier;
    org.stripeSubscriptionId = null;
    store.set("owner-personal-acct", {
      _id: "owner-personal-acct",
      ownerUserId: "billing-user",
      type: "personal",
      tier: opts.ownerTier ?? "team",
      stripeCustomerId: "cus_owner_1",
      stripeSubscriptionId: opts.ownerSubId,
      settings: { checkIntervalMinutes: 5 },
      save: vi.fn(async function (this: any) { store.set(this._id, this); return this; }),
    });
    return store;
  };

  it("keeps an org's paid tier while the owner has a live covering subscription", async () => {
    const store = seedOrg({ orgTier: "team", ownerSubId: "sub_owner_live", ownerTier: "team" });

    const res = await request(app).get("/billing/status").set(AUTH_HEADERS);
    expect(res.status).toBe(200);
    expect(res.body.tier).toBe("team");
    expect(store.get("billing-acct")!.tier).toBe("team");
  });

  it("heals an org's paid tier to free when the owner has no subscription", async () => {
    const store = seedOrg({ orgTier: "team", ownerSubId: null });

    const res = await request(app).get("/billing/status").set(AUTH_HEADERS);
    expect(res.status).toBe(200);
    expect(res.body.tier).toBe("free");
    expect(store.get("billing-acct")!.tier).toBe("free");
  });

  it("heals an org's paid tier when the owner's subscription is canceled", async () => {
    const store = seedOrg({ orgTier: "pro", ownerSubId: "sub_owner_dead" });
    mockStripeInstance.subscriptions.retrieve.mockResolvedValueOnce({
      id: "sub_owner_dead",
      status: "canceled",
      cancel_at_period_end: false,
    } as any);

    const res = await request(app).get("/billing/status").set(AUTH_HEADERS);
    expect(res.status).toBe(200);
    expect(res.body.tier).toBe("free");
    expect(store.get("billing-acct")!.tier).toBe("free");
  });

  it("does NOT strip an org on a transient error fetching the owner's subscription", async () => {
    const store = seedOrg({ orgTier: "team", ownerSubId: "sub_owner_flaky" });
    mockStripeInstance.subscriptions.retrieve.mockRejectedValueOnce(new Error("ETIMEDOUT"));

    const res = await request(app).get("/billing/status").set(AUTH_HEADERS);
    expect(res.status).toBe(200);
    expect(res.body.tier).toBe("team");
    expect(store.get("billing-acct")!.tier).toBe("team");
  });
});

describe("Billing: Checkout", () => {
  it("POST /billing/checkout creates a Stripe checkout session", async () => {
    const res = await request(app)
      .post("/billing/checkout")
      .set(AUTH_HEADERS)
      .send({
        planKey: "guardian_pro_monthly",
        successUrl: "http://localhost:3000/billing?success=true",
        cancelUrl: "http://localhost:3000/billing?canceled=true",
      });
    expect(res.status).toBe(200);
    expect(res.body.checkoutUrl).toBe("https://checkout.stripe.com/test");
    expect(res.body.sessionId).toBe("cs_test_session_123");
  });

  it("POST /billing/checkout creates Stripe customer if none exists", async () => {
    await request(app)
      .post("/billing/checkout")
      .set(AUTH_HEADERS)
      .send({ planKey: "guardian_pro_monthly" });

    expect(mockStripeInstance.customers.create).toHaveBeenCalled();
  });

  it("POST /billing/checkout reuses existing Stripe customer", async () => {
    const store = mockGetStore("GuardianAccount");
    store.get("billing-acct")!.stripeCustomerId = "cus_existing";

    await request(app)
      .post("/billing/checkout")
      .set(AUTH_HEADERS)
      .send({ planKey: "guardian_pro_monthly" });

    expect(mockStripeInstance.customers.create).not.toHaveBeenCalled();
  });

  it("POST /billing/checkout rejects missing planKey", async () => {
    const res = await request(app)
      .post("/billing/checkout")
      .set(AUTH_HEADERS)
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("planKey");
  });

  it("POST /billing/checkout rejects unknown plan key", async () => {
    const res = await request(app)
      .post("/billing/checkout")
      .set(AUTH_HEADERS)
      .send({ planKey: "guardian_platinum_monthly" });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("Unknown plan");
  });

  it("POST /billing/checkout accepts all valid plan keys", async () => {
    for (const planKey of [
      "guardian_pro_monthly", "guardian_pro_annual",
      "guardian_team_monthly", "guardian_team_annual",
    ]) {
      const res = await request(app)
        .post("/billing/checkout")
        .set(AUTH_HEADERS)
        .send({ planKey });
      expect(res.status).toBe(200);
    }
  });

  it("POST /billing/checkout rejects redirect to external domain", async () => {
    const res = await request(app)
      .post("/billing/checkout")
      .set(AUTH_HEADERS)
      .send({
        planKey: "guardian_pro_monthly",
        successUrl: "https://evil.com/phish",
      });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("allowed domain");
  });

  it("POST /billing/checkout allows redirect to app.kill-switch.net", async () => {
    const res = await request(app)
      .post("/billing/checkout")
      .set(AUTH_HEADERS)
      .send({
        planKey: "guardian_pro_monthly",
        successUrl: "https://app.kill-switch.net/billing?success=true",
        cancelUrl: "https://app.kill-switch.net/billing?canceled=true",
      });
    expect(res.status).toBe(200);
  });

  it("POST /billing/checkout requires authentication", async () => {
    const res = await request(app)
      .post("/billing/checkout")
      .send({ planKey: "guardian_pro_monthly" });
    expect(res.status).toBe(401);
  });
});

describe("Billing: Customer Portal", () => {
  it("POST /billing/portal creates portal session for paying customer", async () => {
    const store = mockGetStore("GuardianAccount");
    store.get("billing-acct")!.stripeCustomerId = "cus_test_123";

    const res = await request(app)
      .post("/billing/portal")
      .set(AUTH_HEADERS)
      .send({ returnUrl: "http://localhost:3000/billing" });
    expect(res.status).toBe(200);
    expect(res.body.portalUrl).toBe("https://billing.stripe.com/portal/test");
  });

  it("POST /billing/portal rejects redirect to external domain", async () => {
    const store = mockGetStore("GuardianAccount");
    store.get("billing-acct")!.stripeCustomerId = "cus_test_123";

    const res = await request(app)
      .post("/billing/portal")
      .set(AUTH_HEADERS)
      .send({ returnUrl: "https://evil.com/steal-session" });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("allowed domain");
  });

  it("POST /billing/portal rejects when no Stripe customer", async () => {
    const res = await request(app)
      .post("/billing/portal")
      .set(AUTH_HEADERS)
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("No billing account");
  });

  it("POST /billing/portal requires authentication", async () => {
    const res = await request(app)
      .post("/billing/portal")
      .send({});
    expect(res.status).toBe(401);
  });
});

describe("Billing: Stripe Webhooks", () => {
  it("POST /billing/webhook handles checkout.session.completed (upgrade)", async () => {
    const event = {
      type: "checkout.session.completed",
      data: {
        object: {
          id: "cs_123",
          customer: "cus_webhook_test",
          subscription: "sub_webhook_test",
          metadata: { guardianAccountId: "billing-acct", tier: "pro" },
        },
      },
    };

    const res = await request(app)
      .post("/billing/webhook")
      .set("stripe-signature", "test_sig")
      .set("Content-Type", "application/json")
      .send(JSON.stringify(event));

    expect(res.status).toBe(200);
    expect(res.body.received).toBe(true);

    // Verify account was upgraded
    const account = mockGetStore("GuardianAccount").get("billing-acct")!;
    expect(account.tier).toBe("pro");
    expect(account.stripeCustomerId).toBe("cus_webhook_test");
    expect(account.stripeSubscriptionId).toBe("sub_webhook_test");
  });

  it("POST /billing/webhook handles customer.subscription.deleted (downgrade)", async () => {
    const store = mockGetStore("GuardianAccount");
    const account = store.get("billing-acct")!;
    account.tier = "pro";
    account.stripeSubscriptionId = "sub_to_cancel";

    const event = {
      type: "customer.subscription.deleted",
      data: { object: { id: "sub_to_cancel", status: "canceled" } },
    };

    const res = await request(app)
      .post("/billing/webhook")
      .set("stripe-signature", "test_sig")
      .set("Content-Type", "application/json")
      .send(JSON.stringify(event));

    expect(res.status).toBe(200);
    expect(account.tier).toBe("free");
    expect(account.stripeSubscriptionId).toBeUndefined();
    expect(account.settings.checkIntervalMinutes).toBe(360);
  });

  it("POST /billing/webhook handles customer.subscription.updated (plan change)", async () => {
    const store = mockGetStore("GuardianAccount");
    const account = store.get("billing-acct")!;
    account.tier = "pro";
    account.stripeSubscriptionId = "sub_upgrade";

    const event = {
      type: "customer.subscription.updated",
      data: {
        object: {
          id: "sub_upgrade",
          status: "active",
          items: { data: [{ price: { id: "price_1TE2hOIzNdoxvIKmSeL0KiC4" } }] },
        },
      },
    };

    const res = await request(app)
      .post("/billing/webhook")
      .set("stripe-signature", "test_sig")
      .set("Content-Type", "application/json")
      .send(JSON.stringify(event));

    expect(res.status).toBe(200);
    expect(account.tier).toBe("team");
    expect(account.settings.checkIntervalMinutes).toBe(5);
  });

  it("POST /billing/webhook returns 200 for unknown event types", async () => {
    const event = { type: "invoice.payment_succeeded", data: { object: {} } };

    const res = await request(app)
      .post("/billing/webhook")
      .set("stripe-signature", "test_sig")
      .set("Content-Type", "application/json")
      .send(JSON.stringify(event));

    expect(res.status).toBe(200);
    expect(res.body.received).toBe(true);
  });
});

describe("Billing: Tier Enforcement", () => {
  it("free tier blocks adding a 2nd cloud account", async () => {
    // Seed one existing cloud account
    const caStore = mockGetStore("GuardianCloudAccount");
    caStore.set("ca-1", {
      _id: "ca-1",
      guardianAccountId: "billing-acct",
      provider: "cloudflare",
    });

    const res = await request(app)
      .post("/cloud-accounts")
      .set(AUTH_HEADERS)
      .send({
        provider: "cloudflare",
        name: "Second Account",
        credential: { apiToken: "tok", accountId: "acc" },
      });

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/plan allows 1/i);
    expect(res.body.currentTier).toBe("none");
  });

  it("pro tier allows adding cloud accounts (up to limit)", async () => {
    const store = mockGetStore("GuardianAccount");
    store.get("billing-acct")!.tier = "pro";

    const res = await request(app)
      .post("/cloud-accounts")
      .set(AUTH_HEADERS)
      .send({
        provider: "cloudflare",
        name: "First Account",
        credential: { apiToken: "tok", accountId: "acc" },
      });

    expect(res.status).toBe(201);
  });

  it("upgrade from free to pro unlocks adding more accounts", async () => {
    const store = mockGetStore("GuardianAccount");
    const caStore = mockGetStore("GuardianCloudAccount");

    // Seed 1 existing cloud account
    caStore.set("ca-1", { _id: "ca-1", guardianAccountId: "billing-acct", provider: "cloudflare" });

    // Free tier — blocked
    let res = await request(app)
      .post("/cloud-accounts")
      .set(AUTH_HEADERS)
      .send({ provider: "gcp", name: "GCP", credential: { projectId: "p", serviceAccountKey: "{}" } });
    expect(res.status).toBe(403);

    // Upgrade to pro
    store.get("billing-acct")!.tier = "pro";

    // Now allowed
    res = await request(app)
      .post("/cloud-accounts")
      .set(AUTH_HEADERS)
      .send({ provider: "gcp", name: "GCP", credential: { projectId: "p", serviceAccountKey: "{}" } });
    expect(res.status).toBe(201);
  });
});

describe("Billing: Onboarding + Billing Integration", () => {
  it("PATCH /accounts/me marks onboarding complete", async () => {
    const res = await request(app)
      .patch("/accounts/me")
      .set(AUTH_HEADERS)
      .send({ onboardingCompleted: true });

    expect(res.status).toBe(200);
    const account = mockGetStore("GuardianAccount").get("billing-acct")!;
    expect(account.onboardingCompleted).toBe(true);
  });

  it("GET /accounts/me returns tier and onboarding status", async () => {
    const res = await request(app)
      .get("/accounts/me")
      .set(AUTH_HEADERS);

    expect(res.status).toBe(200);
    expect(res.body.tier).toBe("free");
    expect(res.body.onboardingCompleted).toBe(false);
  });

  it("GET /accounts/me strips stripeCustomerId from response", async () => {
    const store = mockGetStore("GuardianAccount");
    store.get("billing-acct")!.stripeCustomerId = "cus_secret";

    const res = await request(app)
      .get("/accounts/me")
      .set(AUTH_HEADERS);

    expect(res.status).toBe(200);
    expect(res.body.stripeCustomerId).toBeUndefined();
  });
});
