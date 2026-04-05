import { describe, it, expect, vi, beforeEach } from "vitest";
import { neonProvider } from "../../src/providers/neon/checker.js";
import type { DecryptedCredential, ThresholdConfig } from "../../src/providers/types.js";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

const CRED: DecryptedCredential = {
  provider: "neon",
  neonApiKey: "neon_test_key",
};

const CRED_WITH_PROJECT: DecryptedCredential = {
  provider: "neon",
  neonApiKey: "neon_test_key",
  neonProjectId: "icy-night-79929587",
};

const DEFAULT_THRESHOLDS: ThresholdConfig = {
  neonComputeHoursPerMonth: 80,
  neonStorageMB: 400,
  neonDataTransferGB: 4,
  neonDailyCostUSD: 1.00,
  monthlySpendLimitUSD: 30,
};

const MOCK_PROJECT = {
  id: "icy-night-79929587",
  name: "test-project",
  plan: "free_v2",
  settings: { plan: "free_v2" },
};

const MOCK_CONSUMPTION = {
  projects: [{
    project_id: "icy-night-79929587",
    periods: [{
      compute_time_seconds: 7200,     // 2 hours
      data_transfer_bytes: 536870912, // 0.5 GB
      synthetic_storage_size_bytes: 104857600, // 100 MB
    }],
  }],
};

function mockOk(data: any) {
  return Promise.resolve({
    ok: true,
    json: () => Promise.resolve(data),
    text: () => Promise.resolve(JSON.stringify(data)),
  });
}

function mockErr(status: number, body = "error") {
  return Promise.resolve({
    ok: false,
    status,
    text: () => Promise.resolve(body),
    json: () => Promise.resolve({ error: body }),
  });
}

beforeEach(() => {
  mockFetch.mockReset();
});

describe("neonProvider.checkUsage", () => {
  it("fetches all projects when no projectId given", async () => {
    mockFetch
      .mockResolvedValueOnce(mockOk({ projects: [MOCK_PROJECT] }))  // /projects
      .mockResolvedValueOnce(mockOk(MOCK_CONSUMPTION));              // /consumption_history/projects

    const result = await neonProvider.checkUsage(CRED, DEFAULT_THRESHOLDS);
    expect(result.provider).toBe("neon");
    expect(result.services).toHaveLength(1);
    expect(result.services[0].serviceName).toBe("neon:icy-night-79929587");
  });

  it("fetches single project when projectId given", async () => {
    mockFetch
      .mockResolvedValueOnce(mockOk({ project: MOCK_PROJECT }))     // /projects/:id
      .mockResolvedValueOnce(mockOk(MOCK_CONSUMPTION));              // /consumption_history/projects

    const result = await neonProvider.checkUsage(CRED_WITH_PROJECT, DEFAULT_THRESHOLDS);
    expect(result.services).toHaveLength(1);
    expect(result.accountId).toBe("icy-night-79929587");
  });

  it("maps compute hours correctly", async () => {
    mockFetch
      .mockResolvedValueOnce(mockOk({ projects: [MOCK_PROJECT] }))
      .mockResolvedValueOnce(mockOk(MOCK_CONSUMPTION));

    const result = await neonProvider.checkUsage(CRED, DEFAULT_THRESHOLDS);
    const svc = result.services[0];
    const compute = svc.metrics.find(m => m.name === "Compute");
    expect(compute?.value).toBeCloseTo(2.0, 1); // 7200s = 2 CU-hrs
    expect(compute?.unit).toBe("CU-hrs");
  });

  it("maps storage correctly", async () => {
    mockFetch
      .mockResolvedValueOnce(mockOk({ projects: [MOCK_PROJECT] }))
      .mockResolvedValueOnce(mockOk(MOCK_CONSUMPTION));

    const result = await neonProvider.checkUsage(CRED, DEFAULT_THRESHOLDS);
    const svc = result.services[0];
    const storage = svc.metrics.find(m => m.name === "Storage");
    expect(storage?.value).toBeCloseTo(100.0, 0); // 100 MB
    expect(storage?.unit).toBe("MB");
  });

  it("sets dailyCost to 0 for free plan", async () => {
    mockFetch
      .mockResolvedValueOnce(mockOk({ projects: [MOCK_PROJECT] }))
      .mockResolvedValueOnce(mockOk(MOCK_CONSUMPTION));

    const result = await neonProvider.checkUsage(CRED, DEFAULT_THRESHOLDS);
    expect(result.services[0].estimatedDailyCostUSD).toBe(0);
    expect(result.totalEstimatedDailyCostUSD).toBe(0);
  });

  it("calculates cost for paid plan", async () => {
    const paidProject = { ...MOCK_PROJECT, plan: "launch", settings: { plan: "launch" } };
    mockFetch
      .mockResolvedValueOnce(mockOk({ projects: [paidProject] }))
      .mockResolvedValueOnce(mockOk(MOCK_CONSUMPTION));

    const result = await neonProvider.checkUsage(CRED, DEFAULT_THRESHOLDS);
    expect(result.services[0].estimatedDailyCostUSD).toBeGreaterThan(0);
  });

  it("returns no violations when usage is within thresholds", async () => {
    mockFetch
      .mockResolvedValueOnce(mockOk({ projects: [MOCK_PROJECT] }))
      .mockResolvedValueOnce(mockOk(MOCK_CONSUMPTION));

    const result = await neonProvider.checkUsage(CRED, DEFAULT_THRESHOLDS);
    expect(result.violations).toHaveLength(0);
  });

  it("returns violation when compute hours exceed threshold", async () => {
    const heavyConsumption = {
      projects: [{
        project_id: "icy-night-79929587",
        periods: [{
          compute_time_seconds: 360000, // 100 CU-hrs (over 80 threshold)
          data_transfer_bytes: 0,
          synthetic_storage_size_bytes: 0,
        }],
      }],
    };
    mockFetch
      .mockResolvedValueOnce(mockOk({ projects: [MOCK_PROJECT] }))
      .mockResolvedValueOnce(mockOk(heavyConsumption));

    const result = await neonProvider.checkUsage(CRED, DEFAULT_THRESHOLDS);
    const computeViolation = result.violations.find((v: any) => v.metricName === "Compute");
    expect(computeViolation).toBeDefined();
    expect(computeViolation.currentValue).toBeGreaterThan(DEFAULT_THRESHOLDS.neonComputeHoursPerMonth!);
  });

  it("falls back to project fields when consumption API fails", async () => {
    const projectWithUsage = {
      ...MOCK_PROJECT,
      compute_time_seconds: 3600,
      data_transfer_bytes: 1073741824,
      synthetic_storage_size_bytes: 52428800,
    };
    mockFetch
      .mockResolvedValueOnce(mockOk({ projects: [projectWithUsage] }))
      .mockResolvedValueOnce(mockErr(403, "forbidden"));

    const result = await neonProvider.checkUsage(CRED, DEFAULT_THRESHOLDS);
    expect(result.services).toHaveLength(1);
    const compute = result.services[0].metrics.find(m => m.name === "Compute");
    expect(compute?.value).toBeCloseTo(1.0, 1); // 3600s = 1 CU-hr
  });

  it("handles empty project list", async () => {
    mockFetch
      .mockResolvedValueOnce(mockOk({ projects: [] }))
      .mockResolvedValueOnce(mockOk({ projects: [] }));

    const result = await neonProvider.checkUsage(CRED, DEFAULT_THRESHOLDS);
    expect(result.services).toHaveLength(0);
    expect(result.violations).toHaveLength(0);
  });
});

