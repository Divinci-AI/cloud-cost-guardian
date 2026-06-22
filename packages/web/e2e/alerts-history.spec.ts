import { test, expect } from "@playwright/test";

const API_URL = process.env.VITE_API_URL || "http://localhost:8090";

// Regression guard: the Alerts page calls GET /alerts/history. This route was
// once missing entirely and the page silently rendered "No alerts yet" — so
// assert the route exists (auth-gated, not 404) rather than just that the
// page doesn't crash.
test.describe("Alert History API", () => {
  test.beforeEach(async ({ request }) => {
    try {
      await request.get(`${API_URL}/`, { timeout: 2000 });
    } catch {
      test.skip(true, "API server not running");
    }
  });

  test("GET /alerts/history exists (401 without auth, never 404)", async ({ request }) => {
    const response = await request.get(`${API_URL}/alerts/history`);
    expect(response.status()).not.toBe(404);
    expect([200, 401, 403]).toContain(response.status());
  });

  test("GET /alerts/history with API key returns alerts array", async ({ request }) => {
    const apiKey = process.env.KILL_SWITCH_API_KEY;
    test.skip(!apiKey, "KILL_SWITCH_API_KEY not set");

    const response = await request.get(`${API_URL}/alerts/history`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    expect(response.ok()).toBeTruthy();
    const data = await response.json();
    expect(Array.isArray(data.alerts)).toBeTruthy();
  });
});
