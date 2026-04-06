import { defineConfig } from "vitest/config";

/**
 * Root vitest config — scopes test discovery to the API package only.
 *
 * Without this, running `npx vitest` from the repo root picks up
 * packages/web/e2e/*.spec.ts (Playwright tests), which fail because
 * vitest can't run Playwright's test runner. Those e2e tests should be
 * run with `npx playwright test` inside packages/web.
 */
export default defineConfig({
  test: {
    include: ["packages/api/tests/**/*.test.ts"],
    exclude: [
      "packages/web/e2e/**",
      "**/node_modules/**",
      "**/coverage/**",
    ],
  },
});
