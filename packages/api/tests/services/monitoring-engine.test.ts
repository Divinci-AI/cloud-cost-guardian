import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock all external dependencies
vi.mock("../../src/models/cloud-account/schema.js", () => ({
  CloudAccountModel: {
    find: vi.fn(),
    findByIdAndUpdate: vi.fn(),
  },
}));

vi.mock("../../src/models/guardian-account/schema.js", () => ({
  GuardianAccountModel: {
    findById: vi.fn(),
  },
}));

vi.mock("../../src/models/encrypted-credential/schema.js", () => ({
  getCredential: vi.fn(),
}));

vi.mock("../../src/providers/index.js", () => ({
  getProvider: vi.fn(),
}));

vi.mock("../../src/services/alerting.js", () => ({
  sendAlerts: vi.fn(),
}));

vi.mock("../../src/globals/index.js", () => ({
  recordUsageSnapshot: vi.fn(),
  recordAlert: vi.fn(),
}));

import { runCheckCycle } from "../../src/services/monitoring-engine.js";
import { CloudAccountModel } from "../../src/models/cloud-account/schema.js";
import { GuardianAccountModel } from "../../src/models/guardian-account/schema.js";
import { getCredential } from "../../src/models/encrypted-credential/schema.js";
import { getProvider } from "../../src/providers/index.js";
import { sendAlerts } from "../../src/services/alerting.js";
import { recordUsageSnapshot } from "../../src/globals/index.js";

