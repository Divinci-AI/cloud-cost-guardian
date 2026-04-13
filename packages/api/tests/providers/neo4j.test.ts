import { describe, it, expect, vi, beforeEach } from "vitest";
import { neo4jProvider } from "../../src/providers/neo4j/checker.js";
import type { DecryptedCredential, ThresholdConfig } from "../../src/providers/types.js";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

const CRED: DecryptedCredential = {
  provider: "neo4j",
  neo4jClientId: "test-client-id",
  neo4jClientSecret: "test-client-secret",
};

const CRED_WITH_INSTANCE: DecryptedCredential = {
  provider: "neo4j",
  neo4jClientId: "test-client-id",
  neo4jClientSecret: "test-client-secret",
  neo4jInstanceId: "9c96c178",
};

const DEFAULT_THRESHOLDS: ThresholdConfig = {
  neo4jInstanceCount: 3,
  neo4jMemoryGB: 8,
  neo4jStorageGB: 16,
  neo4jDailyCostUSD: 20,
  monthlySpendLimitUSD: 600,
};

const MOCK_TOKEN_RESPONSE = { access_token: "eyJhbGciOiJSUzI1NiJ9.test-token", expires_in: 3600, token_type: "Bearer" };

const MOCK_INSTANCE = {
  id: "9c96c178",
  name: "My instance",
  status: "running",
  type: "professional-db",
  memory: "2GB",
  storage: "4GB",
  cloud_provider: "gcp",
  region: "us-west1",
  tenant_id: "e0a00631-test",
};

const MOCK_INSTANCE_PAUSED = {
  ...MOCK_INSTANCE,
  id: "abc12345",
  name: "Dev instance",
  status: "paused",
  memory: "1GB",
  storage: "2GB",
};

function mockOk(data: any) {
  return Promise.resolve({
    ok: true,
    text: () => Promise.resolve(JSON.stringify(data)),
    json: () => Promise.resolve(data),
  });
}

