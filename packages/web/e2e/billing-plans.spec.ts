import { test, expect } from "@playwright/test";

const API_URL = process.env.VITE_API_URL || "http://localhost:8090";

test.describe("Billing Plans API (public endpoint)", () => {
  test.beforeEach(async ({ request }) => {
    // Skip tests if API server is not running
    try {
      await request.get(`${API_URL}/`, { timeout: 2000 });
    } catch {
      test.skip(true, "API server not running");
    }
  });

  test("GET /billing/plans returns valid plan data", async ({ request }) => {
    const response = await request.get(`${API_URL}/billing/plans`);

    expect(response.ok()).toBeTruthy();
    const data = await response.json();

    expect(data.plans).toHaveLength(3);

    // Verify no free tier
    const free = data.plans.find((p: any) => p.tier === "free");
    expect(free).toBeUndefined();

    // Verify pro tier
    const pro = data.plans.find((p: any) => p.tier === "pro");
    expect(pro).toBeDefined();
    expect(pro.monthlyPrice).toBe(29);
    expect(pro.annualPrice).toBe(290);
    expect(pro.priceIds).toBeDefined();
    expect(pro.limits.cloudAccounts).toBe(3);

    // Verify team tier
    const team = data.plans.find((p: any) => p.tier === "team");
    expect(team).toBeDefined();
    expect(team.monthlyPrice).toBe(99);
    expect(team.features).toContain("Team roles");

    // Verify enterprise tier
    const enterprise = data.plans.find((p: any) => p.tier === "enterprise");
    expect(enterprise).toBeDefined();
    expect(enterprise.contactUs).toBe(true);
  });

  test("plans include all expected features", async ({ request }) => {
    const response = await request.get(`${API_URL}/billing/plans`);
    const data = await response.json();

    const pro = data.plans.find((p: any) => p.tier === "pro");
    expect(pro.features.length).toBeGreaterThanOrEqual(4);

    const team = data.plans.find((p: any) => p.tier === "team");
    expect(team.features).toContain("Audit log");
    expect(team.features).toContain("API access");

    const enterprise = data.plans.find((p: any) => p.tier === "enterprise");
    expect(enterprise.features).toContain("SSO/SAML");
  });
});
