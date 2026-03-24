import { describe, it, expect, vi, beforeEach } from "vitest";
import { cloudflareProvider } from "../../src/providers/cloudflare/checker.js";
import type { DecryptedCredential, ThresholdConfig } from "../../src/providers/types.js";

// Mock fetch globally
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

const credential: DecryptedCredential = {
  provider: "cloudflare",
  apiToken: "test-token-abc123",
  accountId: "test-account-id",
};

const defaultThresholds: ThresholdConfig = {
  doRequestsPerDay: 1_000_000,
  doWalltimeHoursPerDay: 100,
  workerRequestsPerDay: 10_000_000,
};

function mockGraphQLResponse(doGroups: any[], workerGroups: any[] = []) {
  mockFetch.mockImplementation(async (url: string, options: any) => {
    const body = JSON.parse(options?.body || "{}");
    const query = body.query || "";

    if (query.includes("durableObjects")) {
      return {
        ok: true,
        text: async () => JSON.stringify({
          data: { viewer: { accounts: [{ durableObjectsInvocationsAdaptiveGroups: doGroups }] } },
        }),
      };
    }

    if (query.includes("workersInvocations")) {
      return {
        ok: true,
        text: async () => JSON.stringify({
          data: { viewer: { accounts: [{ workersInvocationsAdaptive: workerGroups }] } },
        }),
      };
    }

    if (query.includes("r2Storage")) {
      return {
        ok: true,
        text: async () => JSON.stringify({
          data: { viewer: { accounts: [{ r2StorageAdaptiveGroups: [] }] } },
        }),
      };
    }

    if (query.includes("d1Analytics")) {
      return {
        ok: true,
        text: async () => JSON.stringify({
          data: { viewer: { accounts: [{ d1AnalyticsAdaptiveGroups: [] }] } },
        }),
      };
    }

    // Default: return empty results for R2 buckets, D1 databases, queues, stream endpoints
    const urlStr = typeof url === "string" ? url : "";
    if (urlStr.includes("/r2/buckets") || urlStr.includes("/d1/database") ||
        urlStr.includes("/queues") || urlStr.includes("/stream")) {
      return { ok: true, text: async () => JSON.stringify({ result: [] }) };
    }

    return { ok: true, text: async () => "{}" };
  });
}