function mockOkEmpty() {
  return Promise.resolve({
    ok: true,
    text: () => Promise.resolve(""),
    json: () => Promise.reject(new SyntaxError("Unexpected end of JSON input")),
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

/** First call is always OAuth token exchange */
function mockTokenThen(...responses: Promise<any>[]) {
  mockFetch.mockResolvedValueOnce(mockOk(MOCK_TOKEN_RESPONSE));
  for (const r of responses) mockFetch.mockResolvedValueOnce(r);
}

beforeEach(() => {
  mockFetch.mockReset();
});

// ─── OAuth Token Exchange ────────────────────────────────────────────────

describe("neo4jProvider — OAuth2 token exchange", () => {
  it("sends Basic auth header with client credentials", async () => {
    mockTokenThen(mockOk({ data: [MOCK_INSTANCE] }));

    await neo4jProvider.checkUsage(CRED, DEFAULT_THRESHOLDS);

    // First call should be to /oauth/token
    const [tokenUrl, tokenOpts] = mockFetch.mock.calls[0];
    expect(tokenUrl).toBe("https://api.neo4j.io/oauth/token");
    expect(tokenOpts.method).toBe("POST");
    expect(tokenOpts.headers["Authorization"]).toMatch(/^Basic /);
    expect(tokenOpts.body).toBe("grant_type=client_credentials");

    // Decode Basic auth
    const base64 = tokenOpts.headers["Authorization"].replace("Basic ", "");
    const decoded = Buffer.from(base64, "base64").toString();
    expect(decoded).toBe("test-client-id:test-client-secret");
  });

  it("uses bearer token for subsequent API calls", async () => {
    mockTokenThen(mockOk({ data: [MOCK_INSTANCE] }));

    await neo4jProvider.checkUsage(CRED, DEFAULT_THRESHOLDS);

    const [, apiOpts] = mockFetch.mock.calls[1];
    expect(apiOpts.headers.Authorization).toBe(`Bearer ${MOCK_TOKEN_RESPONSE.access_token}`);
  });

  it("throws descriptive error on OAuth failure", async () => {
    mockFetch.mockResolvedValueOnce(mockErr(401, "invalid_client"));

    const result = await neo4jProvider.validateCredential(CRED);
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/OAuth error 401/);
  });
});

// ─── checkUsage ──────────────────────────────────────────────────────────

describe("neo4jProvider.checkUsage", () => {
  it("fetches all instances when no instanceId given", async () => {
    mockTokenThen(mockOk({ data: [MOCK_INSTANCE, MOCK_INSTANCE_PAUSED] }));

    const result = await neo4jProvider.checkUsage(CRED, DEFAULT_THRESHOLDS);
    expect(result.provider).toBe("neo4j");
    // summary + 2 instances
    expect(result.services).toHaveLength(3);
    expect(result.services[0].serviceName).toBe("neo4j:summary");
    expect(result.services[1].serviceName).toBe("neo4j:9c96c178");
    expect(result.services[2].serviceName).toBe("neo4j:abc12345");
  });

  it("fetches single instance when instanceId given", async () => {
    mockTokenThen(mockOk({ data: MOCK_INSTANCE }));

    const result = await neo4jProvider.checkUsage(CRED_WITH_INSTANCE, DEFAULT_THRESHOLDS);
    // No summary for single instance
    expect(result.services).toHaveLength(1);
    expect(result.services[0].serviceName).toBe("neo4j:9c96c178");
    expect(result.accountId).toBe("9c96c178");
  });

  it("parses memory and storage from string values", async () => {
    mockTokenThen(mockOk({ data: MOCK_INSTANCE }));

    const result = await neo4jProvider.checkUsage(CRED_WITH_INSTANCE, DEFAULT_THRESHOLDS);
    const svc = result.services[0];
    const mem = svc.metrics.find(m => m.name === "Memory");
    const storage = svc.metrics.find(m => m.name === "Storage");
    expect(mem?.value).toBe(2);
    expect(mem?.unit).toBe("GB");
    expect(storage?.value).toBe(4);
    expect(storage?.unit).toBe("GB");
  });

  it("tracks running instance count in summary", async () => {
    mockTokenThen(mockOk({ data: [MOCK_INSTANCE, MOCK_INSTANCE_PAUSED] }));

    const result = await neo4jProvider.checkUsage(CRED, DEFAULT_THRESHOLDS);
    const summary = result.services[0];
    const running = summary.metrics.find(m => m.name === "Running Instances");
    const total = summary.metrics.find(m => m.name === "Total Instances");
    expect(running?.value).toBe(1);  // Only MOCK_INSTANCE is "running"
    expect(total?.value).toBe(2);
  });

  it("sets status metric based on instance state", async () => {
    mockTokenThen(mockOk({ data: MOCK_INSTANCE }));

    const result = await neo4jProvider.checkUsage(CRED_WITH_INSTANCE, DEFAULT_THRESHOLDS);
    const status = result.services[0].metrics.find(m => m.name === "Status");
    expect(status?.value).toBe(1); // running = 1
    expect(status?.unit).toBe("running");
  });

  it("estimates daily cost for running instances", async () => {
    mockTokenThen(mockOk({ data: MOCK_INSTANCE }));

    const result = await neo4jProvider.checkUsage(CRED_WITH_INSTANCE, DEFAULT_THRESHOLDS);
    expect(result.totalEstimatedDailyCostUSD).toBeGreaterThan(0);
    expect(result.services[0].estimatedDailyCostUSD).toBeGreaterThan(0);
  });

  it("sets zero cost for paused instances", async () => {
    mockTokenThen(mockOk({ data: MOCK_INSTANCE_PAUSED }));

    const cred = { ...CRED, neo4jInstanceId: "abc12345" };
    const result = await neo4jProvider.checkUsage(cred, DEFAULT_THRESHOLDS);
    expect(result.services[0].estimatedDailyCostUSD).toBe(0);
    expect(result.totalEstimatedDailyCostUSD).toBe(0);
  });

  it("returns no violations when under thresholds", async () => {
    mockTokenThen(mockOk({ data: MOCK_INSTANCE }));

    const result = await neo4jProvider.checkUsage(CRED_WITH_INSTANCE, DEFAULT_THRESHOLDS);
    expect(result.violations).toHaveLength(0);
  });

  it("returns violation when memory exceeds threshold", async () => {
    const bigInstance = { ...MOCK_INSTANCE, memory: "16GB" };
    mockTokenThen(mockOk({ data: bigInstance }));

    const result = await neo4jProvider.checkUsage(CRED_WITH_INSTANCE, DEFAULT_THRESHOLDS);
    const memViolation = result.violations.find(v => v.metricName === "Memory");
    expect(memViolation).toBeDefined();
    expect(memViolation!.currentValue).toBe(16);
    expect(memViolation!.threshold).toBe(8);
  });

  it("returns violation when storage exceeds threshold", async () => {
    const bigStorage = { ...MOCK_INSTANCE, storage: "32GB" };
    mockTokenThen(mockOk({ data: bigStorage }));

    const result = await neo4jProvider.checkUsage(CRED_WITH_INSTANCE, DEFAULT_THRESHOLDS);
    const storageViolation = result.violations.find(v => v.metricName === "Storage");
    expect(storageViolation).toBeDefined();
    expect(storageViolation!.severity).toBe("critical"); // 32 >= 16*2
  });

  it("returns cost violation when daily cost exceeds threshold", async () => {
    // Enterprise tier with high memory → high cost
    const expensive = { ...MOCK_INSTANCE, memory: "64GB" };
    mockTokenThen(mockOk({ data: expensive }));

    const lowThresholds = { ...DEFAULT_THRESHOLDS, neo4jDailyCostUSD: 1 };
    const result = await neo4jProvider.checkUsage(CRED_WITH_INSTANCE, lowThresholds);
    const costViolation = result.violations.find(v => v.metricName === "Daily Cost");
    expect(costViolation).toBeDefined();
    expect(costViolation!.unit).toBe("USD");
  });

  it("handles empty instance list", async () => {
    mockTokenThen(mockOk({ data: [] }));

    const result = await neo4jProvider.checkUsage(CRED, DEFAULT_THRESHOLDS);
    // Summary (0 running) + no instances
    expect(result.services).toHaveLength(1); // just summary
    expect(result.violations).toHaveLength(0);
  });

  it("includes type and region info in metrics", async () => {
    mockTokenThen(mockOk({ data: MOCK_INSTANCE }));

    const result = await neo4jProvider.checkUsage(CRED_WITH_INSTANCE, DEFAULT_THRESHOLDS);
    const typeMetric = result.services[0].metrics.find(m => m.name === "Type");
    expect(typeMetric?.unit).toContain("professional-db");
    expect(typeMetric?.unit).toContain("gcp");
    expect(typeMetric?.unit).toContain("us-west1");
  });
});

// ─── validateCredential ──────────────────────────────────────────────────

describe("neo4jProvider.validateCredential", () => {
  it("returns invalid when client ID missing", async () => {
    const result = await neo4jProvider.validateCredential({ provider: "neo4j" });
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/client/i);
  });

  it("returns invalid when client secret missing", async () => {
    const result = await neo4jProvider.validateCredential({ provider: "neo4j", neo4jClientId: "id" });
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/client/i);
  });

  it("returns valid with instance count when no instanceId given", async () => {
    mockTokenThen(mockOk({ data: [MOCK_INSTANCE, MOCK_INSTANCE_PAUSED] }));

    const result = await neo4jProvider.validateCredential(CRED);
    expect(result.valid).toBe(true);
    expect(result.accountId).toBe("neo4j-aura");
    expect(result.accountName).toContain("2 instances");
  });

  it("returns valid with instance details when instanceId given", async () => {
    mockTokenThen(mockOk({ data: MOCK_INSTANCE }));

    const result = await neo4jProvider.validateCredential(CRED_WITH_INSTANCE);
    expect(result.valid).toBe(true);
    expect(result.accountId).toBe("9c96c178");
    expect(result.accountName).toContain("My instance");
    expect(result.accountName).toContain("professional-db");
    expect(result.accountName).toContain("2GB");
  });

  it("returns invalid on 401 (bad credentials)", async () => {
    mockFetch.mockResolvedValueOnce(mockErr(401, "invalid_client"));

    const result = await neo4jProvider.validateCredential(CRED);
    expect(result.valid).toBe(false);
    expect(result.error).toBeDefined();
  });

  it("returns invalid on network error", async () => {
    mockFetch.mockRejectedValueOnce(new Error("ECONNREFUSED"));

    const result = await neo4jProvider.validateCredential(CRED);
    expect(result.valid).toBe(false);
    expect(result.error).toContain("ECONNREFUSED");
  });

  it("handles singular instance grammar", async () => {
    mockTokenThen(mockOk({ data: [MOCK_INSTANCE] }));

    const result = await neo4jProvider.validateCredential(CRED);
    expect(result.accountName).toContain("1 instance");
    expect(result.accountName).not.toContain("1 instances");
  });
});

