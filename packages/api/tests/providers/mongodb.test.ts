import { describe, it, expect, vi, beforeEach } from "vitest";
import { mongodbProvider } from "../../src/providers/mongodb/checker.js";
import type { DecryptedCredential, ThresholdConfig } from "../../src/providers/types.js";

// Mock fetch globally (for Atlas API)
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

// Mock mongodb driver
const mockDb = {
  admin: vi.fn().mockReturnValue({
    serverStatus: vi.fn().mockResolvedValue({
      connections: { current: 45, available: 200 },
      opcounters: { insert: 1000, query: 5000, update: 2000, delete: 500, command: 1500 },
      uptime: 3600,
      mem: { resident: 512 },
    }),
    serverInfo: vi.fn().mockResolvedValue({ version: "7.0.5" }),
    listDatabases: vi.fn().mockResolvedValue({ databases: [{ name: "app" }, { name: "admin" }, { name: "test" }] }),
    command: vi.fn().mockResolvedValue({ inprog: [] }),
  }),
  stats: vi.fn().mockResolvedValue({
    dataSize: 1073741824, // 1GB
    indexSize: 268435456,  // 256MB
    collections: 25,
  }),
  dropDatabase: vi.fn().mockResolvedValue(true),
};

vi.mock("mongodb", () => ({
  MongoClient: vi.fn().mockImplementation(() => ({
    connect: vi.fn().mockResolvedValue(undefined),
    db: vi.fn().mockReturnValue(mockDb),
    close: vi.fn().mockResolvedValue(undefined),
  })),
}));

const defaultThresholds: ThresholdConfig = mongodbProvider.getDefaultThresholds();

// ─── Tests ────────────────────────────────────────────────────────────────