describe("Cloudflare Provider", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("checkUsage", () => {
    it("returns empty results when no services have usage", async () => {
      mockGraphQLResponse([], []);
      const result = await cloudflareProvider.checkUsage(credential, defaultThresholds);

      expect(result.provider).toBe("cloudflare");
      expect(result.accountId).toBe("test-account-id");
      expect(result.services).toHaveLength(0);
      expect(result.violations).toHaveLength(0);
      expect(result.totalEstimatedDailyCostUSD).toBe(0);
    });

    it("detects DO request threshold violations", async () => {
      mockGraphQLResponse([
        {
          dimensions: { scriptName: "runaway-worker" },
          sum: { requests: 5_000_000, wallTime: 100_000_000 }, // 5M requests, 100s walltime
        },
      ]);

      const result = await cloudflareProvider.checkUsage(credential, defaultThresholds);

      expect(result.violations).toHaveLength(1);
      expect(result.violations[0].serviceName).toBe("runaway-worker");
      expect(result.violations[0].metricName).toBe("DO Requests");
      expect(result.violations[0].currentValue).toBe(5_000_000);
      expect(result.violations[0].threshold).toBe(1_000_000);
    });

    it("detects DO wall-time threshold violations", async () => {
      mockGraphQLResponse([
        {
          dimensions: { scriptName: "long-running-do" },
          sum: {
            requests: 500,
            wallTime: 500 * 3600 * 1_000_000, // 500 hours in microseconds
          },
        },
      ]);

      const result = await cloudflareProvider.checkUsage(credential, defaultThresholds);

      expect(result.violations).toHaveLength(1);
      expect(result.violations[0].metricName).toBe("DO Wall Time");
      expect(result.violations[0].currentValue).toBe(500);
      expect(result.violations[0].severity).toBe("critical"); // 500 > 100*2
    });

    it("marks severity as warning when under 2x threshold", async () => {
      mockGraphQLResponse([
        {
          dimensions: { scriptName: "slightly-over" },
          sum: { requests: 1_500_000, wallTime: 0 },
        },
      ]);

      const result = await cloudflareProvider.checkUsage(credential, defaultThresholds);

      expect(result.violations[0].severity).toBe("warning"); // 1.5M < 2M (2x threshold)
    });

    it("marks severity as critical when over 2x threshold", async () => {
      mockGraphQLResponse([
        {
          dimensions: { scriptName: "way-over" },
          sum: { requests: 3_000_000, wallTime: 0 },
        },
      ]);

      const result = await cloudflareProvider.checkUsage(credential, defaultThresholds);

      expect(result.violations[0].severity).toBe("critical"); // 3M > 2M (2x threshold)
    });

    it("does not flag services under threshold", async () => {
      mockGraphQLResponse([
        {
          dimensions: { scriptName: "healthy-worker" },
          sum: { requests: 500_000, wallTime: 10_000_000 },
        },
      ]);

      const result = await cloudflareProvider.checkUsage(credential, defaultThresholds);

      expect(result.violations).toHaveLength(0);
      expect(result.services).toHaveLength(1);
      expect(result.services[0].serviceName).toBe("healthy-worker");
    });

    it("merges DO and Worker metrics for same service", async () => {
      mockGraphQLResponse(
        [{ dimensions: { scriptName: "my-worker" }, sum: { requests: 100, wallTime: 1000 } }],
        [{ dimensions: { scriptName: "my-worker" }, sum: { requests: 5000, errors: 10, wallTime: 50000 } }],
      );

      const result = await cloudflareProvider.checkUsage(credential, defaultThresholds);

      expect(result.services).toHaveLength(1);
      expect(result.services[0].serviceName).toBe("my-worker");
      expect(result.services[0].metrics).toHaveLength(3); // DO Requests + DO Wall Time + Worker Requests
    });

    it("detects worker request spike", async () => {
      mockGraphQLResponse(
        [],
        [{ dimensions: { scriptName: "feedback-loop" }, sum: { requests: 50_000_000, errors: 0, wallTime: 100000 } }],
      );

      const result = await cloudflareProvider.checkUsage(credential, defaultThresholds);

      expect(result.violations).toHaveLength(1);
      expect(result.violations[0].metricName).toBe("Worker Requests");
      expect(result.violations[0].currentValue).toBe(50_000_000);
    });

    it("estimates daily cost correctly", async () => {
      mockGraphQLResponse([
        {
          dimensions: { scriptName: "costly-do" },
          sum: { requests: 10_000_000, wallTime: 0 }, // 10M requests
        },
      ]);

      const result = await cloudflareProvider.checkUsage(credential, defaultThresholds);

      // Cost: (10M - 1M free) * $0.15/M = $1.35
      expect(result.services[0].estimatedDailyCostUSD).toBeCloseTo(1.35, 1);
    });

    it("throws on missing credentials", async () => {
      await expect(
        cloudflareProvider.checkUsage({ provider: "cloudflare" }, defaultThresholds)
      ).rejects.toThrow("Missing Cloudflare API token or account ID");
    });
  });

  describe("validateCredential", () => {
    it("returns valid for successful API response", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        text: async () => JSON.stringify({
          result: { id: "abc123", name: "My Account" },
        }),
      });

      const result = await cloudflareProvider.validateCredential(credential);

      expect(result.valid).toBe(true);
      expect(result.accountId).toBe("abc123");
      expect(result.accountName).toBe("My Account");
    });

    it("returns invalid for API error", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 401,
        text: async () => "Unauthorized",
      });

      const result = await cloudflareProvider.validateCredential(credential);

      expect(result.valid).toBe(false);
      expect(result.error).toContain("401");
    });

    it("returns invalid for missing credentials", async () => {
      const result = await cloudflareProvider.validateCredential({ provider: "cloudflare" });

      expect(result.valid).toBe(false);
      expect(result.error).toContain("Missing");
    });

    it("returns invalid when fetch throws (connection error)", async () => {
      mockFetch.mockRejectedValueOnce(new Error("ECONNREFUSED"));

      const result = await cloudflareProvider.validateCredential(credential);

      expect(result.valid).toBe(false);
      expect(result.error).toContain("Connection failed");
    });
  });

  describe("getDefaultThresholds", () => {
    it("returns sensible defaults for all services", () => {
      const thresholds = cloudflareProvider.getDefaultThresholds();

      expect(thresholds.doRequestsPerDay).toBe(1_000_000);
      expect(thresholds.doWalltimeHoursPerDay).toBe(100);
      expect(thresholds.workerRequestsPerDay).toBe(10_000_000);
      // New expanded thresholds
      expect(thresholds.r2OpsPerDay).toBe(10_000_000);
      expect(thresholds.r2StorageGB).toBe(10);
      expect(thresholds.d1RowsReadPerDay).toBe(5_000_000);
      expect(thresholds.d1RowsWrittenPerDay).toBe(1_000_000);
      expect(thresholds.queueOpsPerDay).toBe(1_000_000);
      expect(thresholds.streamMinutesPerDay).toBe(10_000);
      expect(thresholds.argoGBPerDay).toBe(100);
    });
  });

  describe("executeKillSwitch — extended services", () => {
    it("deletes R2 bucket", async () => {
      mockFetch.mockResolvedValueOnce({ ok: true, text: async () => "{}" });

      const result = await cloudflareProvider.executeKillSwitch(credential, "r2:my-bucket", "delete");

      expect(result.success).toBe(true);
      expect(result.action).toBe("delete");
      expect(result.serviceName).toBe("r2:my-bucket");
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining("/r2/buckets/my-bucket"),
        expect.objectContaining({ method: "DELETE" })
      );
    });

    it("pauses a zone", async () => {
      mockFetch.mockResolvedValueOnce({ ok: true, text: async () => "{}" });

      const result = await cloudflareProvider.executeKillSwitch(credential, "zone:abc123", "pause-zone");

      expect(result.success).toBe(true);
      expect(result.action).toBe("pause-zone");
      expect(result.details).toContain("Paused zone");
    });

    it("disables stream live input", async () => {
      mockFetch.mockResolvedValueOnce({ ok: true, text: async () => "{}" });

      const result = await cloudflareProvider.executeKillSwitch(credential, "stream:input-1", "disconnect");

      expect(result.success).toBe(true);
      expect(result.details).toContain("Disabled live input");
    });
  });

  describe("queryR2Usage — success path with data", () => {
    it("returns R2 service usage with operations and storage metrics", async () => {
      mockFetch.mockImplementation(async (url: string, options: any) => {
        const urlStr = typeof url === "string" ? url : "";
        const body = options?.body ? JSON.parse(options.body) : {};
        const query = body.query || "";

        if (urlStr.includes("/graphql")) {
          if (query.includes("durableObjects")) {
            return { ok: true, text: async () => JSON.stringify({ data: { viewer: { accounts: [{ durableObjectsInvocationsAdaptiveGroups: [] }] } } }) };
          }
          if (query.includes("workersInvocations")) {
            return { ok: true, text: async () => JSON.stringify({ data: { viewer: { accounts: [{ workersInvocationsAdaptive: [] }] } } }) };
          }
          if (query.includes("r2Storage")) {
            return {
              ok: true,
              text: async () => JSON.stringify({
                data: { viewer: { accounts: [{ r2StorageAdaptiveGroups: [
                  {
                    dimensions: { bucketName: "assets-bucket" },
                    sum: { objectCount: 1000, payloadSize: 1024 * 1024 * 1024 * 5, uploadCount: 500, downloadCount: 2000 },
                  },
                ] }] } },
              }),
            };
          }
          if (query.includes("d1Analytics")) {
            return { ok: true, text: async () => JSON.stringify({ data: { viewer: { accounts: [{ d1AnalyticsAdaptiveGroups: [] }] } } }) };
          }
        }

        if (urlStr.includes("/r2/buckets")) {
          return { ok: true, text: async () => JSON.stringify({ result: { buckets: [{ name: "assets-bucket" }] } }) };
        }
        if (urlStr.includes("/d1/database")) return { ok: true, text: async () => JSON.stringify({ result: [] }) };
        if (urlStr.includes("/queues")) return { ok: true, text: async () => JSON.stringify({ result: [] }) };
        if (urlStr.includes("/stream")) return { ok: true, text: async () => JSON.stringify({ result: [] }) };

        return { ok: true, text: async () => "{}" };
      });

      const result = await cloudflareProvider.checkUsage(credential, defaultThresholds);

      const r2Service = result.services.find(s => s.serviceName === "r2:assets-bucket");
      expect(r2Service).toBeDefined();
      expect(r2Service!.metrics).toHaveLength(2);
      expect(r2Service!.metrics.find(m => m.name === "R2 Operations")!.value).toBe(2500); // 500 + 2000
      expect(r2Service!.metrics.find(m => m.name === "R2 Storage")!.value).toBeCloseTo(5, 0); // 5 GB
      expect(r2Service!.estimatedDailyCostUSD).toBeGreaterThan(0);
    });
  });

  describe("queryR2Usage — fallback path", () => {
    it("falls back to bucket list when R2 GraphQL fails", async () => {
      mockFetch.mockImplementation(async (url: string, options: any) => {
        const urlStr = typeof url === "string" ? url : "";
        const body = options?.body ? JSON.parse(options.body) : {};
        const query = body.query || "";

        if (urlStr.includes("/graphql")) {
          if (query.includes("durableObjects")) {
            return { ok: true, text: async () => JSON.stringify({ data: { viewer: { accounts: [{ durableObjectsInvocationsAdaptiveGroups: [] }] } } }) };
          }
          if (query.includes("workersInvocations")) {
            return { ok: true, text: async () => JSON.stringify({ data: { viewer: { accounts: [{ workersInvocationsAdaptive: [] }] } } }) };
          }
          if (query.includes("r2Storage")) {
            // R2 GraphQL fails — triggers fallback
            return { ok: true, text: async () => JSON.stringify({ errors: [{ message: "R2 analytics unavailable" }] }) };
          }
          if (query.includes("d1Analytics")) {
            return { ok: true, text: async () => JSON.stringify({ data: { viewer: { accounts: [{ d1AnalyticsAdaptiveGroups: [] }] } } }) };
          }
        }

        if (urlStr.includes("/r2/buckets")) {
          return { ok: true, text: async () => JSON.stringify({ result: { buckets: [{ name: "my-bucket" }, { name: "logs-bucket" }] } }) };
        }
        if (urlStr.includes("/d1/database")) return { ok: true, text: async () => JSON.stringify({ result: [] }) };
        if (urlStr.includes("/queues")) return { ok: true, text: async () => JSON.stringify({ result: [] }) };
        if (urlStr.includes("/stream")) return { ok: true, text: async () => JSON.stringify({ result: [] }) };

        return { ok: true, text: async () => "{}" };
      });

      const result = await cloudflareProvider.checkUsage(credential, defaultThresholds);

      // Should have R2 buckets from fallback (no metrics, just names)
      const r2Services = result.services.filter(s => s.serviceName.startsWith("r2:"));
      expect(r2Services).toHaveLength(2);
      expect(r2Services[0].serviceName).toBe("r2:my-bucket");
      expect(r2Services[0].metrics).toHaveLength(0);
      expect(r2Services[0].estimatedDailyCostUSD).toBe(0);
    });
  });

  describe("executeKillSwitch — D1, Queue, Zone routing", () => {
    it("deletes D1 database", async () => {
      mockFetch.mockResolvedValueOnce({ ok: true, text: async () => "{}" });

      const result = await cloudflareProvider.executeKillSwitch(credential, "d1:my-db-id", "delete");

      expect(result.success).toBe(true);
      expect(result.action).toBe("delete");
      expect(result.serviceName).toBe("d1:my-db-id");
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining("/d1/database/my-db-id"),
        expect.objectContaining({ method: "DELETE" })
      );
    });

    it("deletes a queue", async () => {
      mockFetch.mockResolvedValueOnce({ ok: true, text: async () => "{}" });

      const result = await cloudflareProvider.executeKillSwitch(credential, "queue:my-queue", "delete");

      expect(result.success).toBe(true);
      expect(result.action).toBe("delete");
      expect(result.serviceName).toBe("queue:my-queue");
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining("/queues/my-queue"),
        expect.objectContaining({ method: "DELETE" })
      );
    });

    it("disables Argo on zone disconnect", async () => {
      mockFetch.mockResolvedValueOnce({ ok: true, text: async () => "{}" });

      const result = await cloudflareProvider.executeKillSwitch(credential, "zone:zone-123", "disconnect");

      expect(result.success).toBe(true);
      expect(result.action).toBe("disconnect");
      expect(result.details).toContain("Disabled Argo Smart Routing");
    });

    it("pauses zone for zone type with non-disconnect action", async () => {
      mockFetch.mockResolvedValueOnce({ ok: true, text: async () => "{}" });

      const result = await cloudflareProvider.executeKillSwitch(credential, "zone:zone-123", "delete");

      expect(result.success).toBe(true);
      expect(result.action).toBe("pause-zone");
      expect(result.details).toContain("Paused zone");
    });

    it("pause-zone works for non-zone service names", async () => {
      mockFetch.mockResolvedValueOnce({ ok: true, text: async () => "{}" });

      const result = await cloudflareProvider.executeKillSwitch(credential, "some-service", "pause-zone");

      expect(result.success).toBe(true);
      expect(result.action).toBe("pause-zone");
    });

    it("reports failure for failed deleteD1Database", async () => {
      mockFetch.mockResolvedValueOnce({ ok: false, status: 404, text: async () => "Not Found" });

      const result = await cloudflareProvider.executeKillSwitch(credential, "d1:missing-db", "delete");

      expect(result.success).toBe(false);
      expect(result.details).toContain("Failed to delete D1 database");
    });

    it("reports failure for failed deleteQueue", async () => {
      mockFetch.mockResolvedValueOnce({ ok: false, status: 404, text: async () => "Not Found" });

      const result = await cloudflareProvider.executeKillSwitch(credential, "queue:missing-queue", "delete");

      expect(result.success).toBe(false);
      expect(result.details).toContain("Failed to delete queue");
    });

    it("reports failure for failed disableLiveInput", async () => {
      mockFetch.mockResolvedValueOnce({ ok: false, status: 500, text: async () => "Error" });

      const result = await cloudflareProvider.executeKillSwitch(credential, "stream:input-1", "disconnect");

      expect(result.success).toBe(false);
      expect(result.details).toContain("Failed to disable live input");
    });

    it("reports failure for failed pauseZone", async () => {
      mockFetch.mockResolvedValueOnce({ ok: false, status: 403, text: async () => "Forbidden" });

      const result = await cloudflareProvider.executeKillSwitch(credential, "zone:zone-123", "pause-zone");

      expect(result.success).toBe(false);
      expect(result.details).toContain("Failed to pause zone");
    });

    it("reports failure for failed disableArgo", async () => {
      mockFetch.mockResolvedValueOnce({ ok: false, status: 403, text: async () => "Forbidden" });

      const result = await cloudflareProvider.executeKillSwitch(credential, "zone:zone-123", "disconnect");

      expect(result.success).toBe(false);
      expect(result.details).toContain("Failed to disable Argo");
    });

    it("throws on missing credentials", async () => {
      await expect(
        cloudflareProvider.executeKillSwitch({ provider: "cloudflare" }, "worker", "disconnect")
      ).rejects.toThrow("Missing Cloudflare credentials");
    });
  });

  describe("cfGraphQL — error handling", () => {
    it("throws on JSON parse error from GraphQL", async () => {
      mockFetch.mockImplementation(async (url: string, options: any) => {
        const urlStr = typeof url === "string" ? url : "";
        if (urlStr.includes("/graphql")) {
          return {
            ok: true,
            text: async () => "THIS IS NOT JSON",
          };
        }
        // For REST endpoints needed by checkUsage
        return { ok: true, text: async () => JSON.stringify({ result: [] }) };
      });

      // cfGraphQL is called internally by queryDOUsage/queryWorkerUsage
      // Both will throw, causing checkUsage to fail
      await expect(
        cloudflareProvider.checkUsage(credential, defaultThresholds)
      ).rejects.toThrow("CF GraphQL parse error");
    });

    it("throws on GraphQL errors in response", async () => {
      mockFetch.mockImplementation(async (url: string, options: any) => {
        const urlStr = typeof url === "string" ? url : "";
        if (urlStr.includes("/graphql")) {
          return {
            ok: true,
            text: async () => JSON.stringify({
              errors: [{ message: "Invalid query" }],
            }),
          };
        }
        return { ok: true, text: async () => JSON.stringify({ result: [] }) };
      });

      await expect(
        cloudflareProvider.checkUsage(credential, defaultThresholds)
      ).rejects.toThrow("CF GraphQL error");
    });
  });

  describe("queryD1Usage — with actual data", () => {
    it("returns D1 service usage with database name resolution", async () => {
      mockFetch.mockImplementation(async (url: string, options: any) => {
        const urlStr = typeof url === "string" ? url : "";
        const body = options?.body ? JSON.parse(options.body) : {};
        const query = body.query || "";

        if (urlStr.includes("/graphql")) {
          if (query.includes("durableObjects")) {
            return { ok: true, text: async () => JSON.stringify({ data: { viewer: { accounts: [{ durableObjectsInvocationsAdaptiveGroups: [] }] } } }) };
          }
          if (query.includes("workersInvocations")) {
            return { ok: true, text: async () => JSON.stringify({ data: { viewer: { accounts: [{ workersInvocationsAdaptive: [] }] } } }) };
          }
          if (query.includes("r2Storage")) {
            return { ok: true, text: async () => JSON.stringify({ data: { viewer: { accounts: [{ r2StorageAdaptiveGroups: [] }] } } }) };
          }
          if (query.includes("d1Analytics")) {
            return {
              ok: true,
              text: async () => JSON.stringify({
                data: { viewer: { accounts: [{ d1AnalyticsAdaptiveGroups: [
                  { dimensions: { databaseId: "db-uuid-123" }, sum: { readQueries: 100, writeQueries: 10, rowsRead: 5000, rowsWritten: 200 } },
                ] }] } },
              }),
            };
          }
        }

        if (urlStr.includes("/d1/database")) {
          return { ok: true, text: async () => JSON.stringify({ result: [{ uuid: "db-uuid-123", name: "my-d1-db" }] }) };
        }
        if (urlStr.includes("/r2/buckets")) {
          return { ok: true, text: async () => JSON.stringify({ result: { buckets: [] } }) };
        }
        if (urlStr.includes("/queues")) {
          return { ok: true, text: async () => JSON.stringify({ result: [] }) };
        }
        if (urlStr.includes("/stream")) {
          return { ok: true, text: async () => JSON.stringify({ result: [] }) };
        }
        return { ok: true, text: async () => "{}" };
      });

      const result = await cloudflareProvider.checkUsage(credential, {
        ...defaultThresholds,
        d1RowsReadPerDay: 5_000_000,
        d1RowsWrittenPerDay: 1_000_000,
      });

      const d1Service = result.services.find(s => s.serviceName.startsWith("d1:"));
      expect(d1Service).toBeDefined();
      expect(d1Service!.serviceName).toBe("d1:my-d1-db");
      expect(d1Service!.metrics.find(m => m.name === "D1 Rows Read")!.value).toBe(5000);
      expect(d1Service!.metrics.find(m => m.name === "D1 Rows Written")!.value).toBe(200);
    });
  });

  describe("queryQueuesUsage — with actual data", () => {
    it("returns queue usage with message counts", async () => {
      mockFetch.mockImplementation(async (url: string, options: any) => {
        const urlStr = typeof url === "string" ? url : "";
        const body = options?.body ? JSON.parse(options.body) : {};
        const query = body.query || "";

        if (urlStr.includes("/graphql")) {
          if (query.includes("durableObjects")) {
            return { ok: true, text: async () => JSON.stringify({ data: { viewer: { accounts: [{ durableObjectsInvocationsAdaptiveGroups: [] }] } } }) };
          }
          if (query.includes("workersInvocations")) {
            return { ok: true, text: async () => JSON.stringify({ data: { viewer: { accounts: [{ workersInvocationsAdaptive: [] }] } } }) };
          }
          if (query.includes("r2Storage")) {
            return { ok: true, text: async () => JSON.stringify({ data: { viewer: { accounts: [{ r2StorageAdaptiveGroups: [] }] } } }) };
          }
          if (query.includes("d1Analytics")) {
            return { ok: true, text: async () => JSON.stringify({ data: { viewer: { accounts: [{ d1AnalyticsAdaptiveGroups: [] }] } } }) };
          }
        }

        if (urlStr.includes("/r2/buckets")) {
          return { ok: true, text: async () => JSON.stringify({ result: { buckets: [] } }) };
        }
        if (urlStr.includes("/d1/database")) {
          return { ok: true, text: async () => JSON.stringify({ result: [] }) };
        }
        if (urlStr.includes("/queues")) {
          return { ok: true, text: async () => JSON.stringify({ result: [
            { queue_name: "email-queue", messages: 500 },
            { queue_name: "task-queue", messages: 1200 },
          ] }) };
        }
        if (urlStr.includes("/stream")) {
          return { ok: true, text: async () => JSON.stringify({ result: [] }) };
        }
        return { ok: true, text: async () => "{}" };
      });

      const result = await cloudflareProvider.checkUsage(credential, {
        ...defaultThresholds,
        queueOpsPerDay: 1_000_000,
      });

      const queueServices = result.services.filter(s => s.serviceName.startsWith("queue:"));
      expect(queueServices).toHaveLength(2);
      expect(queueServices.find(s => s.serviceName === "queue:email-queue")).toBeDefined();
      expect(queueServices.find(s => s.serviceName === "queue:task-queue")!.metrics[0].value).toBe(1200);
    });
  });

  describe("queryStreamUsage — with actual data", () => {
    it("returns stream usage with live inputs and stored videos", async () => {
      mockFetch.mockImplementation(async (url: string, options: any) => {
        const urlStr = typeof url === "string" ? url : "";
        const body = options?.body ? JSON.parse(options.body) : {};
        const query = body.query || "";

        if (urlStr.includes("/graphql")) {
          if (query.includes("durableObjects")) {
            return { ok: true, text: async () => JSON.stringify({ data: { viewer: { accounts: [{ durableObjectsInvocationsAdaptiveGroups: [] }] } } }) };
          }
          if (query.includes("workersInvocations")) {
            return { ok: true, text: async () => JSON.stringify({ data: { viewer: { accounts: [{ workersInvocationsAdaptive: [] }] } } }) };
          }
          if (query.includes("r2Storage")) {
            return { ok: true, text: async () => JSON.stringify({ data: { viewer: { accounts: [{ r2StorageAdaptiveGroups: [] }] } } }) };
          }
          if (query.includes("d1Analytics")) {
            return { ok: true, text: async () => JSON.stringify({ data: { viewer: { accounts: [{ d1AnalyticsAdaptiveGroups: [] }] } } }) };
          }
        }

        if (urlStr.includes("/r2/buckets")) {
          return { ok: true, text: async () => JSON.stringify({ result: { buckets: [] } }) };
        }
        if (urlStr.includes("/d1/database")) {
          return { ok: true, text: async () => JSON.stringify({ result: [] }) };
        }
        if (urlStr.includes("/queues")) {
          return { ok: true, text: async () => JSON.stringify({ result: [] }) };
        }
        if (urlStr.includes("/stream/live_inputs")) {
          return { ok: true, text: async () => JSON.stringify({ result: [
            { uid: "live-1", status: { current: { state: "connected" } } },
            { uid: "live-2", status: { current: { state: "disconnected" } } },
          ] }) };
        }
        if (urlStr.includes("/stream")) {
          return { ok: true, text: async () => JSON.stringify({ result: [
            { duration: 600 },  // 10 minutes
            { duration: 1200 }, // 20 minutes
          ] }) };
        }
        return { ok: true, text: async () => "{}" };
      });

      const result = await cloudflareProvider.checkUsage(credential, {
        ...defaultThresholds,
        streamMinutesPerDay: 10_000,
      });

      const streamServices = result.services.filter(s => s.serviceName.startsWith("stream:"));
      expect(streamServices.length).toBeGreaterThanOrEqual(2);

      // Live input that is connected should have value 1
      const liveConnected = streamServices.find(s => s.serviceName === "stream:live-1");
      expect(liveConnected).toBeDefined();
      expect(liveConnected!.metrics[0].value).toBe(1);

      // Live input that is disconnected should have value 0
      const liveDisconnected = streamServices.find(s => s.serviceName === "stream:live-2");
      expect(liveDisconnected).toBeDefined();
      expect(liveDisconnected!.metrics[0].value).toBe(0);

      // Stored videos total: (600+1200)/60 = 30 minutes
      const storedVideos = streamServices.find(s => s.serviceName === "stream:stored-videos");
      expect(storedVideos).toBeDefined();
      expect(storedVideos!.metrics[0].value).toBe(30);
    });
  });

  describe("executeKillSwitch", () => {
    it("disconnects worker by disabling subdomain and removing domains", async () => {
      mockFetch
        .mockResolvedValueOnce({ ok: true, text: async () => "{}" }) // disable subdomain
        .mockResolvedValueOnce({ ok: true, text: async () => JSON.stringify({ result: [{ id: "d1", hostname: "my.app" }] }) }) // list domains
        .mockResolvedValueOnce({ ok: true }); // delete domain

      const result = await cloudflareProvider.executeKillSwitch(credential, "my-worker", "disconnect");

      expect(result.success).toBe(true);
      expect(result.action).toBe("disconnect");
      expect(result.details).toContain("Disabled workers.dev");
      expect(result.details).toContain("Removed domain my.app");
    });

    it("handles subdomain disable errors gracefully", async () => {
      mockFetch
        .mockRejectedValueOnce(new Error("Connection reset")) // disable subdomain throws
        .mockResolvedValueOnce({ ok: true, text: async () => JSON.stringify({ result: [] }) }); // list domains

      const result = await cloudflareProvider.executeKillSwitch(credential, "my-worker", "disconnect");

      expect(result.success).toBe(true);
      expect(result.details).toContain("Error:");
    });

    it("handles domain removal errors gracefully", async () => {
      mockFetch
        .mockResolvedValueOnce({ ok: true, text: async () => "{}" }) // disable subdomain
        .mockRejectedValueOnce(new Error("Network error")); // list domains throws

      const result = await cloudflareProvider.executeKillSwitch(credential, "my-worker", "disconnect");

      expect(result.success).toBe(true);
      expect(result.details).toContain("Error removing domains");
    });

    it("deletes worker with force flag", async () => {
      mockFetch.mockResolvedValueOnce({ ok: true, text: async () => "{}" });

      const result = await cloudflareProvider.executeKillSwitch(credential, "my-worker", "delete");

      expect(result.success).toBe(true);
      expect(result.action).toBe("delete");
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining("?force=true"),
        expect.objectContaining({ method: "DELETE" })
      );
    });
  });
});
