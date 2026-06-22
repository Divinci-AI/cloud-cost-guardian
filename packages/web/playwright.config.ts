import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: "html",
  use: {
    baseURL: "http://localhost:3000",
    trace: "on-first-retry",
    screenshot: "only-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: {
    // Publishable key only (safe for clients); override via env when testing against another Clerk instance
    command: `VITE_CLERK_PUBLISHABLE_KEY=${process.env.VITE_CLERK_PUBLISHABLE_KEY || "pk_live_Y2xlcmsua2lsbC1zd2l0Y2gubmV0JA"} npm run dev`,
    url: "http://localhost:3000",
    reuseExistingServer: !process.env.CI,
    timeout: 30000,
  },
});