// ─── executeKillSwitch ───────────────────────────────────────────────────

describe("neo4jProvider.executeKillSwitch", () => {
  it("pauses instance on pause-cluster action", async () => {
    mockTokenThen(mockOk({ data: { ...MOCK_INSTANCE, status: "pausing" } }));

    const result = await neo4jProvider.executeKillSwitch(CRED_WITH_INSTANCE, "neo4j:9c96c178", "pause-cluster");
    expect(result.success).toBe(true);
    expect(result.action).toBe("pause-cluster");
    expect(result.details).toContain("paused");

    // Verify POST to /instances/{id}/pause
    const [pauseUrl, pauseOpts] = mockFetch.mock.calls[1]; // [0] is token
    expect(pauseUrl).toBe("https://api.neo4j.io/v1/instances/9c96c178/pause");
    expect(pauseOpts.method).toBe("POST");
  });

  it("handles empty body response from pause endpoint", async () => {
    mockTokenThen(mockOkEmpty());

    const result = await neo4jProvider.executeKillSwitch(CRED_WITH_INSTANCE, "neo4j:9c96c178", "pause-cluster");
    expect(result.success).toBe(true);
  });

  it("scales down instance to 2GB", async () => {
    mockTokenThen(mockOk({ data: { ...MOCK_INSTANCE, memory: "2GB" } }));

    const result = await neo4jProvider.executeKillSwitch(CRED_WITH_INSTANCE, "neo4j:9c96c178", "scale-down");
    expect(result.success).toBe(true);
    expect(result.details).toContain("2GB");

    // Verify PATCH to /instances/{id}
    const [patchUrl, patchOpts] = mockFetch.mock.calls[1];
    expect(patchUrl).toBe("https://api.neo4j.io/v1/instances/9c96c178");
    expect(patchOpts.method).toBe("PATCH");
    expect(JSON.parse(patchOpts.body)).toEqual({ memory: "2GB" });
  });

  it("deletes instance on delete action", async () => {
    mockTokenThen(mockOk({ data: { ...MOCK_INSTANCE, status: "destroying" } }));

    const result = await neo4jProvider.executeKillSwitch(CRED_WITH_INSTANCE, "neo4j:9c96c178", "delete");
    expect(result.success).toBe(true);
    expect(result.details).toContain("destroyed");

    const [deleteUrl, deleteOpts] = mockFetch.mock.calls[1];
    expect(deleteUrl).toBe("https://api.neo4j.io/v1/instances/9c96c178");
    expect(deleteOpts.method).toBe("DELETE");
  });

  it("handles empty body response from delete endpoint", async () => {
    mockTokenThen(mockOkEmpty());

    const result = await neo4jProvider.executeKillSwitch(CRED_WITH_INSTANCE, "neo4j:9c96c178", "delete");
    expect(result.success).toBe(true);
  });

  it("returns failure for unsupported action", async () => {
    mockTokenThen(); // token still needed for init

    const result = await neo4jProvider.executeKillSwitch(CRED_WITH_INSTANCE, "neo4j:9c96c178", "flush-redis");
    expect(result.success).toBe(false);
    expect(result.details).toContain("not supported");
    expect(result.details).toContain("pause-cluster");
  });

  it("returns failure when targeting summary service", async () => {
    mockTokenThen();

    const result = await neo4jProvider.executeKillSwitch(CRED, "neo4j:summary", "pause-cluster");
    expect(result.success).toBe(false);
    expect(result.details).toContain("summary");
  });

  it("returns failure when pause API errors", async () => {
    mockTokenThen(mockErr(409, "Instance is already pausing"));

    const result = await neo4jProvider.executeKillSwitch(CRED_WITH_INSTANCE, "neo4j:9c96c178", "pause-cluster");
    expect(result.success).toBe(false);
    expect(result.details).toContain("409");
  });

  it("returns failure when scale-down API errors", async () => {
    mockTokenThen(mockErr(422, "Cannot resize to requested size"));

    const result = await neo4jProvider.executeKillSwitch(CRED_WITH_INSTANCE, "neo4j:9c96c178", "scale-down");
    expect(result.success).toBe(false);
  });

  it("strips neo4j: prefix from serviceName to get instanceId", async () => {
    mockTokenThen(mockOk({ data: { ...MOCK_INSTANCE, status: "pausing" } }));

    await neo4jProvider.executeKillSwitch(CRED_WITH_INSTANCE, "neo4j:9c96c178", "pause-cluster");

    const [pauseUrl] = mockFetch.mock.calls[1];
    expect(pauseUrl).toContain("/instances/9c96c178/pause");
    expect(pauseUrl).not.toContain("neo4j:");
  });
});

// ─── getDefaultThresholds ────────────────────────────────────────────────

describe("neo4jProvider.getDefaultThresholds", () => {
  it("returns sensible defaults", () => {
    const t = neo4jProvider.getDefaultThresholds();
    expect(t.neo4jInstanceCount).toBeGreaterThan(0);
    expect(t.neo4jMemoryGB).toBeGreaterThan(0);
    expect(t.neo4jStorageGB).toBeGreaterThan(0);
    expect(t.neo4jDailyCostUSD).toBeGreaterThan(0);
    expect(t.monthlySpendLimitUSD).toBeGreaterThan(0);
  });

  it("all values are numbers", () => {
    const t = neo4jProvider.getDefaultThresholds();
    for (const [, value] of Object.entries(t)) {
      if (value !== undefined) expect(typeof value).toBe("number");
    }
  });
});
