import { describe, it, expect } from "vitest";
import { getProvider, getAllProviders } from "../../src/providers/index.js";

describe("Provider Registry", () => {
  describe("getProvider", () => {
    it("returns cloudflare provider", () => {
      const provider = getProvider("cloudflare");
      expect(provider).toBeDefined();
      expect(provider!.id).toBe("cloudflare");
      expect(provider!.name).toBe("Cloudflare");
    });

    it("returns gcp provider", () => {
      const provider = getProvider("gcp");
      expect(provider).toBeDefined();
      expect(provider!.id).toBe("gcp");
      expect(provider!.name).toBe("Google Cloud Platform");
    });

    it("returns aws provider", () => {
      const provider = getProvider("aws");
      expect(provider).toBeDefined();
      expect(provider!.id).toBe("aws");
      expect(provider!.name).toBe("Amazon Web Services");
    });

    it("returns runpod provider", () => {
      const provider = getProvider("runpod");
      expect(provider).toBeDefined();
      expect(provider!.id).toBe("runpod");
      expect(provider!.name).toBe("RunPod");
    });

    it("returns undefined for unknown provider", () => {
      const provider = getProvider("azure" as any);
      expect(provider).toBeUndefined();
    });
  });

  describe("getAllProviders", () => {
    it("returns all six providers", () => {
      const providers = getAllProviders();
      expect(providers).toHaveLength(6);

      const ids = providers.map(p => p.id);
      expect(ids).toContain("cloudflare");
      expect(ids).toContain("gcp");
      expect(ids).toContain("aws");
      expect(ids).toContain("runpod");
      expect(ids).toContain("redis");
      expect(ids).toContain("mongodb");
    });

    it("all providers implement the CloudProvider interface", () => {
      for (const provider of getAllProviders()) {
        expect(typeof provider.checkUsage).toBe("function");
        expect(typeof provider.executeKillSwitch).toBe("function");
        expect(typeof provider.validateCredential).toBe("function");
        expect(typeof provider.getDefaultThresholds).toBe("function");
        expect(typeof provider.id).toBe("string");
        expect(typeof provider.name).toBe("string");
      }
    });

    it("all providers return valid default thresholds", () => {
      for (const provider of getAllProviders()) {
        const thresholds = provider.getDefaultThresholds();
        expect(typeof thresholds).toBe("object");
        // Every threshold value should be a number
        for (const [key, value] of Object.entries(thresholds)) {
          if (value !== undefined) {
            expect(typeof value).toBe("number");
          }
        }
      }
    });
  });
});
