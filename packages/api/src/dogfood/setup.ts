#!/usr/bin/env tsx
/**
 * Dogfood Setup Script
 *
 * Sets up the Kill Switch to monitor its own Cloudflare infrastructure.
 * Uses the Kill Switch API to connect the account, configure thresholds,
 * apply protection rules, and run an initial check.
 *
 * Usage:
 *   GUARDIAN_API_URL=https://api.kill-switch.net \
 *   GUARDIAN_API_KEY=ks_live_... \
 *   CF_API_TOKEN=... \
 *   tsx packages/api/src/dogfood/setup.ts
 *
 * Or for local dev:
 *   GUARDIAN_API_URL=http://localhost:3001 \
 *   GUARDIAN_DEV_ACCOUNT_ID=test-account \
 *   GUARDIAN_DEV_USER_ID=test-user \
 *   CF_API_TOKEN=... \
 *   tsx packages/api/src/dogfood/setup.ts
 */

import {
  buildDogfoodAccountPayload,
  buildDogfoodUpdatePayload,
  getDogfoodRules,
  DOGFOOD_ACCOUNT_NAME,
} from "./config.js";

const API_URL = process.env.GUARDIAN_API_URL || "http://localhost:3001";
const API_KEY = process.env.GUARDIAN_API_KEY;
const DEV_ACCOUNT_ID = process.env.GUARDIAN_DEV_ACCOUNT_ID;
const DEV_USER_ID = process.env.GUARDIAN_DEV_USER_ID;
const CF_API_TOKEN = process.env.CF_API_TOKEN;

function getAuthHeaders(): Record<string, string> {
  if (API_KEY) {
    return { Authorization: `Bearer ${API_KEY}` };
  }
  if (DEV_ACCOUNT_ID && DEV_USER_ID) {
    return {
      "X-Guardian-Account-Id": DEV_ACCOUNT_ID,
      "X-Guardian-User-Id": DEV_USER_ID,
    };
  }
  throw new Error(
    "Set GUARDIAN_API_KEY or both GUARDIAN_DEV_ACCOUNT_ID and GUARDIAN_DEV_USER_ID"
  );
}

async function apiRequest(method: string, path: string, body?: unknown): Promise<any> {
  const res = await fetch(`${API_URL}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...getAuthHeaders(),
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const data = await res.json();
  if (!res.ok) {
    throw new Error(`${method} ${path} failed (${res.status}): ${JSON.stringify(data)}`);
  }
  return data;
}

async function main() {
  if (!CF_API_TOKEN) {
    console.error("Error: CF_API_TOKEN is required");
    process.exit(1);
  }

  console.log(`\n🔧 Kill Switch Dogfood Setup`);
  console.log(`   API: ${API_URL}\n`);

  // Step 1: Connect the Cloudflare account
  console.log("1. Connecting Cloudflare account...");
  const accountPayload = buildDogfoodAccountPayload({ apiToken: CF_API_TOKEN });

  let cloudAccountId: string;
  try {
    const created = await apiRequest("POST", "/cloud-accounts", accountPayload);
    cloudAccountId = created.id;
    console.log(`   Created cloud account: ${cloudAccountId}`);
  } catch (err: any) {
    // Account may already exist — find it
    const list = await apiRequest("GET", "/cloud-accounts");
    const existing = list.accounts?.find(
      (a: any) => a.name === DOGFOOD_ACCOUNT_NAME && a.provider === "cloudflare"
    );
    if (existing) {
      cloudAccountId = existing.id;
      console.log(`   Found existing account: ${cloudAccountId}`);
    } else {
      throw err;
    }
  }

  // Step 2: Configure thresholds and protected services
  console.log("2. Configuring thresholds and protected services...");
  const updatePayload = buildDogfoodUpdatePayload();
  await apiRequest("PUT", `/cloud-accounts/${cloudAccountId}`, updatePayload);
  console.log(`   Thresholds set (monthly limit: $${updatePayload.thresholds.monthlySpendLimitUSD})`);
  console.log(`   Protected workers: ${updatePayload.protectedServices.join(", ")}`);

  // Step 3: Apply dogfood rules
  console.log("3. Applying dogfood rules...");
  const rules = getDogfoodRules();
  for (const rule of rules) {
    try {
      await apiRequest("POST", "/rules", rule);
      console.log(`   Applied rule: ${rule.name}`);
    } catch (err: any) {
      // Rule may already exist — try updating
      try {
        await apiRequest("PUT", `/rules/${rule.id}`, rule);
        console.log(`   Updated rule: ${rule.name}`);
      } catch {
        console.warn(`   Warning: Could not apply rule ${rule.name}: ${err.message}`);
      }
    }
  }

  // Step 4: Apply cost-runaway preset
  console.log("4. Applying cost-runaway preset...");
  try {
    await apiRequest("POST", "/rules/presets/cost-runaway", { dailyCostUSD: 10 });
    console.log("   Applied cost-runaway preset ($10/day limit)");
  } catch {
    console.log("   Cost-runaway preset already applied or skipped");
  }

  // Step 5: Run initial check
  console.log("5. Running initial check...");
  try {
    const result = await apiRequest("POST", `/cloud-accounts/${cloudAccountId}/check`);
    console.log(`   Check status: ${result.status || "completed"}`);
    if (result.violations?.length > 0) {
      console.log(`   Violations found: ${result.violations.length}`);
      for (const v of result.violations) {
        console.log(`     - ${v.serviceName}: ${v.metricName} = ${v.currentValue} (threshold: ${v.threshold})`);
      }
    } else {
      console.log("   No violations — all clear");
    }
    if (result.actionsTaken?.length > 0) {
      console.log(`   Actions taken: ${result.actionsTaken.join(", ")}`);
    }
  } catch (err: any) {
    console.warn(`   Initial check skipped: ${err.message}`);
  }

  console.log("\n✅ Dogfood setup complete!\n");
  console.log("The kill switch is now monitoring its own infrastructure.");
  console.log("Protected workers (will never be killed):");
  console.log("  - kill-switch-cf (kill switch cron worker)");
  console.log("  - api-proxy (CF→Cloud Run proxy)\n");
}

main().catch((err) => {
  console.error("\n❌ Setup failed:", err.message);
  process.exit(1);
});
