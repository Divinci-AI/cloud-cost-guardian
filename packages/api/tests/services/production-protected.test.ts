/**
 * Production-protected DB guard (dogfood feedback D1/D3).
 *
 * A managed database with productionProtected (default-on) must never have a
 * destructive action (pause-cluster / delete / nuke) auto-executed — not by a
 * threshold kill, and not by an explicit rule. Born from the Divinci prod-Atlas
 * incident, where a `pause-cluster` rule took prod down. The breach is
 * downgraded to a forensic snapshot + alert.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../src/models/cloud-account/schema.js", () => ({
  CloudAccountModel: { find: vi.fn(), findByIdAndUpdate: vi.fn() },
}));
vi.mock("../../src/models/guardian-account/schema.js", () => ({
  GuardianAccountModel: { find: vi.fn().mockResolvedValue([]), findById: vi.fn() },
}));
vi.mock("../../src/models/encrypted-credential/schema.js", () => ({ getCredential: vi.fn() }));
vi.mock("../../src/providers/index.js", () => ({ getProvider: vi.fn() }));
vi.mock("../../src/services/alerting.js", () => ({ sendAlerts: vi.fn() }));
vi.mock("../../src/globals/index.js", () => ({
  isMongoEnabled: vi.fn(() => false),
  isMongoConnected: vi.fn(() => true),
  recordUsageSnapshot: vi.fn(),
  recordAlert: vi.fn(),
  recordRuleEvent: vi.fn(),
}));
vi.mock("../../src/models/kill-switch-rule/schema.js", () => ({
  KillSwitchRuleModel: {
    find: vi.fn().mockReturnValue({ lean: vi.fn().mockResolvedValue([{ id: "r1" }]) }),
    updateOne: vi.fn().mockResolvedValue({}),
  },
}));
vi.mock("../../src/services/rule-engine.js", () => ({ evaluateRules: vi.fn().mockReturnValue([]) }));
vi.mock("../../src/services/forensics.js", () => ({
  captureSnapshot: vi.fn().mockResolvedValue({ id: "snap-test" }),
}));

import { runCheckCycle } from "../../src/services/monitoring-engine.js";
import { CloudAccountModel } from "../../src/models/cloud-account/schema.js";
import { GuardianAccountModel } from "../../src/models/guardian-account/schema.js";
import { getCredential } from "../../src/models/encrypted-credential/schema.js";
import { getProvider } from "../../src/providers/index.js";
import { evaluateRules } from "../../src/services/rule-engine.js";
import { captureSnapshot } from "../../src/services/forensics.js";

function mongoProvider(violations: any[] = []) {
  return {
    id: "mongodb",
    name: "MongoDB Atlas",
    checkUsage: vi.fn().mockResolvedValue({
      provider: "mongodb",
      accountId: "test",
      checkedAt: Date.now(),
      services: [{ serviceName: "ks-cluster0", metrics: [], estimatedDailyCostUSD: 15 }],
      totalEstimatedDailyCostUSD: 15,
      violations,
    }),
    executeKillSwitch: vi.fn().mockResolvedValue({ success: true, action: "pause-cluster", serviceName: "ks-cluster0", details: "paused" }),
    validateCredential: vi.fn(),
    getDefaultThresholds: vi.fn(),
  };
}

function account(overrides: any = {}) {
  return {
    _id: "acc1", provider: "mongodb", credentialId: "cred1", thresholds: {},
    protectedServices: [], autoDisconnect: false, autoDelete: false,
    guardianAccountId: "ga1", name: "Prod Atlas", ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getCredential).mockResolvedValue({ provider: "mongodb", connectionString: "x" } as any);
  vi.mocked(CloudAccountModel.findByIdAndUpdate).mockResolvedValue(null as any);
  vi.mocked(GuardianAccountModel.findById).mockResolvedValue({ alertChannels: [] } as any);
  vi.mocked(evaluateRules).mockReturnValue([]);
});

describe("Production-protected DB guard", () => {
  it("blocks an explicit pause-cluster RULE on a protected managed DB (and snapshots instead)", async () => {
    const provider = mongoProvider();
    vi.mocked(getProvider).mockReturnValue(provider as any);
    vi.mocked(CloudAccountModel.find).mockResolvedValue([account()] as any); // productionProtected defaults on
    vi.mocked(evaluateRules).mockReturnValue([
      { ruleId: "r1", ruleName: "Atlas pause", triggered: true, cooldownActive: false, conditionsMatched: [],
        actionsToExecute: [{ type: "pause-cluster", target: "ks-cluster0", requiresApproval: false }] },
    ] as any);

    await runCheckCycle();

    expect(provider.executeKillSwitch).not.toHaveBeenCalled();
    expect(captureSnapshot).toHaveBeenCalledWith(
      expect.anything(), "ks-cluster0", expect.stringContaining("protected-block:rule:"), expect.any(String),
    );
  });

  it("blocks a threshold-driven delete on a protected managed DB", async () => {
    const provider = mongoProvider([{
      serviceName: "ks-cluster0", metricName: "Daily Cost", currentValue: 9999, threshold: 30,
      unit: "USD", severity: "critical", category: "cost",
    }]);
    vi.mocked(getProvider).mockReturnValue(provider as any);
    // autoDelete + critical cost → would fire delete; protection must block it.
    vi.mocked(CloudAccountModel.find).mockResolvedValue([account({ autoDelete: true })] as any);

    await runCheckCycle();

    expect(provider.executeKillSwitch).not.toHaveBeenCalledWith(
      expect.anything(), expect.anything(), "delete", expect.anything(),
    );
    expect(captureSnapshot).toHaveBeenCalledWith(
      expect.anything(), "ks-cluster0", expect.stringContaining("protected-block:delete"), expect.any(String),
    );
  });

  it("EXECUTES pause-cluster when productionProtected is explicitly false (opt-out)", async () => {
    const provider = mongoProvider();
    vi.mocked(getProvider).mockReturnValue(provider as any);
    vi.mocked(CloudAccountModel.find).mockResolvedValue([account({ productionProtected: false })] as any);
    vi.mocked(evaluateRules).mockReturnValue([
      { ruleId: "r1", ruleName: "Atlas pause", triggered: true, cooldownActive: false, conditionsMatched: [],
        actionsToExecute: [{ type: "pause-cluster", target: "ks-cluster0", requiresApproval: false }] },
    ] as any);

    await runCheckCycle();

    expect(provider.executeKillSwitch).toHaveBeenCalledWith(
      expect.anything(), "ks-cluster0", "pause-cluster", expect.anything(),
    );
  });

  it("does NOT block a non-destructive rule action (kill-connections) on a protected DB", async () => {
    const provider = mongoProvider();
    vi.mocked(getProvider).mockReturnValue(provider as any);
    vi.mocked(CloudAccountModel.find).mockResolvedValue([account()] as any);
    vi.mocked(evaluateRules).mockReturnValue([
      { ruleId: "r1", ruleName: "Atlas conns", triggered: true, cooldownActive: false, conditionsMatched: [],
        actionsToExecute: [{ type: "kill-connections", target: "ks-cluster0", requiresApproval: false }] },
    ] as any);

    await runCheckCycle();

    expect(provider.executeKillSwitch).toHaveBeenCalledWith(
      expect.anything(), "ks-cluster0", "kill-connections", expect.anything(),
    );
  });

  it("does NOT protect a non-DB provider (cloudflare pause-zone still executes)", async () => {
    const provider = {
      id: "cloudflare", name: "Cloudflare",
      checkUsage: vi.fn().mockResolvedValue({ provider: "cloudflare", accountId: "t", checkedAt: Date.now(), services: [], totalEstimatedDailyCostUSD: 0, violations: [] }),
      executeKillSwitch: vi.fn().mockResolvedValue({ success: true, action: "pause-zone", serviceName: "zone1", details: "paused zone" }),
      validateCredential: vi.fn(), getDefaultThresholds: vi.fn(),
    };
    vi.mocked(getProvider).mockReturnValue(provider as any);
    vi.mocked(getCredential).mockResolvedValue({ provider: "cloudflare", apiToken: "t", accountId: "a" } as any);
    vi.mocked(CloudAccountModel.find).mockResolvedValue([account({ provider: "cloudflare", name: "CF" })] as any);
    vi.mocked(evaluateRules).mockReturnValue([
      { ruleId: "r1", ruleName: "Zone pause", triggered: true, cooldownActive: false, conditionsMatched: [],
        actionsToExecute: [{ type: "pause-zone", target: "zone1", requiresApproval: false }] },
    ] as any);

    await runCheckCycle();

    expect(provider.executeKillSwitch).toHaveBeenCalledWith(
      expect.anything(), "zone1", "pause-zone", expect.anything(),
    );
  });
});
