import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("jose", () => ({
  importPKCS8: vi.fn().mockResolvedValue({}),
  SignJWT: vi.fn().mockImplementation(() => ({
    setProtectedHeader: vi.fn().mockReturnThis(),
    setIssuer: vi.fn().mockReturnThis(),
    setAudience: vi.fn().mockReturnThis(),
    setIssuedAt: vi.fn().mockReturnThis(),
    setExpirationTime: vi.fn().mockReturnThis(),
    sign: vi.fn().mockResolvedValue("mock.jwt.token"),
  })),
}));

import { captureSnapshot } from "../../src/services/forensics.js";
import type { DecryptedCredential } from "../../src/providers/types.js";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

describe("Forensic Snapshot Service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("captureSnapshot", () => {
    it("returns a snapshot with integrity hash", async () => {
      mockFetch.mockResolvedValue({ ok: false, text: async () => "error" });

      const credential: DecryptedCredential = {
        provider: "cloudflare",
        apiToken: "test-token",
        accountId: "test-account",
      };

      const snapshot = await captureSnapshot(credential, "my-worker", "cost-runaway", "incident-123");

      expect(snapshot.id).toMatch(/^snap-/);
      expect(snapshot.incidentId).toBe("incident-123");
      expect(snapshot.provider).toBe("cloudflare");
      expect(snapshot.serviceName).toBe("my-worker");
      expect(snapshot.trigger).toBe("cost-runaway");
      expect(snapshot.capturedAt).toBeGreaterThan(0);
      expect(snapshot.integrityHash).toMatch(/^[a-f0-9]{64}$/); // SHA-256 hex
    });

    it("integrity hash changes when data changes", async () => {
      mockFetch
        .mockResolvedValueOnce({ ok: true, text: async () => JSON.stringify({ result: { bindings: [] } }) })
        .mockResolvedValueOnce({ ok: false, text: async () => "error" })
        .mockResolvedValueOnce({ ok: false, text: async () => "error" });

      const cred: DecryptedCredential = { provider: "cloudflare", apiToken: "tok", accountId: "acc" };

      const snap1 = await captureSnapshot(cred, "worker-a", "trigger-1", "inc-1");

      mockFetch
        .mockResolvedValueOnce({ ok: true, text: async () => JSON.stringify({ result: { bindings: [{ type: "kv", name: "MY_KV" }] } }) })
        .mockResolvedValueOnce({ ok: false, text: async () => "error" })
        .mockResolvedValueOnce({ ok: false, text: async () => "error" });

      const snap2 = await captureSnapshot(cred, "worker-a", "trigger-1", "inc-2");

      // Different data = different hash
      expect(snap1.integrityHash).not.toBe(snap2.integrityHash);
    });

    it("captures Cloudflare service config", async () => {
      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          text: async () => JSON.stringify({
            result: {
              bindings: [
                { type: "plain_text", name: "API_KEY" },
                { type: "secret_text", name: "DB_PASSWORD" },
                { type: "kv_namespace", name: "MY_KV" },
              ],
              compatibility_date: "2024-09-23",
              usage_model: "standard",
            },
          }),
        })
        .mockResolvedValueOnce({ ok: false, text: async () => "" }) // metrics
        .mockResolvedValueOnce({ ok: false, text: async () => "" }); // domains

      const cred: DecryptedCredential = { provider: "cloudflare", apiToken: "tok", accountId: "acc" };
      const snapshot = await captureSnapshot(cred, "my-worker", "test", "inc");

      // Should capture env var NAMES but never values
      expect(snapshot.data.environmentVariables).toContain("API_KEY");
      expect(snapshot.data.environmentVariables).toContain("DB_PASSWORD");
      expect(snapshot.data.environmentVariables).not.toContain("MY_KV"); // KV is not a text var

      // Config captured
      expect(snapshot.data.serviceConfig).toBeDefined();
      expect((snapshot.data.serviceConfig as any).compatibilityDate).toBe("2024-09-23");
    });

    it("captures Cloudflare custom domains", async () => {
      mockFetch
        .mockResolvedValueOnce({ ok: false, text: async () => "" }) // settings
        .mockResolvedValueOnce({ ok: false, text: async () => "" }) // metrics
        .mockResolvedValueOnce({
          ok: true,
          text: async () => JSON.stringify({
            result: [
              { hostname: "api.example.com" },
              { hostname: "ws.example.com" },
            ],
          }),
        });

      const cred: DecryptedCredential = { provider: "cloudflare", apiToken: "tok", accountId: "acc" };
      const snapshot = await captureSnapshot(cred, "my-worker", "test", "inc");

      expect((snapshot.data.networkRules as any)?.customDomains).toEqual(["api.example.com", "ws.example.com"]);
    });

    it("handles API failures gracefully (non-fatal)", async () => {
      mockFetch.mockRejectedValue(new Error("Network error"));

      const cred: DecryptedCredential = { provider: "cloudflare", apiToken: "tok", accountId: "acc" };

      // Should not throw
      const snapshot = await captureSnapshot(cred, "my-worker", "test", "inc");

      expect(snapshot.id).toMatch(/^snap-/);
      expect(snapshot.integrityHash).toBeTruthy();
    });

    it("handles GCP provider", async () => {
      const cred: DecryptedCredential = {
        provider: "gcp",
        serviceAccountJson: JSON.stringify({
          client_email: "sa@my-project.iam.gserviceaccount.com",
          private_key: "-----BEGIN PRIVATE KEY-----\nMOCK\n-----END PRIVATE KEY-----\n",
        }),
        projectId: "my-project",
        region: "us-central1",
      };

      mockFetch
        // OAuth2 token exchange
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ access_token: "ya29.mock-access-token" }),
        })
        // Cloud Run service config
        .mockResolvedValueOnce({
          ok: true,
          text: async () => JSON.stringify({
            template: {
              scaling: { minInstanceCount: 0, maxInstanceCount: 10 },
              containers: [{
                image: "gcr.io/my-project/my-service:latest",
                resources: { limits: { cpu: "2", memory: "2Gi" } },
                env: [{ name: "NODE_ENV" }, { name: "API_KEY" }],
              }],
            },
            latestReadyRevision: "my-service-00005-abc",
          }),
        })
        .mockResolvedValueOnce({ ok: false, text: async () => "" }); // logs

      const snapshot = await captureSnapshot(cred, "my-service", "cost-spike", "inc");

      expect(snapshot.provider).toBe("gcp");
      expect(snapshot.data.environmentVariables).toContain("NODE_ENV");
      expect(snapshot.data.environmentVariables).toContain("API_KEY");
      expect((snapshot.data.serviceConfig as any)?.latestRevision).toBe("my-service-00005-abc");
    });

    it("generates unique snapshot IDs", async () => {
      mockFetch.mockResolvedValue({ ok: false, text: async () => "" });
      const cred: DecryptedCredential = { provider: "cloudflare", apiToken: "t", accountId: "a" };

      const snap1 = await captureSnapshot(cred, "w", "t", "i");
      const snap2 = await captureSnapshot(cred, "w", "t", "i");

      expect(snap1.id).not.toBe(snap2.id);
    });
  });
});
