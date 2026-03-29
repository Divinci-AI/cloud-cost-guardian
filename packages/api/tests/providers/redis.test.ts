import { describe, it, expect, vi, beforeEach } from "vitest";
import { redisProvider } from "../../src/providers/redis/checker.js";
import type { DecryptedCredential, ThresholdConfig } from "../../src/providers/types.js";

// Mock fetch globally
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

// Mock ioredis
vi.mock("ioredis", () => {
  const MockRedis = vi.fn().mockImplementation(() => ({
    connect: vi.fn().mockResolvedValue(undefined),
    info: vi.fn().mockResolvedValue(
      "used_memory:134217728\nconnected_clients:42\ninstantaneous_ops_per_sec:1500\nevicted_keys:10\nmaxmemory:536870912\nredis_version:7.2.4\ndb0:keys=1000,expires=100\ndb1:keys=500,expires=50"
    ),
    ping: vi.fn().mockResolvedValue("PONG"),
    client: vi.fn().mockResolvedValue(""),
    flushall: vi.fn().mockResolvedValue("OK"),
    config: vi.fn().mockResolvedValue("OK"),
    quit: vi.fn().mockResolvedValue("OK"),
  }));
  return { default: MockRedis };
});

// Mock AWS SDK
vi.mock("@aws-sdk/client-elasticache", () => ({
  ElastiCacheClient: vi.fn().mockImplementation(() => ({
    send: vi.fn().mockResolvedValue({
      CacheClusters: [{
        CacheClusterId: "test-cluster",
        CacheNodeType: "cache.r6g.large",
        NumCacheNodes: 2,
        Engine: "redis",
      }],
    }),
    destroy: vi.fn(),
  })),
  DescribeCacheClustersCommand: vi.fn(),
  CreateSnapshotCommand: vi.fn(),
  DeleteCacheClusterCommand: vi.fn(),
}));

vi.mock("@aws-sdk/client-cloudwatch", () => ({
  CloudWatchClient: vi.fn().mockImplementation(() => ({
    send: vi.fn().mockResolvedValue({
      MetricDataResults: [
        { Id: "memory", Values: [268435456] },
        { Id: "connections", Values: [15] },
        { Id: "commands", Values: [4500] },
      ],
    }),
    destroy: vi.fn(),
  })),
  GetMetricDataCommand: vi.fn(),
}));

vi.mock("@aws-sdk/client-cost-explorer", () => ({
  CostExplorerClient: vi.fn().mockImplementation(() => ({
    send: vi.fn().mockResolvedValue({
      ResultsByTime: [{ Total: { UnblendedCost: { Amount: "3.50" } } }],
    }),
    destroy: vi.fn(),
  })),
  GetCostAndUsageCommand: vi.fn(),
}));

const defaultThresholds: ThresholdConfig = redisProvider.getDefaultThresholds();

// ─── Tests ────────────────────────────────────────────────────────────────