describe("neonProvider.validateCredential", () => {
  it("returns invalid when API key missing", async () => {
    const result = await neonProvider.validateCredential({ provider: "neon" });
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/api key/i);
  });

  it("returns valid with project count when no projectId given", async () => {
    mockFetch.mockResolvedValueOnce(mockOk({ projects: [MOCK_PROJECT, MOCK_PROJECT] }));
    const result = await neonProvider.validateCredential(CRED);
    expect(result.valid).toBe(true);
    expect(result.accountName).toContain("2 projects");
  });

  it("returns valid with project name when projectId given", async () => {
    mockFetch.mockResolvedValueOnce(mockOk({ project: MOCK_PROJECT }));
    const result = await neonProvider.validateCredential(CRED_WITH_PROJECT);
    expect(result.valid).toBe(true);
    expect(result.accountId).toBe("icy-night-79929587");
    expect(result.accountName).toContain("test-project");
  });

  it("returns invalid on 401", async () => {
    mockFetch.mockResolvedValueOnce(mockErr(401, "Unauthorized"));
    const result = await neonProvider.validateCredential(CRED);
    expect(result.valid).toBe(false);
    expect(result.error).toBeDefined();
  });
});

describe("neonProvider.executeKillSwitch", () => {
  it("suspends endpoints on scale-down", async () => {
    const endpoints = {
      endpoints: [
        { id: "ep-1", type: "read_write" },
        { id: "ep-2", type: "read_only" },
      ],
    };
    mockFetch
      .mockResolvedValueOnce(mockOk(endpoints))         // GET endpoints
      .mockResolvedValueOnce(mockOk({}))                // PATCH ep-1
      .mockResolvedValueOnce(mockOk({}));               // PATCH ep-2

    const result = await neonProvider.executeKillSwitch(CRED_WITH_PROJECT, "neon:icy-night-79929587", "scale-down");
    expect(result.success).toBe(true);
    expect(result.details).toContain("2");
  });

  it("deletes project on delete action", async () => {
    mockFetch.mockResolvedValueOnce(mockOk({}));

    const result = await neonProvider.executeKillSwitch(CRED_WITH_PROJECT, "neon:icy-night-79929587", "delete");
    expect(result.success).toBe(true);
    expect(result.details).toContain("Deleted");
  });

  it("returns failure for unsupported action", async () => {
    const result = await neonProvider.executeKillSwitch(CRED_WITH_PROJECT, "neon:icy-night-79929587", "pause");
    expect(result.success).toBe(false);
    expect(result.details).toContain("not supported");
  });

  it("returns failure when scale-down API errors", async () => {
    mockFetch.mockResolvedValueOnce(mockErr(500, "internal error"));

    const result = await neonProvider.executeKillSwitch(CRED_WITH_PROJECT, "neon:icy-night-79929587", "scale-down");
    expect(result.success).toBe(false);
  });
});

describe("neonProvider.getDefaultThresholds", () => {
  it("returns sensible free-tier defaults", () => {
    const t = neonProvider.getDefaultThresholds!();
    expect(t.neonComputeHoursPerMonth).toBeLessThanOrEqual(100); // free tier = 100 CU-hrs
    expect(t.neonStorageMB).toBeLessThanOrEqual(512);            // free tier = 512 MB
    expect(t.neonDataTransferGB).toBeLessThanOrEqual(5);         // free tier = 5 GB
    expect(t.neonDailyCostUSD).toBeGreaterThan(0);
  });
});