describe("MongoDB Provider", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("getDefaultThresholds", () => {
    it("returns production-friendly defaults", () => {
      const t = mongodbProvider.getDefaultThresholds();
      expect(t.mongodbStorageSizeGB).toBe(500);
      expect(t.mongodbActiveConnections).toBe(1000);
      expect(t.mongodbOpsPerSec).toBe(10000);
      expect(t.mongodbCollectionCount).toBe(1000);
      expect(t.mongodbDailyCostUSD).toBe(100);
      expect(t.monthlySpendLimitUSD).toBe(3000);
    });
  });

  describe("validateCredential", () => {
    it("validates Atlas credentials", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ results: [{ name: "Cluster0", providerSettings: { instanceSizeName: "M30" } }] }),
      });

      const result = await mongodbProvider.validateCredential({
        provider: "mongodb",
        mongodbSubType: "atlas",
        atlasPublicKey: "pub-key",
        atlasPrivateKey: "priv-key",
        atlasProjectId: "project-123",
        atlasClusterName: "Cluster0",
      });

      expect(result.valid).toBe(true);
      expect(result.accountId).toBe("project-123");
      expect(result.accountName).toContain("Atlas");
      expect(result.accountName).toContain("M30");
    });

    it("rejects missing Atlas keys", async () => {
      const result = await mongodbProvider.validateCredential({
        provider: "mongodb",
        mongodbSubType: "atlas",
      });
      expect(result.valid).toBe(false);
      expect(result.error).toContain("Missing");
    });

    it("validates self-hosted MongoDB via ping", async () => {
      const result = await mongodbProvider.validateCredential({
        provider: "mongodb",
        mongodbSubType: "self-hosted",
        mongodbUri: "mongodb://user:pass@mongo.example.com:27017/app",
      });
      expect(result.valid).toBe(true);
      expect(result.accountName).toContain("MongoDB 7.0.5");
    });

    it("rejects missing MongoDB URI for self-hosted", async () => {
      const result = await mongodbProvider.validateCredential({
        provider: "mongodb",
        mongodbSubType: "self-hosted",
      });
      expect(result.valid).toBe(false);
      expect(result.error).toContain("Missing");
    });

    it("blocks SSRF via localhost", async () => {
      const result = await mongodbProvider.validateCredential({
        provider: "mongodb",
        mongodbSubType: "self-hosted",
        mongodbUri: "mongodb://localhost:27017/test",
      });
      expect(result.valid).toBe(false);
      expect(result.error).toContain("private");
    });

    it("blocks SSRF via internal hostnames", async () => {
      const result = await mongodbProvider.validateCredential({
        provider: "mongodb",
        mongodbSubType: "self-hosted",
        mongodbUri: "mongodb://db.internal:27017/test",
      });
      expect(result.valid).toBe(false);
      expect(result.error).toContain("private");
    });
  });

  describe("checkUsage — self-hosted", () => {
    const credential: DecryptedCredential = {
      provider: "mongodb",
      mongodbSubType: "self-hosted",
      mongodbUri: "mongodb://user:pass@mongo.example.com:27017/app",
      mongodbDatabaseName: "app",
    };

    it("returns storage, connections, ops metrics", async () => {
      const result = await mongodbProvider.checkUsage(credential, defaultThresholds);
      expect(result.provider).toBe("mongodb");
      expect(result.services).toHaveLength(1);

      const service = result.services[0];
      const storage = service.metrics.find(m => m.name === "Storage");
      expect(storage?.value).toBeCloseTo(1.24, 1); // (1GB + 256MB) in GB
      expect(service.metrics.find(m => m.name === "Active Connections")?.value).toBe(45);
      expect(service.metrics.find(m => m.name === "Collections")?.value).toBe(25);
      expect(service.metrics.find(m => m.name === "Databases")?.value).toBe(3);
      expect(service.estimatedDailyCostUSD).toBe(0); // Self-hosted
    });

    it("detects no violations under thresholds", async () => {
      const result = await mongodbProvider.checkUsage(credential, defaultThresholds);
      expect(result.violations).toHaveLength(0);
    });

    it("detects connection violation above threshold", async () => {
      const result = await mongodbProvider.checkUsage(credential, {
        ...defaultThresholds,
        mongodbActiveConnections: 20, // 45 > 20 threshold
      });
      expect(result.violations.length).toBeGreaterThan(0);
      expect(result.violations[0].metricName).toBe("Active Connections");
      expect(result.violations[0].severity).toBe("critical"); // 45 > 20*2
    });

    it("tags each violation with the right MetricCategory", async () => {
      // Force violations on every metric type by setting tiny thresholds
      const result = await mongodbProvider.checkUsage(credential, {
        mongodbStorageSizeGB: 0,        // storage
        mongodbActiveConnections: 0,    // load
        mongodbOpsPerSec: 0,            // load
        mongodbCollectionCount: 0,      // count
        mongodbDailyCostUSD: 0,         // cost (won't trigger for self-hosted but tests the mapping)
      });
      const byMetric = Object.fromEntries(result.violations.map(v => [v.metricName, v.category]));
      expect(byMetric["Storage"]).toBe("storage");
      expect(byMetric["Active Connections"]).toBe("load");
      expect(byMetric["Operations/sec"]).toBe("load");
      expect(byMetric["Collections"]).toBe("count");
    });
  });

  describe("checkUsage — Atlas", () => {
    it("fetches cluster info and cost", async () => {
      mockFetch
        .mockResolvedValueOnce({ ok: true, json: async () => ({ providerSettings: { instanceSizeName: "M30" }, diskSizeGB: 50, paused: false }) })
        .mockResolvedValueOnce({ ok: true, json: async () => ({ results: [] }) }) // processes
        .mockResolvedValueOnce({ ok: true, json: async () => ({ amountBilledCents: 9000 }) }); // invoice

      const result = await mongodbProvider.checkUsage({
        provider: "mongodb",
        mongodbSubType: "atlas",
        atlasPublicKey: "pub",
        atlasPrivateKey: "priv",
        atlasProjectId: "proj-123",
        atlasClusterName: "Cluster0",
      }, defaultThresholds);

      expect(result.services).toHaveLength(1);
      expect(result.services[0].metrics.find(m => m.name === "Storage")?.value).toBe(50);
      expect(result.totalEstimatedDailyCostUSD).toBeCloseTo(3, 0); // 9000 cents / 100 / 30
    });

    it("skips per-metric violations for paused clusters", async () => {
      mockFetch
        .mockResolvedValueOnce({ ok: true, json: async () => ({ providerSettings: { instanceSizeName: "M30" }, diskSizeGB: 9999, paused: true }) })
        .mockResolvedValueOnce({ ok: true, json: async () => ({ results: [] }) })
        .mockResolvedValueOnce({ ok: true, json: async () => ({ amountBilledCents: 9000 }) });

      const result = await mongodbProvider.checkUsage({
        provider: "mongodb",
        mongodbSubType: "atlas",
        atlasPublicKey: "pub",
        atlasPrivateKey: "priv",
        atlasProjectId: "proj-123",
        atlasClusterName: "Cluster0",
      }, { mongodbStorageSizeGB: 10 }); // even with a tiny threshold...

      // ...storage = 9999 GB should NOT produce a violation because the cluster is paused
      expect(result.services).toHaveLength(1);
      expect(result.services[0].paused).toBe(true);
      expect(result.violations).toHaveLength(0);
      // And the paused cluster's cost is forced to 0 so cost-runaway doesn't fire either
      expect(result.totalEstimatedDailyCostUSD).toBe(0);
    });

    it("includes Tier metric with parsed numeric value when running", async () => {
      mockFetch
        .mockResolvedValueOnce({ ok: true, json: async () => ({ providerSettings: { instanceSizeName: "M30" }, diskSizeGB: 50, paused: false }) })
        .mockResolvedValueOnce({ ok: true, json: async () => ({ results: [] }) })
        .mockResolvedValueOnce({ ok: true, json: async () => ({ amountBilledCents: 9000 }) });

      const result = await mongodbProvider.checkUsage({
        provider: "mongodb",
        mongodbSubType: "atlas",
        atlasPublicKey: "pub",
        atlasPrivateKey: "priv",
        atlasProjectId: "proj-123",
        atlasClusterName: "Cluster0",
      }, defaultThresholds);

      const tierMetric = result.services[0].metrics.find(m => m.name === "Tier");
      expect(tierMetric).toBeDefined();
      expect(tierMetric!.value).toBe(30);
      expect(tierMetric!.unit).toBe("M30");
    });

    it("omits Tier metric when cluster is paused (no signal value)", async () => {
      mockFetch
        .mockResolvedValueOnce({ ok: true, json: async () => ({ providerSettings: { instanceSizeName: "M30" }, diskSizeGB: 50, paused: true }) })
        .mockResolvedValueOnce({ ok: true, json: async () => ({ results: [] }) })
        .mockResolvedValueOnce({ ok: true, json: async () => ({ amountBilledCents: 9000 }) });

      const result = await mongodbProvider.checkUsage({
        provider: "mongodb",
        mongodbSubType: "atlas",
        atlasPublicKey: "pub",
        atlasPrivateKey: "priv",
        atlasProjectId: "proj-123",
        atlasClusterName: "Cluster0",
      }, defaultThresholds);

      expect(result.services[0].paused).toBe(true);
      expect(result.services[0].metrics.find(m => m.name === "Tier")).toBeUndefined();
      // The other metrics still present
      expect(result.services[0].metrics.find(m => m.name === "Storage")).toBeDefined();
      expect(result.services[0].metrics.find(m => m.name === "Active Connections")).toBeDefined();
      expect(result.services[0].metrics.find(m => m.name === "Operations/sec")).toBeDefined();
    });
  });

  describe("parseTierNumeric", () => {
    it("parses M-prefix tiers to their numeric value", async () => {
      const { parseTierNumeric } = await import("../../src/providers/mongodb/checker.js");
      expect(parseTierNumeric("M10")).toBe(10);
      expect(parseTierNumeric("M30")).toBe(30);
      expect(parseTierNumeric("M300")).toBe(300);
    });

    it("parses N-prefix NVMe variants", async () => {
      const { parseTierNumeric } = await import("../../src/providers/mongodb/checker.js");
      expect(parseTierNumeric("N40")).toBe(40);
      expect(parseTierNumeric("N60")).toBe(60);
    });

    it("returns 0 for non-tier strings", async () => {
      const { parseTierNumeric } = await import("../../src/providers/mongodb/checker.js");
      expect(parseTierNumeric("SERVERLESS")).toBe(0);
      expect(parseTierNumeric("REPLICASET")).toBe(0);
      expect(parseTierNumeric("unknown")).toBe(0);
      expect(parseTierNumeric(undefined)).toBe(0);
      expect(parseTierNumeric("")).toBe(0);
    });
  });

  describe("executeKillSwitch", () => {
    it("kills connections on self-hosted MongoDB", async () => {
      const result = await mongodbProvider.executeKillSwitch({
        provider: "mongodb",
        mongodbSubType: "self-hosted",
        mongodbUri: "mongodb://user:pass@mongo.example.com:27017/app",
      }, "mongodb:test", "kill-connections");

      expect(result.success).toBe(true);
      expect(result.action).toBe("kill-connections");
    });

    it("drops database on self-hosted MongoDB", async () => {
      const result = await mongodbProvider.executeKillSwitch({
        provider: "mongodb",
        mongodbSubType: "self-hosted",
        mongodbUri: "mongodb://user:pass@mongo.example.com:27017/app",
        mongodbDatabaseName: "testdb",
      }, "mongodb:test", "delete");

      expect(result.success).toBe(true);
      expect(result.details).toContain("dropped");
    });

    it("pauses Atlas cluster", async () => {
      mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({}) });

      const result = await mongodbProvider.executeKillSwitch({
        provider: "mongodb",
        mongodbSubType: "atlas",
        atlasPublicKey: "pub",
        atlasPrivateKey: "priv",
        atlasProjectId: "proj-123",
        atlasClusterName: "Cluster0",
      }, "cluster:Cluster0", "pause-cluster");

      expect(result.success).toBe(true);
      expect(result.details).toContain("paused");
    });

    it("does NOT escalate Atlas kill-connections to pause-cluster (no silent pause)", async () => {
      // Regression guard for the divinci-prod-atlas outage: kill-connections is the
      // DEFAULT threshold action for mongodb, so silently routing it to pause-cluster
      // auto-paused a prod Atlas cluster. It must now be a clean no-op (success:false)
      // — pausing only happens via an explicit pause-cluster action. If pause were
      // (wrongly) attempted, it would call the Atlas API; assert no such call.
      const callsBefore = mockFetch.mock.calls.length;
      const result = await mongodbProvider.executeKillSwitch({
        provider: "mongodb",
        mongodbSubType: "atlas",
        atlasPublicKey: "pub",
        atlasPrivateKey: "priv",
        atlasProjectId: "proj-123",
        atlasClusterName: "Cluster0",
      }, "cluster:Cluster0", "kill-connections");

      expect(result.success).toBe(false);
      expect(result.action).toBe("kill-connections");
      expect(result.details).not.toContain("paused");
      expect(mockFetch.mock.calls.length).toBe(callsBefore); // no Atlas pause API call
    });

    it("returns error for unsupported action", async () => {
      const result = await mongodbProvider.executeKillSwitch({
        provider: "mongodb",
        mongodbSubType: "self-hosted",
        mongodbUri: "mongodb://user:pass@mongo.example.com:27017/app",
      }, "mongodb:test", "disable-billing" as any);

      expect(result.success).toBe(false);
      expect(result.details).toContain("Unknown action");
    });
  });
});
