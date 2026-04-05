import { test, expect } from "@playwright/test";

test.describe("Authentication Redirect", () => {
  test("unauthenticated users do not see the dashboard", async ({ page }) => {
    await page.goto("/");
    await page.waitForTimeout(3000);

    // The dashboard nav bar should NOT be visible without auth
    const navLinks = await page.locator("nav a").count();
    // Clerk's RedirectToSignIn will either redirect or show blank dark page
    // In either case, there should be no dashboard navigation
    expect(navLinks).toBe(0);
  });

  test("protected routes render no app content without auth", async ({ page }) => {
    for (const path of ["/billing", "/settings", "/accounts"]) {
      await page.goto(path);
      await page.waitForTimeout(2000);
      // Should not see dashboard nav items
      const dashboardLink = page.locator('a[href="/"]', { hasText: "Dashboard" });
      await expect(dashboardLink).toHaveCount(0);
    }
  });
});