describe("Monitoring Engine", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns empty results when no active accounts", async () => {
    vi.mocked(CloudAccountModel.find).mockResolvedValue([]);
    const results = await runCheckCycle();
    expect(results).toHaveLength(0);
  });

  it("checks usage for each active account", async () => {
    const mockProvider = {
      id: "cloudflare",
      name: "Cloudflare",
      checkUsage: vi.fn().mockResolvedValue({
        provider: "cloudflare",
        accountId: "test",
        checkedAt: Date.now(),
        services: [],
        totalEstimatedDailyCostUSD: 0,
        violations: [],
      }),
      executeKillSwitch: vi.fn(),
      validateCredential: vi.fn(),
      getDefaultThresholds: vi.fn(),
    };

    vi.mocked(CloudAccountModel.find).mockResolvedValue([
      { _id: "acc1", provider: "cloudflare", credentialId: "cred1", thresholds: {}, protectedServices: [], autoDisconnect: false, autoDelete: false, guardianAccountId: "ga1", name: "Test" },
      { _id: "acc2", provider: "cloudflare", credentialId: "cred2", thresholds: {}, protectedServices: [], autoDisconnect: false, autoDelete: false, guardianAccountId: "ga1", name: "Test 2" },
    ] as any);

    vi.mocked(getCredential).mockResolvedValue({ provider: "cloudflare", apiToken: "tok", accountId: "aid" });
    vi.mocked(getProvider).mockReturnValue(mockProvider);
    vi.mocked(CloudAccountModel.findByIdAndUpdate).mockResolvedValue(null);

    const results = await runCheckCycle();

    expect(results).toHaveLength(2);
    expect(mockProvider.checkUsage).toHaveBeenCalledTimes(2);
    expect(results[0].status).toBe("ok");
    expect(results[1].status).toBe("ok");
  });

  it("detects violations and sends alerts", async () => {
    const mockProvider = {
      id: "cloudflare",
      name: "Cloudflare",
      checkUsage: vi.fn().mockResolvedValue({
        provider: "cloudflare",
        accountId: "test",
        checkedAt: Date.now(),
        services: [{ serviceName: "bad-worker", metrics: [], estimatedDailyCostUSD: 100 }],
        totalEstimatedDailyCostUSD: 100,
        violations: [{
          serviceName: "bad-worker",
          metricName: "DO Requests",
          currentValue: 5_000_000,
          threshold: 1_000_000,
          unit: "requests",
          severity: "critical",
        }],
      }),
      executeKillSwitch: vi.fn().mockResolvedValue({ success: true, action: "disconnect", serviceName: "bad-worker", details: "Disconnected" }),
      validateCredential: vi.fn(),
      getDefaultThresholds: vi.fn(),
    };

    vi.mocked(CloudAccountModel.find).mockResolvedValue([
      { _id: "acc1", provider: "cloudflare", credentialId: "cred1", thresholds: {}, protectedServices: [], autoDisconnect: true, autoDelete: false, guardianAccountId: "ga1", name: "Prod CF" },
    ] as any);

    vi.mocked(getCredential).mockResolvedValue({ provider: "cloudflare", apiToken: "tok", accountId: "aid" });
    vi.mocked(getProvider).mockReturnValue(mockProvider);
    vi.mocked(GuardianAccountModel.findById).mockResolvedValue({
      alertChannels: [{ type: "pagerduty", name: "PD", config: { routingKey: "key" }, enabled: true }],
    } as any);
    vi.mocked(CloudAccountModel.findByIdAndUpdate).mockResolvedValue(null);

    const results = await runCheckCycle();

    expect(results).toHaveLength(1);
    expect(results[0].status).toBe("violation");
    expect(results[0].violations).toHaveLength(1);
    expect(mockProvider.executeKillSwitch).toHaveBeenCalledWith(
      expect.anything(),
      "bad-worker",
      "disconnect"
    );
    expect(sendAlerts).toHaveBeenCalledWith(
      expect.any(Array),
      expect.stringContaining("Cloudflare cost alert"),
      "critical",
      expect.any(Object)
    );
  });

  it("respects protected services — does not kill them", async () => {
    const mockProvider = {
      id: "cloudflare",
      name: "Cloudflare",
      checkUsage: vi.fn().mockResolvedValue({
        provider: "cloudflare",
        accountId: "test",
        checkedAt: Date.now(),
        services: [],
        totalEstimatedDailyCostUSD: 0,
        violations: [{
          serviceName: "critical-api",
          metricName: "DO Requests",
          currentValue: 5_000_000,
          threshold: 1_000_000,
          unit: "requests",
          severity: "critical",
        }],
      }),
      executeKillSwitch: vi.fn(),
      validateCredential: vi.fn(),
      getDefaultThresholds: vi.fn(),
    };

    vi.mocked(CloudAccountModel.find).mockResolvedValue([
      { _id: "acc1", provider: "cloudflare", credentialId: "cred1", thresholds: {}, protectedServices: ["critical-api"], autoDisconnect: true, autoDelete: false, guardianAccountId: "ga1", name: "Prod" },
    ] as any);

    vi.mocked(getCredential).mockResolvedValue({ provider: "cloudflare", apiToken: "tok", accountId: "aid" });
    vi.mocked(getProvider).mockReturnValue(mockProvider);
    vi.mocked(GuardianAccountModel.findById).mockResolvedValue({ alertChannels: [] } as any);
    vi.mocked(CloudAccountModel.findByIdAndUpdate).mockResolvedValue(null);

    const results = await runCheckCycle();

    // Kill switch should NOT have been called
    expect(mockProvider.executeKillSwitch).not.toHaveBeenCalled();
    // But the violation should still be recorded
    expect(results[0].actionsTaken).toContain("PROTECTED: critical-api");
  });

  it("handles credential not found gracefully", async () => {
    vi.mocked(CloudAccountModel.find).mockResolvedValue([
      { _id: "acc1", provider: "cloudflare", credentialId: "missing", thresholds: {}, protectedServices: [], autoDisconnect: false, autoDelete: false, guardianAccountId: "ga1", name: "Test" },
    ] as any);

    vi.mocked(getCredential).mockResolvedValue(null);
    vi.mocked(getProvider).mockReturnValue({ id: "cloudflare", name: "CF", checkUsage: vi.fn(), executeKillSwitch: vi.fn(), validateCredential: vi.fn(), getDefaultThresholds: vi.fn() });
    vi.mocked(CloudAccountModel.findByIdAndUpdate).mockResolvedValue(null);

    const results = await runCheckCycle();

    expect(results[0].status).toBe("error");
    expect(results[0].error).toContain("Credential not found");
  });

  it("handles unknown provider gracefully", async () => {
    vi.mocked(CloudAccountModel.find).mockResolvedValue([
      { _id: "acc1", provider: "azure", credentialId: "cred1", thresholds: {}, protectedServices: [], autoDisconnect: false, autoDelete: false, guardianAccountId: "ga1", name: "Test" },
    ] as any);

    vi.mocked(getProvider).mockReturnValue(undefined);
    vi.mocked(CloudAccountModel.findByIdAndUpdate).mockResolvedValue(null);

    const results = await runCheckCycle();

    expect(results[0].status).toBe("error");
    expect(results[0].error).toContain("Unknown provider");
  });

  it("records usage snapshot to PostgreSQL after successful check", async () => {
    const mockProvider = {
      id: "cloudflare",
      name: "Cloudflare",
      checkUsage: vi.fn().mockResolvedValue({
        provider: "cloudflare",
        accountId: "test",
        checkedAt: Date.now(),
        services: [{ serviceName: "worker", metrics: [], estimatedDailyCostUSD: 5 }],
        totalEstimatedDailyCostUSD: 5,
        violations: [],
      }),
      executeKillSwitch: vi.fn(),
      validateCredential: vi.fn(),
      getDefaultThresholds: vi.fn(),
    };

    vi.mocked(CloudAccountModel.find).mockResolvedValue([
      { _id: "acc1", provider: "cloudflare", credentialId: "cred1", thresholds: {}, protectedServices: [], autoDisconnect: false, autoDelete: false, guardianAccountId: "ga1", name: "Test" },
    ] as any);

    vi.mocked(getCredential).mockResolvedValue({ provider: "cloudflare", apiToken: "tok", accountId: "aid" });
    vi.mocked(getProvider).mockReturnValue(mockProvider);
    vi.mocked(CloudAccountModel.findByIdAndUpdate).mockResolvedValue(null);

    await runCheckCycle();

    expect(recordUsageSnapshot).toHaveBeenCalledWith(
      "acc1", "ga1", "cloudflare",
      expect.any(Object),
      expect.any(Array),
      expect.any(Array),
      5,
      1
    );
  });

  it("uses scale-down for GCP provider violations", async () => {
    const mockProvider = {
      id: "gcp",
      name: "GCP",
      checkUsage: vi.fn().mockResolvedValue({
        provider: "gcp",
        accountId: "proj-123",
        checkedAt: Date.now(),
        services: [],
        totalEstimatedDailyCostUSD: 0,
        violations: [{
          serviceName: "api-service",
          metricName: "Projected Monthly Cost",
          currentValue: 1000,
          threshold: 500,
          unit: "USD",
          severity: "warning",
        }],
      }),
      executeKillSwitch: vi.fn().mockResolvedValue({ success: true, action: "scale-down", serviceName: "api-service", details: "Scaled down" }),
      validateCredential: vi.fn(),
      getDefaultThresholds: vi.fn(),
    };

    vi.mocked(CloudAccountModel.find).mockResolvedValue([
      { _id: "acc1", provider: "gcp", credentialId: "cred1", thresholds: {}, protectedServices: [], autoDisconnect: true, autoDelete: false, guardianAccountId: "ga1", name: "GCP Prod" },
    ] as any);

    vi.mocked(getCredential).mockResolvedValue({ provider: "gcp", serviceAccountJson: "{}", projectId: "proj-123" });
    vi.mocked(getProvider).mockReturnValue(mockProvider);
    vi.mocked(GuardianAccountModel.findById).mockResolvedValue({ alertChannels: [] } as any);
    vi.mocked(CloudAccountModel.findByIdAndUpdate).mockResolvedValue(null);

    await runCheckCycle();

    expect(mockProvider.executeKillSwitch).toHaveBeenCalledWith(
      expect.anything(),
      "api-service",
      "scale-down" // GCP uses scale-down
    );
  });

  it("uses stop-instances for AWS provider violations", async () => {
    const mockProvider = {
      id: "aws",
      name: "AWS",
      checkUsage: vi.fn().mockResolvedValue({
        provider: "aws",
        accountId: "1234",
        checkedAt: Date.now(),
        services: [],
        totalEstimatedDailyCostUSD: 0,
        violations: [{
          serviceName: "ec2:i-abc123",
          metricName: "Total Running Instances",
          currentValue: 50,
          threshold: 20,
          unit: "instances",
          severity: "warning",
        }],
      }),
      executeKillSwitch: vi.fn().mockResolvedValue({ success: true, action: "stop-instances", serviceName: "ec2:i-abc123", details: "Stopped" }),
      validateCredential: vi.fn(),
      getDefaultThresholds: vi.fn(),
    };

    vi.mocked(CloudAccountModel.find).mockResolvedValue([
      { _id: "acc1", provider: "aws", credentialId: "cred1", thresholds: {}, protectedServices: [], autoDisconnect: true, autoDelete: false, guardianAccountId: "ga1", name: "AWS Prod" },
    ] as any);

    vi.mocked(getCredential).mockResolvedValue({ provider: "aws", awsAccessKeyId: "AKIA...", awsSecretAccessKey: "secret" });
    vi.mocked(getProvider).mockReturnValue(mockProvider);
    vi.mocked(GuardianAccountModel.findById).mockResolvedValue({ alertChannels: [] } as any);
    vi.mocked(CloudAccountModel.findByIdAndUpdate).mockResolvedValue(null);

    await runCheckCycle();

    expect(mockProvider.executeKillSwitch).toHaveBeenCalledWith(
      expect.anything(),
      "ec2:i-abc123",
      "stop-instances" // AWS uses stop-instances
    );
  });

  it("continues check cycle when PostgreSQL snapshot recording fails", async () => {
    const mockProvider = {
      id: "cloudflare",
      name: "Cloudflare",
      checkUsage: vi.fn().mockResolvedValue({
        provider: "cloudflare", accountId: "test", checkedAt: Date.now(),
        services: [{ serviceName: "worker", metrics: [], estimatedDailyCostUSD: 5 }],
        totalEstimatedDailyCostUSD: 5, violations: [],
      }),
      executeKillSwitch: vi.fn(),
      validateCredential: vi.fn(),
      getDefaultThresholds: vi.fn(),
    };

    vi.mocked(CloudAccountModel.find).mockResolvedValue([
      { _id: "acc1", provider: "cloudflare", credentialId: "cred1", thresholds: {}, protectedServices: [], autoDisconnect: false, autoDelete: false, guardianAccountId: "ga1", name: "Test" },
    ] as any);

    vi.mocked(getCredential).mockResolvedValue({ provider: "cloudflare", apiToken: "tok", accountId: "aid" });
    vi.mocked(getProvider).mockReturnValue(mockProvider);
    vi.mocked(CloudAccountModel.findByIdAndUpdate).mockResolvedValue(null);
    vi.mocked(recordUsageSnapshot).mockRejectedValue(new Error("PG connection refused"));

    const results = await runCheckCycle();

    // Should still succeed despite PG error
    expect(results).toHaveLength(1);
    expect(results[0].status).toBe("ok");
  });

  it("uses auto-delete for critical violations when configured", async () => {
    const mockProvider = {
      id: "cloudflare",
      name: "Cloudflare",
      checkUsage: vi.fn().mockResolvedValue({
        provider: "cloudflare",
        accountId: "test",
        checkedAt: Date.now(),
        services: [],
        totalEstimatedDailyCostUSD: 0,
        violations: [{
          serviceName: "nuke-me",
          metricName: "DO Requests",
          currentValue: 100_000_000,
          threshold: 1_000_000,
          unit: "requests",
          severity: "critical",
        }],
      }),
      executeKillSwitch: vi.fn().mockResolvedValue({ success: true, action: "delete", serviceName: "nuke-me", details: "Deleted" }),
      validateCredential: vi.fn(),
      getDefaultThresholds: vi.fn(),
    };

    vi.mocked(CloudAccountModel.find).mockResolvedValue([
      { _id: "acc1", provider: "cloudflare", credentialId: "cred1", thresholds: {}, protectedServices: [], autoDisconnect: true, autoDelete: true, guardianAccountId: "ga1", name: "Nuclear" },
    ] as any);

    vi.mocked(getCredential).mockResolvedValue({ provider: "cloudflare", apiToken: "tok", accountId: "aid" });
    vi.mocked(getProvider).mockReturnValue(mockProvider);
    vi.mocked(GuardianAccountModel.findById).mockResolvedValue({ alertChannels: [] } as any);
    vi.mocked(CloudAccountModel.findByIdAndUpdate).mockResolvedValue(null);

    await runCheckCycle();

    expect(mockProvider.executeKillSwitch).toHaveBeenCalledWith(
      expect.anything(),
      "nuke-me",
      "delete" // Nuclear mode
    );
  });
});
