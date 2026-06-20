import { defineConfig } from "vitest/config";
import { loadEnv } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig(({ command, mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  // Without the key, the unconditional `throw` guard in src/index.tsx lets
  // rollup dead-code-eliminate the ENTIRE app — the build "succeeds" but
  // emits a husk that throws on load. Fail the build instead.
  if (command === "build" && !env.VITE_CLERK_PUBLISHABLE_KEY) {
    throw new Error(
      "VITE_CLERK_PUBLISHABLE_KEY must be set at build time. " +
      "Use the root `npm run deploy:web` (which sets it), or export it before building.",
    );
  }
  return {
    plugins: [react()],
    server: {
      port: 3000,
    },
    test: {
      environment: "jsdom",
      globals: true,
      setupFiles: ["./src/test/setup.ts"],
      include: ["src/**/*.test.{ts,tsx}"],
    },
  };
});
