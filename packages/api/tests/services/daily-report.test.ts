/**
 * Daily Report Service Tests
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock external dependencies
vi.mock("../../src/models/guardian-account/schema.js", () => ({
  GuardianAccountModel: { find: vi.fn() },
}));
vi.mock("../../src/models/cloud-account/schema.js", () => ({
  CloudAccountModel: { find: vi.fn() },
}));
vi.mock("../../src/globals/index.js", () => ({
  isMongoEnabled: vi.fn(() => false),
  isMongoConnected: vi.fn(() => true),
  getAnalyticsOverview: vi.fn(),
  getAlertHistory: vi.fn(),
}));
vi.mock("resend", () => ({
  Resend: vi.fn().mockImplementation(() => ({
    emails: { send: vi.fn().mockResolvedValue({ error: null }) },
  })),
}));

import { sendDailyReports } from "../../src/services/daily-report.js";
import { GuardianAccountModel } from "../../src/models/guardian-account/schema.js";
import { CloudAccountModel } from "../../src/models/cloud-account/schema.js";
import { getAnalyticsOverview, getAlertHistory } from "../../src/globals/index.js";

const mockOrg = {
  _id: { toString: () => "org1" },
  name: "My Org",
  settings: { dailyReportEnabled: true, timezone: "UTC" },
  alertChannels: [{ type: "email", name: "Email", enabled: true, config: { email: "admin@example.com" } }],
};

const mockAnalytics = {
  dailyCosts: [{ date: "2026-04-05", cost: 12.34, violations: 1, services: 3 }],
  totalSpendPeriod: 12.34,
  avgDailyCost: 12.34,
  projectedMonthlyCost: 370,
  savingsEstimate: 36,
  killSwitchActions: 1,
  accountBreakdown: [{ cloudAccountId: "ca1", provider: "aws", totalCost: 12.34, avgDailyCost: 12.34 }],
};

const mockCloudAccount = {
  _id: { toString: () => "ca1" },
  name: "Production AWS",
  provider: "aws",
  lastCheckStatus: "ok",
};

describe("sendDailyReports", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.RESEND_API_KEY = "re_test";
  });

  it("skips when no accounts have dailyReportEnabled", async () => {
    vi.mocked(GuardianAccountModel.find).mockResolvedValue([]);
    await sendDailyReports();
    expect(GuardianAccountModel.find).toHaveBeenCalledWith({ "settings.dailyReportEnabled": true });
  });

  it("skips when RESEND_API_KEY is missing", async () => {
    delete process.env.RESEND_API_KEY;
    vi.mocked(GuardianAccountModel.find).mockResolvedValue([mockOrg]);
    await sendDailyReports(); // should not throw
  });

  it("sends email to all enabled email channels", async () => {
    vi.mocked(GuardianAccountModel.find).mockResolvedValue([mockOrg]);
    vi.mocked(CloudAccountModel.find).mockResolvedValue([mockCloudAccount]);
    vi.mocked(getAnalyticsOverview).mockResolvedValue(mockAnalytics);
    vi.mocked(getAlertHistory).mockResolvedValue([]);

    const { Resend } = await import("resend");
    const mockSend = vi.fn().mockResolvedValue({ error: null });
    vi.mocked(Resend).mockImplementation(() => ({ emails: { send: mockSend } }) as any);

    await sendDailyReports();

    expect(mockSend).toHaveBeenCalledOnce();
    const call = mockSend.mock.calls[0][0];
    expect(call.to).toContain("admin@example.com");
    expect(call.subject).toContain("violation");
    expect(call.html).toContain("12.34");
  });

  it("includes all-clear subject when no violations", async () => {
    const noViolationsAnalytics = {
      ...mockAnalytics,
      dailyCosts: [{ date: "2026-04-05", cost: 5.00, violations: 0, services: 2 }],
      killSwitchActions: 0,
    };
    vi.mocked(GuardianAccountModel.find).mockResolvedValue([mockOrg]);
    vi.mocked(CloudAccountModel.find).mockResolvedValue([mockCloudAccount]);
    vi.mocked(getAnalyticsOverview).mockResolvedValue(noViolationsAnalytics);
    vi.mocked(getAlertHistory).mockResolvedValue([]);

    const { Resend } = await import("resend");
    const mockSend = vi.fn().mockResolvedValue({ error: null });
    vi.mocked(Resend).mockImplementation(() => ({ emails: { send: mockSend } }) as any);

    await sendDailyReports();

    const call = mockSend.mock.calls[0][0];
    expect(call.subject).toContain("All clear");
  });

  it("skips account with no email channels configured", async () => {
    const noEmailOrg = { ...mockOrg, alertChannels: [] };
    vi.mocked(GuardianAccountModel.find).mockResolvedValue([noEmailOrg]);
    vi.mocked(CloudAccountModel.find).mockResolvedValue([]);
    vi.mocked(getAnalyticsOverview).mockResolvedValue(mockAnalytics);
    vi.mocked(getAlertHistory).mockResolvedValue([]);

    const { Resend } = await import("resend");
    const mockSend = vi.fn().mockResolvedValue({ error: null });
    vi.mocked(Resend).mockImplementation(() => ({ emails: { send: mockSend } }) as any);

    await sendDailyReports();
    expect(mockSend).not.toHaveBeenCalled();
  });

  it("continues with other accounts if one fails", async () => {
    const org2 = {
      ...mockOrg,
      _id: { toString: () => "org2" },
      name: "Org 2",
      alertChannels: [{ type: "email", name: "Email", enabled: true, config: { email: "other@example.com" } }],
    };
    vi.mocked(GuardianAccountModel.find).mockResolvedValue([mockOrg, org2]);
    vi.mocked(CloudAccountModel.find)
      .mockRejectedValueOnce(new Error("DB error"))  // first org fails
      .mockResolvedValueOnce([mockCloudAccount]);      // second org succeeds
    vi.mocked(getAnalyticsOverview).mockResolvedValue(mockAnalytics);
    vi.mocked(getAlertHistory).mockResolvedValue([]);

    const { Resend } = await import("resend");
    const mockSend = vi.fn().mockResolvedValue({ error: null });
    vi.mocked(Resend).mockImplementation(() => ({ emails: { send: mockSend } }) as any);

    await expect(sendDailyReports()).resolves.not.toThrow();
    // Should still attempt the second account
    expect(mockSend).toHaveBeenCalledOnce();
  });
});
