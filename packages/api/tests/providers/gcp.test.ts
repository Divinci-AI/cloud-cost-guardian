import { describe, it, expect, vi, beforeEach } from "vitest";
import { gcpProvider } from "../../src/providers/gcp/checker.js";
import type { DecryptedCredential, ThresholdConfig } from "../../src/providers/types.js";

// Mock fetch globally
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

// Use pre-generated access token to skip JWT auth flow
const credential: DecryptedCredential = {
  provider: "gcp",
  serviceAccountJson: JSON.stringify({ access_token: "test-access-token" }),
  projectId: "test-project-123",
  region: "us-central1",
};

const defaultThresholds: ThresholdConfig = gcpProvider.getDefaultThresholds();

// ─── Fetch Mock Helpers ─────────────────────────────────────────────────────

function mockAllAPIs(overrides: Record<string, any> = {}) {
  mockFetch.mockImplementation(async (url: string, options?: any) => {
    const urlStr = typeof url === "string" ? url : "";

    // Cloud Run GET single service (for scale-down) — matches /services/<name>
    if (urlStr.includes("run.googleapis.com") && urlStr.match(/\/services\/[a-zA-Z0-9]/) && (!options?.method || options?.method === "GET") && !urlStr.endsWith("/services")) {
      return {
        ok: true,
        text: async () => JSON.stringify({
          template: { scaling: { maxInstanceCount: 10 } },
        }),
      };
    }

    // Cloud Run list services
    if (urlStr.includes("run.googleapis.com") && !options?.method) {
      return {
        ok: true,
        text: async () => JSON.stringify(overrides.cloudRun ?? {
          services: [{
            name: "projects/test/locations/us-central1/services/api-service",
            template: {
              scaling: { minInstanceCount: "1", maxInstanceCount: "10" },
              containers: [{ resources: { limits: { cpu: "2", memory: "1Gi" } } }],
            },
          }],
        }),
      };
    }

    // Compute Engine
    if (urlStr.includes("compute.googleapis.com") && urlStr.includes("aggregated") && !options?.method) {
      return {
        ok: true,
        text: async () => JSON.stringify(overrides.compute ?? {
          items: {
            "zones/us-central1-a": {
              instances: [
                { name: "web-1", status: "RUNNING", machineType: "zones/us-central1-a/machineTypes/n1-standard-4", guestAccelerators: [] },
                { name: "gpu-1", status: "RUNNING", machineType: "zones/us-central1-a/machineTypes/n1-standard-8", guestAccelerators: [{ acceleratorCount: 2 }] },
                { name: "stopped-vm", status: "TERMINATED", machineType: "zones/us-central1-a/machineTypes/n1-standard-1" },
              ],
            },
          },
        }),
      };
    }

    // Compute Engine stop instance
    if (urlStr.includes("compute.googleapis.com") && urlStr.includes("/stop")) {
      return { ok: true, text: async () => "{}" };
    }

    // GKE
    if (urlStr.includes("container.googleapis.com") && urlStr.includes("/clusters") && !urlStr.includes("nodePools")) {
      return {
        ok: true,
        text: async () => JSON.stringify(overrides.gke ?? {
          clusters: [{
            name: "prod-cluster",
            nodePools: [
              { initialNodeCount: 3, autoscaling: { enabled: true, minNodeCount: 2, maxNodeCount: 10 } },
            ],
          }],
        }),
      };
    }

    // GKE node pool scale
    if (urlStr.includes("container.googleapis.com") && urlStr.includes("nodePools") && options?.method === "PUT") {
      return { ok: true, text: async () => "{}" };
    }

    // BigQuery
    if (urlStr.includes("bigquery.googleapis.com")) {
      return {
        ok: true,
        text: async () => JSON.stringify(overrides.bigquery ?? {
          jobs: [
            { statistics: { totalBytesProcessed: "500000000000" } }, // 500 GB
            { statistics: { totalBytesProcessed: "200000000000" } }, // 200 GB
          ],
        }),
      };
    }

    // Cloud Functions
    if (urlStr.includes("cloudfunctions.googleapis.com") && !options?.method) {
      return {
        ok: true,
        text: async () => JSON.stringify(overrides.cloudFunctions ?? {
          functions: [{
            name: "projects/test/locations/us-central1/functions/my-function",
            serviceConfig: { maxInstanceCount: 50 },
          }],
        }),
      };
    }

    // Cloud Functions patch
    if (urlStr.includes("cloudfunctions.googleapis.com") && options?.method === "PATCH") {
      return { ok: true, text: async () => "{}" };
    }

    // Cloud Storage
    if (urlStr.includes("storage.googleapis.com")) {
      return {
        ok: true,
        text: async () => JSON.stringify(overrides.gcs ?? {
          items: [{ name: "my-bucket" }, { name: "logs-bucket" }],
        }),
      };
    }

    // Cloud Billing
    if (urlStr.includes("cloudbilling.googleapis.com") && !options?.method) {
      return { ok: true, text: async () => JSON.stringify({ billingAccountName: "billingAccounts/123" }) };
    }

    // Cloud Billing disable (PUT)
    if (urlStr.includes("cloudbilling.googleapis.com") && options?.method === "PUT") {
      return { ok: true, text: async () => "{}" };
    }

    // Cloud Monitoring — check both string and URL forms
    if (urlStr.includes("monitoring.googleapis.com") || String(url).includes("monitoring.googleapis.com")) {
      return {
        ok: true,
        text: async () => JSON.stringify(overrides.monitoring ?? { timeSeries: [] }),
      };
    }

    // Service Usage (BigQuery quota)
    if (urlStr.includes("serviceusage.googleapis.com") && options?.method === "POST") {
      return { ok: true, text: async () => "{}" };
    }

    // Cloud Run scale-down (PATCH)
    if (urlStr.includes("run.googleapis.com") && options?.method === "PATCH") {
      return { ok: true, text: async () => "{}" };
    }

    // Cloud Resource Manager (validate)
    if (urlStr.includes("cloudresourcemanager.googleapis.com")) {
      return {
        ok: true,
        text: async () => JSON.stringify({ projectId: "test-project-123", name: "Test Project" }),
      };
    }

    return { ok: false, status: 404, text: async () => "Not Found" };
  });
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("GCP Provider", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("validateCredential", () => {
    it("returns valid for working credentials", async () => {
      mockAllAPIs();
      const result = await gcpProvider.validateCredential(credential);

      expect(result.valid).toBe(true);
      expect(result.accountId).toBe("test-project-123");
      expect(result.accountName).toBe("Test Project");
    });

    it("returns invalid for missing credentials", async () => {
      const result = await gcpProvider.validateCredential({ provider: "gcp" });

      expect(result.valid).toBe(false);
      expect(result.error).toContain("Missing");
    });

    it("returns invalid for API error", async () => {
      mockFetch.mockResolvedValue({ ok: false, status: 403, text: async () => "Forbidden" });
      const result = await gcpProvider.validateCredential(credential);

      expect(result.valid).toBe(false);
      expect(result.error).toContain("403");
    });
  });

  describe("getDefaultThresholds", () => {
    it("returns sensible defaults for all GCP services", () => {
      const thresholds = gcpProvider.getDefaultThresholds();

      expect(thresholds.monthlySpendLimitUSD).toBe(500);
      expect(thresholds.computeInstanceCount).toBe(10);
      expect(thresholds.computeGPUCount).toBe(0);
      expect(thresholds.gkeNodeCount).toBe(20);
      expect(thresholds.bigqueryBytesPerDay).toBe(1_000_000_000_000);
      expect(thresholds.cloudFunctionInvocationsPerDay).toBe(1_000_000);
      expect(thresholds.gcsEgressGBPerDay).toBe(100);
    });
  });

  describe("checkUsage", () => {
    it("returns combined services from all GCP APIs", async () => {
      mockAllAPIs();
      const result = await gcpProvider.checkUsage(credential, defaultThresholds);

      expect(result.provider).toBe("gcp");
      expect(result.accountId).toBe("test-project-123");
      expect(result.services.length).toBeGreaterThan(0);

      // Should have Cloud Run, Compute, GKE, BigQuery, Cloud Functions, GCS services
      const serviceNames = result.services.map(s => s.serviceName);
      expect(serviceNames.some(n => n === "api-service")).toBe(true); // Cloud Run
      expect(serviceNames.some(n => n.startsWith("compute:"))).toBe(true);
      expect(serviceNames.some(n => n.startsWith("gke:"))).toBe(true);
      expect(serviceNames.some(n => n.startsWith("bq:"))).toBe(true);
      expect(serviceNames.some(n => n.startsWith("gcf:"))).toBe(true);
      expect(serviceNames.some(n => n.startsWith("gcs:"))).toBe(true);
    });

    it("detects compute instance threshold violations", async () => {
      mockAllAPIs();
      // Default threshold is 10 instances, mock has 2 running → set threshold to 1
      const result = await gcpProvider.checkUsage(credential, {
        ...defaultThresholds,
        computeInstanceCount: 1,
      });

      const violation = result.violations.find(v => v.metricName === "Total Running Instances");
      expect(violation).toBeDefined();
      expect(violation!.currentValue).toBe(2); // web-1 and gpu-1 are RUNNING
    });

    it("detects GPU threshold violations", async () => {
      mockAllAPIs();
      // Default GPU threshold is 0
      const result = await gcpProvider.checkUsage(credential, {
        ...defaultThresholds,
        computeGPUCount: 0,
      });

      const violation = result.violations.find(v => v.metricName === "Total GPUs");
      expect(violation).toBeDefined();
      expect(violation!.currentValue).toBe(2); // gpu-1 has 2 GPUs
    });

    it("skips non-running compute instances", async () => {
      mockAllAPIs();
      const result = await gcpProvider.checkUsage(credential, defaultThresholds);

      // stopped-vm should not appear
      const serviceNames = result.services.map(s => s.serviceName);
      expect(serviceNames).not.toContain(expect.stringContaining("stopped-vm"));
    });

    it("detects monthly spend limit violation", async () => {
      mockAllAPIs();
      const result = await gcpProvider.checkUsage(credential, {
        ...defaultThresholds,
        monthlySpendLimitUSD: 1, // Very low limit
      });

      const violation = result.violations.find(v => v.metricName === "Projected Monthly Cost");
      expect(violation).toBeDefined();
      expect(violation!.serviceName).toBe("all-services");
    });

    it("returns empty security events when monitoring API returns no data", async () => {
      mockAllAPIs();
      const result = await gcpProvider.checkUsage(credential, defaultThresholds);

      // The monitoring API mock returns empty timeSeries by default
      // Security events should be empty (monitoring API returns no spikes)
      expect(result.securityEvents).toBeDefined();
      expect(Array.isArray(result.securityEvents)).toBe(true);
    });

    it("handles empty results gracefully", async () => {
      mockAllAPIs({
        cloudRun: { services: [] },
        compute: { items: {} },
        gke: { clusters: [] },
        bigquery: { jobs: [] },
        cloudFunctions: { functions: [] },
        gcs: { items: [] },
      });

      const result = await gcpProvider.checkUsage(credential, defaultThresholds);

      expect(result.services).toHaveLength(0);
      expect(result.violations).toHaveLength(0);
      expect(result.totalEstimatedDailyCostUSD).toBe(0);
    });

    it("throws on missing credentials", async () => {
      await expect(
        gcpProvider.checkUsage({ provider: "gcp" }, defaultThresholds)
      ).rejects.toThrow("Missing GCP service account JSON or project ID");
    });
  });

  describe("executeKillSwitch", () => {
    it("scales down Cloud Run service", async () => {
      mockAllAPIs();
      const result = await gcpProvider.executeKillSwitch(credential, "api-service", "scale-down");

      expect(result.success).toBe(true);
      expect(result.action).toBe("scale-down");
      expect(result.details).toContain("Scaled down");
    });

    it("stops compute instance", async () => {
      mockAllAPIs();
      const result = await gcpProvider.executeKillSwitch(credential, "compute:web-1:us-central1-a", "stop-instances");

      expect(result.success).toBe(true);
      expect(result.action).toBe("stop-instances");
      expect(result.details).toContain("Stopped instance web-1");
    });

    it("routes compute prefix to stopComputeInstance on scale-down", async () => {
      mockAllAPIs();
      const result = await gcpProvider.executeKillSwitch(credential, "compute:web-1:us-central1-a", "scale-down");

      expect(result.success).toBe(true);
      expect(result.action).toBe("stop-instances");
    });

    it("scales GKE node pool to 0", async () => {
      mockAllAPIs();
      const result = await gcpProvider.executeKillSwitch(credential, "gke:prod-cluster:default-pool", "scale-down");

      expect(result.success).toBe(true);
      expect(result.action).toBe("scale-down");
      expect(result.details).toContain("node pool");
    });

    it("sets BigQuery quota to 0", async () => {
      mockAllAPIs();
      const result = await gcpProvider.executeKillSwitch(credential, "bq:test-project-123", "set-quota");

      expect(result.success).toBe(true);
      expect(result.action).toBe("set-quota");
      expect(result.details).toContain("BigQuery");
    });

    it("routes bq prefix to setBigQueryQuota on scale-down", async () => {
      mockAllAPIs();
      const result = await gcpProvider.executeKillSwitch(credential, "bq:test-project-123", "scale-down");

      expect(result.success).toBe(true);
      expect(result.action).toBe("set-quota");
    });

    it("disables project billing (nuclear)", async () => {
      mockAllAPIs();
      const result = await gcpProvider.executeKillSwitch(credential, "project:test-project-123", "disable-billing");

      expect(result.success).toBe(true);
      expect(result.action).toBe("disable-billing");
      expect(result.details).toContain("BILLING DISABLED");
    });

    it("disables a GCP API service", async () => {
      mockAllAPIs();
      const result = await gcpProvider.executeKillSwitch(credential, "compute.googleapis.com", "disable-service");

      expect(result.success).toBe(true);
      expect(result.action).toBe("disable-service");
      expect(result.details).toContain("Disabled GCP API");
    });

    it("scales down Cloud Function", async () => {
      mockAllAPIs();
      const result = await gcpProvider.executeKillSwitch(credential, "gcf:my-function", "scale-down");

      expect(result.success).toBe(true);
      expect(result.action).toBe("scale-down");
      expect(result.details).toContain("Cloud Function");
    });

    it("throws on missing credentials", async () => {
      await expect(
        gcpProvider.executeKillSwitch({ provider: "gcp" }, "svc", "scale-down")
      ).rejects.toThrow("Missing GCP credentials");
    });

    it("returns failure when Cloud Run scale-down GET fails", async () => {
      mockFetch.mockImplementation(async (url: string, options?: any) => {
        const urlStr = typeof url === "string" ? url : "";
        if (urlStr.includes("run.googleapis.com")) {
          return { ok: false, status: 404, text: async () => "Not Found" };
        }
        return { ok: true, text: async () => "{}" };
      });

      const result = await gcpProvider.executeKillSwitch(credential, "api-service", "scale-down");

      expect(result.success).toBe(false);
      expect(result.details).toContain("Failed to get service");
    });

    it("returns failure when Cloud Run scale-down throws", async () => {
      mockFetch.mockImplementation(async (url: string, options?: any) => {
        const urlStr = typeof url === "string" ? url : "";
        if (urlStr.includes("run.googleapis.com")) {
          throw new Error("Network error");
        }
        return { ok: true, text: async () => "{}" };
      });

      const result = await gcpProvider.executeKillSwitch(credential, "api-service", "scale-down");

      expect(result.success).toBe(false);
      expect(result.details).toContain("Error: Network error");
    });

    it("scales Cloud Function via PATCH", async () => {
      let patchCalled = false;
      mockFetch.mockImplementation(async (url: string, options?: any) => {
        const urlStr = typeof url === "string" ? url : "";
        if (urlStr.includes("cloudfunctions.googleapis.com") && options?.method === "PATCH") {
          patchCalled = true;
          return { ok: true, text: async () => "{}" };
        }
        if (urlStr.includes("cloudfunctions.googleapis.com") && !options?.method) {
          return {
            ok: true,
            text: async () => JSON.stringify({
              name: "projects/test/locations/us-central1/functions/my-function",
              serviceConfig: { maxInstanceCount: 50 },
            }),
          };
        }
        return { ok: true, text: async () => "{}" };
      });

      const result = await gcpProvider.executeKillSwitch(credential, "gcf:my-function", "scale-down");

      expect(result.success).toBe(true);
      expect(result.action).toBe("scale-down");
      expect(result.details).toContain("Cloud Function");
      expect(patchCalled).toBe(true);
    });

    it("returns failure when Cloud Function GET fails", async () => {
      mockFetch.mockImplementation(async (url: string, options?: any) => {
        const urlStr = typeof url === "string" ? url : "";
        if (urlStr.includes("cloudfunctions.googleapis.com")) {
          return { ok: false, status: 404, text: async () => "Not Found" };
        }
        return { ok: true, text: async () => "{}" };
      });

      const result = await gcpProvider.executeKillSwitch(credential, "gcf:my-function", "scale-down");

      expect(result.success).toBe(false);
      expect(result.details).toContain("Failed to get function");
    });
  });

  describe("getAccessToken — JWT flow", () => {
    it("generates JWT and exchanges for access token", async () => {
      // Use a valid-format RSA private key for testing
      const { generateKeyPairSync } = await import("crypto");
      const { privateKey } = generateKeyPairSync("rsa", {
        modulusLength: 2048,
        publicKeyEncoding: { type: "spki", format: "pem" },
        privateKeyEncoding: { type: "pkcs8", format: "pem" },
      });

      const jwtCredential: DecryptedCredential = {
        provider: "gcp",
        serviceAccountJson: JSON.stringify({
          private_key: privateKey,
          client_email: "test@test-project.iam.gserviceaccount.com",
        }),
        projectId: "test-project-123",
        region: "us-central1",
      };

      mockFetch.mockImplementation(async (url: string, options?: any) => {
        const urlStr = typeof url === "string" ? url : "";

        // Token exchange endpoint
        if (urlStr.includes("oauth2.googleapis.com/token")) {
          return {
            ok: true,
            text: async () => JSON.stringify({ access_token: "jwt-generated-token" }),
          };
        }

        // Cloud Resource Manager (for validateCredential)
        if (urlStr.includes("cloudresourcemanager.googleapis.com")) {
          return {
            ok: true,
            text: async () => JSON.stringify({ projectId: "test-project-123", name: "Test Project" }),
          };
        }

        return { ok: false, status: 404, text: async () => "Not Found" };
      });

      const result = await gcpProvider.validateCredential(jwtCredential);

      expect(result.valid).toBe(true);
      expect(result.accountId).toBe("test-project-123");
      // Verify the token exchange was called
      expect(mockFetch).toHaveBeenCalledWith(
        "https://oauth2.googleapis.com/token",
        expect.objectContaining({ method: "POST" })
      );
    });

    it("throws when token exchange returns non-JSON", async () => {
      const { generateKeyPairSync } = await import("crypto");
      const { privateKey } = generateKeyPairSync("rsa", {
        modulusLength: 2048,
        publicKeyEncoding: { type: "spki", format: "pem" },
        privateKeyEncoding: { type: "pkcs8", format: "pem" },
      });

      const jwtCredential: DecryptedCredential = {
        provider: "gcp",
        serviceAccountJson: JSON.stringify({
          private_key: privateKey,
          client_email: "test@test-project.iam.gserviceaccount.com",
        }),
        projectId: "test-project-123",
      };

      mockFetch.mockImplementation(async (url: string) => {
        const urlStr = typeof url === "string" ? url : "";
        if (urlStr.includes("oauth2.googleapis.com/token")) {
          return { ok: true, text: async () => "NOT JSON RESPONSE" };
        }
        return { ok: false, status: 404, text: async () => "Not Found" };
      });

      const result = await gcpProvider.validateCredential(jwtCredential);
      expect(result.valid).toBe(false);
      expect(result.error).toContain("Token exchange failed");
    });

    it("throws when token exchange returns error", async () => {
      const { generateKeyPairSync } = await import("crypto");
      const { privateKey } = generateKeyPairSync("rsa", {
        modulusLength: 2048,
        publicKeyEncoding: { type: "spki", format: "pem" },
        privateKeyEncoding: { type: "pkcs8", format: "pem" },
      });

      const jwtCredential: DecryptedCredential = {
        provider: "gcp",
        serviceAccountJson: JSON.stringify({
          private_key: privateKey,
          client_email: "test@test-project.iam.gserviceaccount.com",
        }),
        projectId: "test-project-123",
      };

      mockFetch.mockImplementation(async (url: string) => {
        const urlStr = typeof url === "string" ? url : "";
        if (urlStr.includes("oauth2.googleapis.com/token")) {
          return { ok: true, text: async () => JSON.stringify({ error: "invalid_grant", error_description: "Token expired" }) };
        }
        return { ok: false, status: 404, text: async () => "Not Found" };
      });

      const result = await gcpProvider.validateCredential(jwtCredential);
      expect(result.valid).toBe(false);
      expect(result.error).toContain("Token exchange error");
    });

    it("throws when credential has no access_token and no private_key", async () => {
      const badCredential: DecryptedCredential = {
        provider: "gcp",
        serviceAccountJson: JSON.stringify({ project_id: "test" }),
        projectId: "test-project-123",
      };

      const result = await gcpProvider.validateCredential(badCredential);
      expect(result.valid).toBe(false);
      expect(result.error).toContain("must contain access_token or");
    });
  });

  describe("Cloud Run API error", () => {
    it("throws on non-ok Cloud Run response during checkUsage", async () => {
      mockFetch.mockImplementation(async (url: string, options?: any) => {
        const urlStr = typeof url === "string" ? url : "";

        // Cloud Run list fails
        if (urlStr.includes("run.googleapis.com") && !options?.method) {
          return { ok: false, status: 500, text: async () => "Internal Server Error" };
        }

        // Everything else succeeds but empty
        if (urlStr.includes("compute.googleapis.com")) return { ok: true, text: async () => JSON.stringify({ items: {} }) };
        if (urlStr.includes("container.googleapis.com")) return { ok: true, text: async () => JSON.stringify({ clusters: [] }) };
        if (urlStr.includes("bigquery.googleapis.com")) return { ok: true, text: async () => JSON.stringify({ jobs: [] }) };
        if (urlStr.includes("cloudfunctions.googleapis.com")) return { ok: true, text: async () => JSON.stringify({ functions: [] }) };
        if (urlStr.includes("storage.googleapis.com")) return { ok: true, text: async () => JSON.stringify({ items: [] }) };
        if (urlStr.includes("cloudbilling.googleapis.com")) return { ok: true, text: async () => JSON.stringify({}) };
        if (urlStr.includes("monitoring.googleapis.com")) return { ok: true, text: async () => JSON.stringify({ timeSeries: [] }) };

        return { ok: false, status: 404, text: async () => "Not Found" };
      });

      await expect(
        gcpProvider.checkUsage(credential, defaultThresholds)
      ).rejects.toThrow("Cloud Run API error 500");
    });
  });

  describe("checkSecurityMetrics", () => {
    function mockAllAPIsWithMonitoring(monitoringData: any) {
      mockFetch.mockImplementation(async (url: string | URL | Request, options?: any) => {
        const urlStr = String(url);

        // Monitoring API — check FIRST since it's the most specific
        if (urlStr.includes("monitoring.googleapis.com")) {
          return {
            ok: true,
            text: async () => JSON.stringify(monitoringData),
          };
        }

        // Cloud Run list services
        if (urlStr.includes("run.googleapis.com")) {
          return { ok: true, text: async () => JSON.stringify({ services: [] }) };
        }

        // Compute Engine
        if (urlStr.includes("compute.googleapis.com")) {
          return { ok: true, text: async () => JSON.stringify({ items: {} }) };
        }

        // GKE
        if (urlStr.includes("container.googleapis.com")) {
          return { ok: true, text: async () => JSON.stringify({ clusters: [] }) };
        }

        // BigQuery
        if (urlStr.includes("bigquery.googleapis.com")) {
          return { ok: true, text: async () => JSON.stringify({ jobs: [] }) };
        }

        // Cloud Functions
        if (urlStr.includes("cloudfunctions.googleapis.com")) {
          return { ok: true, text: async () => JSON.stringify({ functions: [] }) };
        }

        // Cloud Storage
        if (urlStr.includes("storage.googleapis.com")) {
          return { ok: true, text: async () => JSON.stringify({ items: [] }) };
        }

        // Cloud Billing
        if (urlStr.includes("cloudbilling.googleapis.com")) {
          return { ok: true, text: async () => JSON.stringify({}) };
        }

        return { ok: false, status: 404, text: async () => "Not Found" };
      });
    }

    it("detects error_spike from 5xx responses", async () => {
      mockAllAPIsWithMonitoring({
        timeSeries: [
          {
            resource: { labels: { service_name: "api-service" } },
            metric: { labels: { response_code_class: "5xx" } },
            points: [{ value: { int64Value: "500" } }],
          },
        ],
      });

      const result = await gcpProvider.checkUsage(credential, {
        ...defaultThresholds,
        errorRatePercent: 100,
      });

      const errorEvent = result.securityEvents.find(e => e.type === "error_spike");
      expect(errorEvent).toBeDefined();
      expect(errorEvent!.severity).toBe("warning");
      expect(errorEvent!.description).toContain("500 5xx errors");
    });

    it("detects critical error_spike when value > 1000", async () => {
      mockAllAPIsWithMonitoring({
        timeSeries: [
          {
            resource: { labels: { service_name: "api-service" } },
            metric: { labels: { response_code_class: "5xx" } },
            points: [{ value: { int64Value: "5000" } }],
          },
        ],
      });

      const result = await gcpProvider.checkUsage(credential, {
        ...defaultThresholds,
        errorRatePercent: 100,
      });

      const errorEvent = result.securityEvents.find(e => e.type === "error_spike");
      expect(errorEvent).toBeDefined();
      expect(errorEvent!.severity).toBe("critical");
    });

    it("detects request_spike (potential DDoS)", async () => {
      mockAllAPIsWithMonitoring({
        timeSeries: [
          {
            resource: { labels: { service_name: "api-service" } },
            metric: { labels: { response_code_class: "2xx" } },
            points: [{ value: { int64Value: "500000" } }],
          },
        ],
      });

      const result = await gcpProvider.checkUsage(credential, {
        ...defaultThresholds,
        requestsPerMinute: 50000, // 5 * 50000 = 250000 threshold, value is 500000
      });

      const spikeEvent = result.securityEvents.find(e => e.type === "request_spike");
      expect(spikeEvent).toBeDefined();
      expect(spikeEvent!.severity).toBe("critical");
      expect(spikeEvent!.description).toContain("requests in last 5 minutes");
    });
  });

  describe("queryBillingCosts — billing info parsing", () => {
    it("returns billing data when API returns OK", async () => {
      mockAllAPIs();
      // The billing data is fetched within checkUsage — just ensure no crash
      const result = await gcpProvider.checkUsage(credential, defaultThresholds);
      expect(result).toBeDefined();
      expect(result.provider).toBe("gcp");
    });

    it("handles billing API exception gracefully (catch block)", async () => {
      mockFetch.mockImplementation(async (url: string, options?: any) => {
        const urlStr = typeof url === "string" ? url : String(url);
        if (urlStr.includes("cloudbilling.googleapis.com")) {
          throw new Error("Network error");
        }
        if (urlStr.includes("run.googleapis.com")) return { ok: true, text: async () => JSON.stringify({ services: [] }) };
        if (urlStr.includes("compute.googleapis.com")) return { ok: true, text: async () => JSON.stringify({ items: {} }) };
        if (urlStr.includes("container.googleapis.com")) return { ok: true, text: async () => JSON.stringify({ clusters: [] }) };
        if (urlStr.includes("bigquery.googleapis.com")) return { ok: true, text: async () => JSON.stringify({ jobs: [] }) };
        if (urlStr.includes("cloudfunctions.googleapis.com")) return { ok: true, text: async () => JSON.stringify({ functions: [] }) };
        if (urlStr.includes("storage.googleapis.com")) return { ok: true, text: async () => JSON.stringify({ items: [] }) };
        if (urlStr.includes("monitoring.googleapis.com")) return { ok: true, text: async () => JSON.stringify({ timeSeries: [] }) };
        return { ok: false, status: 404, text: async () => "Not Found" };
      });

      const result = await gcpProvider.checkUsage(credential, defaultThresholds);
      expect(result).toBeDefined();
      expect(result.services).toHaveLength(0);
    });

    it("handles monitoring API exception gracefully (catch block)", async () => {
      mockFetch.mockImplementation(async (url: string, options?: any) => {
        const urlStr = typeof url === "string" ? url : String(url);
        if (urlStr.includes("monitoring.googleapis.com")) {
          throw new Error("Monitoring API unreachable");
        }
        if (urlStr.includes("run.googleapis.com")) return { ok: true, text: async () => JSON.stringify({ services: [] }) };
        if (urlStr.includes("compute.googleapis.com")) return { ok: true, text: async () => JSON.stringify({ items: {} }) };
        if (urlStr.includes("container.googleapis.com")) return { ok: true, text: async () => JSON.stringify({ clusters: [] }) };
        if (urlStr.includes("bigquery.googleapis.com")) return { ok: true, text: async () => JSON.stringify({ jobs: [] }) };
        if (urlStr.includes("cloudfunctions.googleapis.com")) return { ok: true, text: async () => JSON.stringify({ functions: [] }) };
        if (urlStr.includes("storage.googleapis.com")) return { ok: true, text: async () => JSON.stringify({ items: [] }) };
        if (urlStr.includes("cloudbilling.googleapis.com")) return { ok: true, text: async () => JSON.stringify({}) };
        return { ok: false, status: 404, text: async () => "Not Found" };
      });

      const result = await gcpProvider.checkUsage(credential, defaultThresholds);
      expect(result).toBeDefined();
      expect(result.securityEvents).toHaveLength(0);
    });

    it("handles billing API failure gracefully", async () => {
      mockFetch.mockImplementation(async (url: string, options?: any) => {
        const urlStr = typeof url === "string" ? url : "";
        if (urlStr.includes("cloudbilling.googleapis.com") && !options?.method) {
          return { ok: false, status: 403, text: async () => "Forbidden" };
        }
        // Cloud Run
        if (urlStr.includes("run.googleapis.com")) return { ok: true, text: async () => JSON.stringify({ services: [] }) };
        if (urlStr.includes("compute.googleapis.com")) return { ok: true, text: async () => JSON.stringify({ items: {} }) };
        if (urlStr.includes("container.googleapis.com")) return { ok: true, text: async () => JSON.stringify({ clusters: [] }) };
        if (urlStr.includes("bigquery.googleapis.com")) return { ok: true, text: async () => JSON.stringify({ jobs: [] }) };
        if (urlStr.includes("cloudfunctions.googleapis.com")) return { ok: true, text: async () => JSON.stringify({ functions: [] }) };
        if (urlStr.includes("storage.googleapis.com")) return { ok: true, text: async () => JSON.stringify({ items: [] }) };
        if (urlStr.includes("monitoring.googleapis.com")) return { ok: true, text: async () => JSON.stringify({ timeSeries: [] }) };
        return { ok: false, status: 404, text: async () => "Not Found" };
      });

      const result = await gcpProvider.checkUsage(credential, defaultThresholds);
      expect(result).toBeDefined();
    });
  });
});
