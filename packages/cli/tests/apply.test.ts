/**
 * `ks apply` integration-as-code (dogfood feedback C3).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { interpolateEnv, parseSpec, reconcile, type ApplySpec } from "../src/apply.js";

describe("interpolateEnv", () => {
  it("replaces ${VAR} in nested string values", () => {
    const out = interpolateEnv({ a: "x-${FOO}", b: ["${FOO}", 2], c: { d: "${BAR}" } }, { FOO: "1", BAR: "2" } as any);
    expect(out).toEqual({ a: "x-1", b: ["1", 2], c: { d: "2" } });
  });
  it("throws when a referenced var is unset", () => {
    expect(() => interpolateEnv("${MISSING}", {} as any)).toThrow(/MISSING/);
  });
  it("leaves non-template strings and non-strings alone", () => {
    expect(interpolateEnv({ a: "plain", n: 5, b: true }, {} as any)).toEqual({ a: "plain", n: 5, b: true });
  });
});

describe("parseSpec", () => {
  it("parses YAML", () => {
    const s = parseSpec("account:\n  provider: mongodb\n  name: Atlas\n", "ks.yaml");
    expect(s.account).toEqual({ provider: "mongodb", name: "Atlas" });
  });
  it("parses JSON by extension", () => {
    const s = parseSpec(JSON.stringify({ account: { provider: "redis", name: "R" } }), "ks.json");
    expect(s.account.provider).toBe("redis");
  });
  it("rejects a spec missing account.provider/name", () => {
    expect(() => parseSpec("account:\n  name: x\n", "ks.yaml")).toThrow(/provider/);
  });
});

function makeClient() {
  return {
    accounts: { list: vi.fn().mockResolvedValue([]), create: vi.fn().mockResolvedValue({ id: "acc1", name: "Atlas" }), update: vi.fn().mockResolvedValue({ id: "acc1" }) },
    rules: { presets: vi.fn().mockResolvedValue([{ id: "cost-runaway", name: "Cost Runaway Protection" }]), list: vi.fn().mockResolvedValue([]), applyPreset: vi.fn().mockResolvedValue({ id: "r1" }) },
    alerts: { channels: vi.fn().mockResolvedValue([]), addChannel: vi.fn().mockResolvedValue({ updated: true }) },
  } as any;
}

const fullSpec: ApplySpec = {
  account: {
    provider: "mongodb", name: "Atlas",
    credential: { mongodbSubType: "atlas", atlasPublicKey: "p" },
    thresholds: { mongodbDailyCostUSD: 40 }, productionProtected: true,
  },
  shields: ["cost-runaway"],
  alerts: [{ type: "pagerduty", routingKey: "RK", name: "On-Call" }],
};

describe("reconcile", () => {
  let client: any;
  beforeEach(() => { client = makeClient(); });

  it("creates account, applies settings, shields, and alerts on first apply", async () => {
    const res = await reconcile(client, fullSpec);
    expect(client.accounts.create).toHaveBeenCalledOnce();
    expect(client.accounts.update).toHaveBeenCalledWith("acc1", expect.objectContaining({ productionProtected: true, thresholds: { mongodbDailyCostUSD: 40 } }));
    expect(client.rules.applyPreset).toHaveBeenCalledWith("cost-runaway");
    expect(client.alerts.addChannel).toHaveBeenCalledWith(expect.objectContaining({ type: "pagerduty", config: { routingKey: "RK" } }));
    expect(res.items.filter((i) => i.change === "create").length).toBeGreaterThanOrEqual(3);
  });

  it("is idempotent: existing account/rule/channel report unchanged and re-create nothing", async () => {
    client.accounts.list.mockResolvedValue([{ id: "acc1", provider: "mongodb", name: "Atlas" }]);
    client.rules.list.mockResolvedValue([{ id: "r1", name: "Cost Runaway Protection" }]);
    client.alerts.channels.mockResolvedValue([{ type: "pagerduty", config: { routingKey: "RK" } }]);

    const res = await reconcile(client, fullSpec);
    expect(client.accounts.create).not.toHaveBeenCalled();
    expect(client.rules.applyPreset).not.toHaveBeenCalled();
    expect(client.alerts.addChannel).not.toHaveBeenCalled();
    expect(client.accounts.update).toHaveBeenCalled(); // settings still reconciled
    expect(res.items.some((i) => i.resource.startsWith("shield") && i.change === "unchanged")).toBe(true);
    expect(res.items.some((i) => i.resource.startsWith("alert") && i.change === "unchanged")).toBe(true);
  });

  it("dry-run performs no writes but returns the plan", async () => {
    const res = await reconcile(client, fullSpec, { dryRun: true });
    expect(client.accounts.create).not.toHaveBeenCalled();
    expect(client.accounts.update).not.toHaveBeenCalled();
    expect(client.rules.applyPreset).not.toHaveBeenCalled();
    expect(client.alerts.addChannel).not.toHaveBeenCalled();
    expect(res.dryRun).toBe(true);
    expect(res.items.some((i) => i.change === "create")).toBe(true);
  });

  it("errors when the account is absent and no credential is given", async () => {
    const noCred: ApplySpec = { account: { provider: "mongodb", name: "Atlas" } };
    await expect(reconcile(client, noCred)).rejects.toThrow(/credential/);
  });
});
