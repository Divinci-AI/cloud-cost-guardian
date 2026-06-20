/**
 * Unit tests for budget-checker.ts
 *
 * Uses an in-memory fake for Mongoose models and a stub Postgres pool so the
 * tests are fully offline — no DB required.
 */

import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";

// ── Stub environment before module imports ────────────────────────────────────
vi.stubEnv("VAPID_PUBLIC_KEY", "BCvTKuCyDf_XfFZ9FiHs5xIHpAm3XUqDGbQv7Yx4aBC");
vi.stubEnv("VAPID_PRIVATE_KEY", "kdl3mUJpMp_ABC123FAKE_PRIVATE");
vi.stubEnv("VAPID_EMAIL", "test@example.com");

// ── Mock web-push so VAPID init doesn't throw on fake key values ──────────────
vi.mock("web-push", () => ({
  default: {
    setVapidDetails: vi.fn(),
    sendNotification: vi.fn().mockResolvedValue({}),
  },
}));

// ── Mock globals/index.js (Postgres pool) ─────────────────────────────────────
const mockQuery = vi.fn();
vi.mock("../../src/globals/index.js", () => ({
  isMongoEnabled: vi.fn(() => false),
  isMongoConnected: vi.fn(() => true),
  getPostgresPool: () => ({ query: mockQuery }),
}));

// ── In-memory fake Mongoose model helpers ─────────────────────────────────────
type Doc = Record<string, any>;

/** Wraps a Promise so Mongoose-style .lean() and .sort() chaining works. */
function q<T>(promise: Promise<T>): Promise<T> & { lean: () => Promise<T>; sort: (...a: any[]) => ReturnType<typeof q> } {
  const p = promise as any;
  p.lean = () => promise;
  p.sort = (_by?: any) => q(promise);
  return p;
}

function makeModel(initial: Doc[] = []) {
  const store: Doc[] = initial; // keep reference so test-level push/length=0 is visible

  const model: any = {
    _store: store,
    find: vi.fn((filter: Doc) => q(Promise.resolve(store.filter(doc => matches(doc, filter))))),
    findOne: vi.fn((filter: Doc) => q(Promise.resolve(store.find(doc => matches(doc, filter)) ?? null))),
    findById: vi.fn((id: string) => q(Promise.resolve(store.find(d => d._id === id || d.id === id) ?? null))),
    findOneAndUpdate: vi.fn(async (filter: Doc, update: Doc, opts: any) => {
      let doc = store.find(d => matches(d, filter));
      if (!doc && opts?.upsert) {
        doc = { ...filter, ...flattenUpdate(update) };
        store.push(doc);
      } else if (doc) {
        Object.assign(doc, flattenUpdate(update));
      }
      return doc ?? null;
    }),
    updateOne: vi.fn(async (filter: Doc, update: Doc) => {
      const doc = store.find(d => matches(d, filter));
      if (doc) Object.assign(doc, flattenUpdate(update));
      return { modifiedCount: doc ? 1 : 0 };
    }),
    deleteOne: vi.fn(async (filter: Doc) => {
      const idx = store.findIndex(d => matches(d, filter));
      if (idx !== -1) store.splice(idx, 1);
      return { deletedCount: 1 };
    }),
    countDocuments: vi.fn(async (filter: Doc) =>
      store.filter(d => matches(d, filter)).length,
    ),
  };
  return model;
}

function matches(doc: Doc, filter: Doc): boolean {
  return Object.entries(filter).every(([k, v]) => {
    if (v !== null && typeof v === "object" && !Array.isArray(v)) {
      // Handle $in
      if ("$in" in v) return (v.$in as any[]).includes(doc[k]);
    }
    return doc[k] === v;
  });
}

function flattenUpdate(update: Doc): Doc {
  const result: Doc = {};
  for (const [op, fields] of Object.entries(update)) {
    if (op === "$set") Object.assign(result, fields);
    else if (op === "$addToSet") {
      // handled inline in test expectations since we need the doc reference
    } else if (op[0] !== "$") {
      result[op] = fields;
    }
  }
  return result;
}

// ── Mock Mongoose models ───────────────────────────────────────────────────────
const mockUserBudgetStore: Doc[] = [];
const mockPushStore: Doc[] = [];
const mockAccountStore: Doc[] = [];

const UserBudgetModel = makeModel(mockUserBudgetStore);
const PushSubscriptionModel = makeModel(mockPushStore);
const GuardianAccountModel = makeModel(mockAccountStore);

vi.mock("../../src/models/user-budget/schema.js", () => ({
  UserBudgetModel,
}));
vi.mock("../../src/models/push-subscription/schema.js", () => ({
  PushSubscriptionModel,
}));
vi.mock("../../src/models/guardian-account/schema.js", () => ({
  GuardianAccountModel,
}));