describe("Redis Provider", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("getDefaultThresholds", () => {
    it("returns sensible defaults", () => {
      const t = redisProvider.getDefaultThresholds();
      expect(t.redisMemoryUsageMB).toBe(512);
      expect(t.redisConnectedClients).toBe(100);
      expect(t.redisCommandsPerSec).toBe(10000);
      expect(t.redisEvictedKeysPerDay).toBe(1000);
      expect(t.redisDailyCostUSD).toBe(25);
      expect(t.monthlySpendLimitUSD).toBe(750);
    });
  });

  describe("validateCredential", () => {
    it("validates Redis Cloud credentials", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ account: { name: "Test Account" } }),
      });

      const result = await redisProvider.validateCredential({
        provider: "redis",
        redisSubType: "redis-cloud",
        redisCloudAccountKey: "test-key",
        redisCloudSecretKey: "test-secret",
        redisCloudSubscriptionId: "12345",
      });

      expect(result.valid).toBe(true);
      expect(result.accountName).toBe("Test Account");
    });

    it("rejects missing Redis Cloud keys", async () => {
      const result = await redisProvider.validateCredential({
        provider: "redis",
        redisSubType: "redis-cloud",
      });
      expect(result.valid).toBe(false);
      expect(result.error).toContain("Missing");
    });

    it("validates self-hosted Redis via PING", async () => {
      const result = await redisProvider.validateCredential({
        provider: "redis",
        redisSubType: "self-hosted",
        redisUrl: "redis://user:pass@redis.example.com:6379",
      });
      expect(result.valid).toBe(true);
      expect(result.accountName).toContain("Redis");
    });

    it("rejects missing Redis URL for self-hosted", async () => {
      const result = await redisProvider.validateCredential({
        provider: "redis",
        redisSubType: "self-hosted",
      });
      expect(result.valid).toBe(false);
      expect(result.error).toContain("Missing");
    });

    it("blocks SSRF via private IPs", async () => {
      const result = await redisProvider.validateCredential({
        provider: "redis",
        redisSubType: "self-hosted",
        redisUrl: "redis://127.0.0.1:6379",
      });
      expect(result.valid).toBe(false);
      expect(result.error).toContain("private");
    });

    it("blocks SSRF via metadata endpoint", async () => {
      const result = await redisProvider.validateCredential({
        provider: "redis",
        redisSubType: "self-hosted",
        redisUrl: "redis://169.254.169.254:6379",
      });
      expect(result.valid).toBe(false);
      expect(result.error).toContain("private");
    });

    it("validates ElastiCache credentials", async () => {
      const result = await redisProvider.validateCredential({
        provider: "redis",
        redisSubType: "elasticache",
        awsAccessKeyId: "AKIA...",
        awsSecretAccessKey: "secret",
        awsRegion: "us-east-1",
        elasticacheClusterId: "test-cluster",
      });
      expect(result.valid).toBe(true);
      expect(result.accountId).toBe("test-cluster");
    });

    it("rejects missing ElastiCache cluster ID", async () => {
      const result = await redisProvider.validateCredential({
        provider: "redis",
        redisSubType: "elasticache",
        awsAccessKeyId: "AKIA...",
        awsSecretAccessKey: "secret",
      });
      expect(result.valid).toBe(false);
      expect(result.error).toContain("Missing");
    });
  });

  describe("checkUsage — self-hosted", () => {
    const credential: DecryptedCredential = {
      provider: "redis",
      redisSubType: "self-hosted",
      redisUrl: "redis://user:pass@redis.example.com:6379",
    };

    it("returns memory, clients, ops metrics from INFO", async () => {
      const result = await redisProvider.checkUsage(credential, defaultThresholds);
      expect(result.provider).toBe("redis");
      expect(result.services).toHaveLength(1);

      const service = result.services[0];
      expect(service.metrics.find(m => m.name === "Memory Usage")?.value).toBe(128); // 134217728 / 1024 / 1024
      expect(service.metrics.find(m => m.name === "Connected Clients")?.value).toBe(42);
      expect(service.metrics.find(m => m.name === "Commands/sec")?.value).toBe(1500);
      expect(service.estimatedDailyCostUSD).toBe(0); // Self-hosted
    });

    it("detects no violations under thresholds", async () => {
      const result = await redisProvider.checkUsage(credential, defaultThresholds);
      expect(result.violations).toHaveLength(0);
    });

    it("detects memory violation above threshold", async () => {
      const result = await redisProvider.checkUsage(credential, {
        ...defaultThresholds,
        redisMemoryUsageMB: 50, // 128MB > 50MB threshold
      });
      expect(result.violations.length).toBeGreaterThan(0);
      expect(result.violations[0].metricName).toBe("Memory Usage");
      expect(result.violations[0].severity).toBe("critical"); // 128 > 50*2
    });
  });

  describe("checkUsage — Redis Cloud", () => {
    it("fetches subscription and database metrics", async () => {
      mockFetch
        .mockResolvedValueOnce({ ok: true, json: async () => ({ price: 30 }) })
        .mockResolvedValueOnce({ ok: true, json: async () => ({
          subscription: [{ databases: [
            { databaseId: 1, name: "cache", memoryUsedInMb: 256, memoryLimitInMb: 512, throughputInOps: 5000 },
          ]}],
        })});

      const result = await redisProvider.checkUsage({
        provider: "redis",
        redisSubType: "redis-cloud",
        redisCloudAccountKey: "key",
        redisCloudSecretKey: "secret",
        redisCloudSubscriptionId: "123",
      }, defaultThresholds);

      expect(result.services).toHaveLength(1);
      expect(result.totalEstimatedDailyCostUSD).toBe(1); // 30/30
    });
  });

  describe("executeKillSwitch", () => {
    it("flushes self-hosted Redis", async () => {
      const result = await redisProvider.executeKillSwitch({
        provider: "redis",
        redisSubType: "self-hosted",
        redisUrl: "redis://user:pass@redis.example.com:6379",
      }, "redis:test", "flush-redis");

      expect(result.success).toBe(true);
      expect(result.action).toBe("flush-redis");
      expect(result.details).toContain("FLUSHALL");
    });

    it("scales down self-hosted Redis", async () => {
      const result = await redisProvider.executeKillSwitch({
        provider: "redis",
        redisSubType: "self-hosted",
        redisUrl: "redis://user:pass@redis.example.com:6379",
      }, "redis:test", "scale-down");

      expect(result.success).toBe(true);
      expect(result.details).toContain("maxmemory");
    });

    it("returns error for unsupported action", async () => {
      const result = await redisProvider.executeKillSwitch({
        provider: "redis",
        redisSubType: "self-hosted",
        redisUrl: "redis://user:pass@redis.example.com:6379",
      }, "redis:test", "disable-billing" as any);

      expect(result.success).toBe(false);
      expect(result.details).toContain("Unknown action");
    });
  });
});
