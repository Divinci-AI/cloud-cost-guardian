import { test, expect } from "@playwright/test";

const API_URL = process.env.VITE_API_URL || "http://localhost:8090";

test.describe("Onboarding Flow (API contract)", () => {
  test.beforeEach(async ({ request }) => {
    // Skip tests if API server is not running
    try {
      await request.get(`${API_URL}/`, { timeout: 2000 });
    } catch {
      test.skip(true, "API server not running");
    }
  });

  test("provider validation endpoint exists and responds", async ({ request }) => {
    const res = await request.post(`${API_URL}/providers/cloudflare/validate`, {
      data: { apiToken: "test", accountId: "test" },
    });
    // Should be 200, 401, or 400 — but NOT 404
    expect(res.status()).not.toBe(404);
  });

  test("all supported providers have validation endpoints", async ({ request }) => {
    const providers = [
      "cloudflare", "gcp", "aws", "runpod", "openai", "anthropic",
      "xai", "replicate", "vercel", "datadog", "snowflake", "redis", "mongodb",
    ];

    for (const provider of providers) {
      const res = await request.post(`${API_URL}/providers/${provider}/validate`, {
        data: {},
      });
      expect(res.status(), `Provider ${provider} should exist`).not.toBe(404);
    }
  });

  test("rule presets endpoint returns expected presets", async ({ request }) => {
    const res = await request.get(`${API_URL}/rules/presets`);
    expect(res.ok()).toBeTruthy();
    const data = await res.json();
    expect(data.presets.length).toBeGreaterThanOrEqual(3);

    const presetIds = data.presets.map((p: any) => p.id);
    expect(presetIds).toContain("cost-runaway");
    expect(presetIds).toContain("ddos");
    expect(presetIds).toContain("error-storm");
  });
});

test.describe("Onboarding UI Structure", () => {
  test("app loads without errors", async ({ page }) => {
    const response = await page.goto("/");
    expect(response?.ok()).toBeTruthy();

    // Check no JavaScript errors
    const errors: string[] = [];
    page.on("pageerror", err => errors.push(err.message));
    await page.waitForTimeout(2000);
    // Filter out expected Clerk/third-party errors
    const appErrors = errors.filter(e => !e.includes("clerk") && !e.includes("Clerk"));
    expect(appErrors).toHaveLength(0);
  });

  test("invite page loads without crash", async ({ page }) => {
    const response = await page.goto("/invite?token=test-token");
    expect(response?.ok()).toBeTruthy();
  });
});