// ── Mock alerting ──────────────────────────────────────────────────────────────
const mockSendAlerts = vi.fn().mockResolvedValue(undefined);
vi.mock("../../src/services/alerting.js", () => ({
  sendAlerts: (...args: any[]) => mockSendAlerts(...args),
}));

// ── Import after all mocks are in place ───────────────────────────────────────
const { getPeriodStart, getPeriodEnd, checkBudgets, getBudgetStatuses } =
  await import("../../src/services/budget-checker.js");

// ─────────────────────────────────────────────────────────────────────────────
describe("getPeriodStart", () => {
  it("returns start of current hour", () => {
    const start = getPeriodStart("hour");
    const now = new Date();
    expect(new Date(start).getMinutes()).toBe(0);
    expect(new Date(start).getSeconds()).toBe(0);
    expect(new Date(start).getHours()).toBe(now.getHours());
  });

  it("returns start of today for 'day'", () => {
    const start = getPeriodStart("day");
    const d = new Date(start);
    expect(d.getHours()).toBe(0);
    expect(d.getMinutes()).toBe(0);
    expect(d.getSeconds()).toBe(0);
  });

  it("returns start of current week (Sunday) for 'week'", () => {
    const start = getPeriodStart("week");
    expect(new Date(start).getDay()).toBe(0); // Sunday
  });

  it("returns 1st of current month for 'month'", () => {
    const start = getPeriodStart("month");
    expect(new Date(start).getDate()).toBe(1);
  });

  it("returns Jan 1 of current year for 'year'", () => {
    const start = getPeriodStart("year");
    const d = new Date(start);
    expect(d.getMonth()).toBe(0);
    expect(d.getDate()).toBe(1);
  });

  it("returns a value <= Date.now()", () => {
    for (const p of ["hour", "day", "week", "month", "year"] as const) {
      expect(getPeriodStart(p)).toBeLessThanOrEqual(Date.now());
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("getPeriodEnd", () => {
  it("is exactly 1 hour after start for 'hour'", () => {
    const start = getPeriodStart("hour");
    const end = getPeriodEnd("hour", start);
    expect(end - start).toBe(60 * 60 * 1000);
  });

  it("is exactly 1 day after start for 'day'", () => {
    const start = getPeriodStart("day");
    const end = getPeriodEnd("day", start);
    expect(end - start).toBe(24 * 60 * 60 * 1000);
  });

  it("is exactly 7 days after start for 'week'", () => {
    const start = getPeriodStart("week");
    const end = getPeriodEnd("week", start);
    expect(end - start).toBe(7 * 24 * 60 * 60 * 1000);
  });

  it("end is after start for all periods", () => {
    for (const p of ["hour", "day", "week", "month", "year"] as const) {
      const s = getPeriodStart(p);
      expect(getPeriodEnd(p, s)).toBeGreaterThan(s);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("checkBudgets", () => {
  beforeEach(() => {
    mockUserBudgetStore.length = 0;
    mockPushStore.length = 0;
    mockAccountStore.length = 0;
    vi.clearAllMocks();
    // Default: Postgres returns 0 spend
    mockQuery.mockResolvedValue({ rows: [{ total: "0", daily_rate: "0" }] });
  });

  it("exits early when no enabled budgets exist", async () => {
    await checkBudgets("org-1");
    expect(mockQuery).not.toHaveBeenCalled();
    expect(mockSendAlerts).not.toHaveBeenCalled();
  });

  it("does not alert when spend is below all thresholds", async () => {
    mockUserBudgetStore.push({
      _id: "b1", id: "budget-b1", guardianAccountId: "org-1",
      name: "My Budget", period: "day", budgetAmountUsd: 100,
      thresholdPcts: [75, 90, 100], channels: "all",
      enabled: true, notifiedThresholds: [], periodStartedAt: getPeriodStart("day"),
    });
    mockAccountStore.push({ _id: "org-1", alertChannels: [], tier: "free" });
    mockQuery.mockResolvedValue({ rows: [{ total: "10" }] }); // $10 of $100 = 10%

    await checkBudgets("org-1");

    expect(mockSendAlerts).not.toHaveBeenCalled();
  });

  it("fires alerts when a threshold is crossed", async () => {
    mockUserBudgetStore.push({
      _id: "b2", id: "budget-b2", guardianAccountId: "org-2",
      name: "Dev Spend", period: "day", budgetAmountUsd: 100,
      thresholdPcts: [75, 90], channels: "all",
      enabled: true, notifiedThresholds: [], periodStartedAt: getPeriodStart("day"),
    });
    mockAccountStore.push({
      _id: "org-2", id: "org-2",
      alertChannels: [{ name: "Slack", type: "slack", enabled: true, config: {} }],
      tier: "pro",
    });
    mockQuery.mockResolvedValue({ rows: [{ total: "80" }] }); // $80 of $100 = 80%

    await checkBudgets("org-2");

    expect(mockSendAlerts).toHaveBeenCalledTimes(1);
    const call = mockSendAlerts.mock.calls[0];
    // summary contains actual spend % and the crossed threshold is in context
    expect(call[1]).toContain("80%");
    expect(call[3]).toMatchObject({ threshold: 75 });
  });

  it("does not re-alert for already-notified threshold", async () => {
    mockUserBudgetStore.push({
      _id: "b3", id: "budget-b3", guardianAccountId: "org-3",
      name: "Prod Spend", period: "day", budgetAmountUsd: 100,
      thresholdPcts: [75], channels: "all",
      enabled: true, notifiedThresholds: [75], // already fired at 75%
      periodStartedAt: getPeriodStart("day"),
    });
    mockAccountStore.push({
      _id: "org-3", id: "org-3",
      alertChannels: [{ name: "PD", type: "pagerduty", enabled: true, config: {} }],
      tier: "pro",
    });
    mockQuery.mockResolvedValue({ rows: [{ total: "90" }] }); // still above 75%

    await checkBudgets("org-3");

    expect(mockSendAlerts).not.toHaveBeenCalled();
  });

  it("resets notifiedThresholds when period rolls over", async () => {
    const yesterdayStart = getPeriodStart("day") - 24 * 60 * 60 * 1000;
    mockUserBudgetStore.push({
      _id: "b4", id: "budget-b4", guardianAccountId: "org-4",
      name: "Daily", period: "day", budgetAmountUsd: 100,
      thresholdPcts: [75], channels: "all",
      enabled: true, notifiedThresholds: [75], // fired yesterday
      periodStartedAt: yesterdayStart, // previous period
    });
    mockAccountStore.push({
      _id: "org-4", id: "org-4",
      alertChannels: [{ name: "Email", type: "email", enabled: true, config: {} }],
      tier: "pro",
    });
    mockQuery.mockResolvedValue({ rows: [{ total: "80" }] }); // above 75% again today

    await checkBudgets("org-4");

    // Period rollover should have reset notifiedThresholds, so alert fires again
    expect(mockSendAlerts).toHaveBeenCalledTimes(1);
    // updateOne should have been called to reset and then to add threshold back
    expect(UserBudgetModel.updateOne).toHaveBeenCalledWith(
      { _id: "b4" },
      { $set: expect.objectContaining({ notifiedThresholds: [] }) },
    );
  });

  it("fires 100% threshold alert as 'critical' severity", async () => {
    mockUserBudgetStore.push({
      _id: "b5", id: "budget-b5", guardianAccountId: "org-5",
      name: "Limit", period: "day", budgetAmountUsd: 50,
      thresholdPcts: [100], channels: "all",
      enabled: true, notifiedThresholds: [],
      periodStartedAt: getPeriodStart("day"),
    });
    mockAccountStore.push({
      _id: "org-5", id: "org-5",
      alertChannels: [{ name: "PD", type: "pagerduty", enabled: true, config: {} }],
      tier: "pro",
    });
    mockQuery.mockResolvedValue({ rows: [{ total: "55" }] }); // 110% of budget

    await checkBudgets("org-5");

    expect(mockSendAlerts).toHaveBeenCalledWith(
      expect.anything(),
      expect.any(String),
      "critical",
      expect.any(Object),
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("getBudgetStatuses", () => {
  beforeEach(() => {
    mockUserBudgetStore.length = 0;
    vi.clearAllMocks();
    mockQuery.mockResolvedValue({ rows: [{ total: "25" }] });
  });

  it("returns empty array when no budgets", async () => {
    const result = await getBudgetStatuses("org-x");
    expect(result).toEqual([]);
  });

  it("returns status with currentSpendUsd and pctUsed", async () => {
    mockUserBudgetStore.push({
      _id: "s1", id: "budget-s1", guardianAccountId: "org-y",
      name: "Test", period: "month", budgetAmountUsd: 100,
      thresholdPcts: [75], channels: "all",
      enabled: true, notifiedThresholds: [],
      periodStartedAt: getPeriodStart("month"),
    });

    const result = await getBudgetStatuses("org-y");

    expect(result).toHaveLength(1);
    expect(result[0].currentSpendUsd).toBe(25);
    expect(result[0].pctUsed).toBe(25.0);
    expect(result[0].periodStartMs).toBeLessThanOrEqual(Date.now());
    expect(result[0].periodEndMs).toBeGreaterThan(result[0].periodStartMs);
  });

  it("returns 0 spend for disabled budgets", async () => {
    mockUserBudgetStore.push({
      _id: "s2", id: "budget-s2", guardianAccountId: "org-z",
      name: "Disabled", period: "day", budgetAmountUsd: 100,
      thresholdPcts: [75], channels: "all",
      enabled: false, notifiedThresholds: [],
      periodStartedAt: getPeriodStart("day"),
    });

    const result = await getBudgetStatuses("org-z");

    expect(result[0].currentSpendUsd).toBe(0);
    expect(result[0].pctUsed).toBe(0);
  });
});
