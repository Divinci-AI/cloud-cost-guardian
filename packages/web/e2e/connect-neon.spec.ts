import { test, expect } from "@playwright/test";

/**
 * ConnectNeon Page — UI structure tests
 *
 * These tests verify the page renders correctly at the unauthenticated level
 * (the page itself renders before Clerk's auth gate intervenes for connect pages).
 * API interaction tests live in onboarding-ui.spec.ts.
 */
test.describe("ConnectNeon — page structure", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/accounts/connect/neon");
    // Allow React + Clerk to mount
    await page.waitForTimeout(2000);
  });

  test("page loads without JavaScript errors", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", err => errors.push(err.message));

    await page.goto("/accounts/connect/neon");
    await page.waitForTimeout(2000);

    const appErrors = errors.filter(e => !e.includes("clerk") && !e.includes("Clerk"));
    expect(appErrors).toHaveLength(0);
  });

  test("responds with 200 status", async ({ page }) => {
    const response = await page.goto("/accounts/connect/neon");
    expect(response?.ok()).toBeTruthy();
  });
});

test.describe("ConnectNeon — form fields (API contract)", () => {
  test("neon provider validation endpoint exists", async ({ request }) => {
    const API_URL = process.env.VITE_API_URL || "http://localhost:8090";
    try {
      await request.get(`${API_URL}/`, { timeout: 2000 });
    } catch {
      test.skip(true, "API server not running");
    }

    const res = await request.post(`${API_URL}/providers/neon/validate`, {
      data: { neonApiKey: "test" },
    });
    // Should return 200, 400, or 401 — never 404
    expect(res.status()).not.toBe(404);
  });

  test("neon provider validation rejects empty credentials", async ({ request }) => {
    const API_URL = process.env.VITE_API_URL || "http://localhost:8090";
    try {
      await request.get(`${API_URL}/`, { timeout: 2000 });
    } catch {
      test.skip(true, "API server not running");
    }

    const res = await request.post(`${API_URL}/providers/neon/validate`, {
      data: {},
    });
    // Empty creds should return 400 or a 200 with valid: false — not 404 or 500
    expect([200, 400, 401]).toContain(res.status());
    if (res.status() === 200) {
      const body = await res.json();
      expect(body.valid).toBe(false);
    }
  });
});
