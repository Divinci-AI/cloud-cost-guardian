#!/usr/bin/env tsx
/**
 * Divinci Production Atlas — Kill Switch Setup
 *
 * Applies the reality-based, alert-only integration in
 * `divinci-prod-atlas.config.ts` to the kill switch, REPLACING the original
 * guessed thresholds that caused two production-MongoDB outages (the kill
 * switch `pause-cluster`'d the cluster when real storage crossed the old 10GB
 * line). See that config file's header for the measured baseline + rationale.
 *
 * It UPDATES the EXISTING Divinci mongodb cloud-account (it does not want a
 * duplicate — the existing one is what's been pausing prod), setting:
 *   - reality-based thresholds (storage 100GB, conns 1200, ops 5000, $40/day,
 *     $1200/mo) — only a genuine runaway trips them
 *   - the prod cluster PROTECTED + autoDisconnect/autoDelete OFF (never auto-pause)
 *   - alert-only (`snapshot`) rules
 *
 * Usage:
 *   GUARDIAN_API_URL=https://api.kill-switch.net \
 *   GUARDIAN_API_KEY=ks_live_... \
 *   ATLAS_PUBLIC_KEY=... ATLAS_PRIVATE_KEY=... ATLAS_PROJECT_ID=... \
 *   tsx packages/api/src/dogfood/divinci-prod-atlas.setup.ts
 *
 * (Atlas creds: private-keys/production/atlas-api.env in the Divinci server repo.)
 */

import {
  buildDivinciProdAtlasAccountPayload,
  buildDivinciProdAtlasUpdatePayload,
  getDivinciProdAtlasRules,
  DIVINCI_PROD_ATLAS_ACCOUNT_NAME,
  DIVINCI_PROD_ATLAS_CLUSTER,
} from "./divinci-prod-atlas.config.js";

const API_URL = process.env.GUARDIAN_API_URL || "http://localhost:3001";
const API_KEY = process.env.GUARDIAN_API_KEY;
const DEV_ACCOUNT_ID = process.env.GUARDIAN_DEV_ACCOUNT_ID;
const DEV_USER_ID = process.env.GUARDIAN_DEV_USER_ID;

const ATLAS_PUBLIC_KEY = process.env.ATLAS_PUBLIC_KEY;
const ATLAS_PRIVATE_KEY = process.env.ATLAS_PRIVATE_KEY;
const ATLAS_PROJECT_ID = process.env.ATLAS_PROJECT_ID;

function getAuthHeaders(): Record<string, string> {
  if (API_KEY) return { Authorization: `Bearer ${API_KEY}` };
  if (DEV_ACCOUNT_ID && DEV_USER_ID) {
    return { "X-Guardian-Account-Id": DEV_ACCOUNT_ID, "X-Guardian-User-Id": DEV_USER_ID };
  }
  throw new Error("Set GUARDIAN_API_KEY or both GUARDIAN_DEV_ACCOUNT_ID and GUARDIAN_DEV_USER_ID");
}

async function apiRequest(method: string, path: string, body?: unknown): Promise<any> {
  const res = await fetch(`${API_URL}${path}`, {
    method,
    headers: { "Content-Type": "application/json", ...getAuthHeaders() },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`${method} ${path} failed (${res.status}): ${JSON.stringify(data)}`);
  return data;
}

async function main() {
  if (!ATLAS_PUBLIC_KEY || !ATLAS_PRIVATE_KEY || !ATLAS_PROJECT_ID) {
    console.error("Error: ATLAS_PUBLIC_KEY, ATLAS_PRIVATE_KEY, ATLAS_PROJECT_ID are required");
    process.exit(1);
  }

  console.log(`\n🔧 Divinci Production Atlas — Kill Switch Setup`);
  console.log(`   API: ${API_URL}\n`);

  // Step 1: find the EXISTING mongodb account (the one that's been pausing prod),
  // or create it if somehow absent. We never want a duplicate — the existing
  // account's pause-cluster behavior is exactly what we're here to fix.
  console.log("1. Locating the Divinci mongodb cloud-account...");
  const list = await apiRequest("GET", "/cloud-accounts");
  const accounts: any[] = list.accounts ?? list ?? [];
  const mongoAccounts = accounts.filter((a: any) => a.provider === "mongodb");

  let cloudAccountId: string;
  if (mongoAccounts.length === 1) {
    cloudAccountId = mongoAccounts[0].id;
    console.log(`   Found existing mongodb account: ${cloudAccountId} ("${mongoAccounts[0].name}")`);
  } else if (mongoAccounts.length > 1) {
    const byName = mongoAccounts.find((a: any) => a.name === DIVINCI_PROD_ATLAS_ACCOUNT_NAME);
    if (!byName) {
      console.error(
        `   Multiple mongodb accounts found and none named "${DIVINCI_PROD_ATLAS_ACCOUNT_NAME}":`,
        mongoAccounts.map((a: any) => `${a.id} (${a.name})`).join(", "),
      );
      console.error("   Rename the prod cluster's account to that, or update it by hand. Aborting to avoid touching the wrong one.");
      process.exit(1);
    }
    cloudAccountId = byName.id;
    console.log(`   Found existing mongodb account by name: ${cloudAccountId}`);
  } else {
    console.log("   No mongodb account found — creating one...");
    const created = await apiRequest(
      "POST",
      "/cloud-accounts",
      buildDivinciProdAtlasAccountPayload({
        publicKey: ATLAS_PUBLIC_KEY,
        privateKey: ATLAS_PRIVATE_KEY,
        projectId: ATLAS_PROJECT_ID,
      }),
    );
    cloudAccountId = created.id;
    console.log(`   Created cloud account: ${cloudAccountId}`);
  }

  // Step 2: apply reality-based thresholds + protection (NO auto-pause).
  console.log("2. Applying reality-based thresholds + protection (no auto-pause)...");
  const updatePayload = buildDivinciProdAtlasUpdatePayload();
  await apiRequest("PUT", `/cloud-accounts/${cloudAccountId}`, updatePayload);
  console.log(`   Storage trip raised to ${updatePayload.thresholds.mongodbStorageSizeGB}GB (was 10GB → caused the outages)`);
  console.log(`   Protected: ${updatePayload.protectedServices.join(", ")} | autoDisconnect=${updatePayload.autoDisconnect} autoDelete=${updatePayload.autoDelete}`);

  // Step 3: apply alert-only (snapshot) rules.
  console.log("3. Applying alert-only rules (snapshot; no pause-cluster on prod)...");
  for (const rule of getDivinciProdAtlasRules()) {
    try {
      await apiRequest("POST", "/rules", rule);
      console.log(`   Applied rule: ${rule.name}`);
    } catch (err: any) {
      try {
        await apiRequest("PUT", `/rules/${rule.id}`, rule);
        console.log(`   Updated rule: ${rule.name}`);
      } catch {
        console.warn(`   Warning: could not apply rule ${rule.name}: ${err.message}`);
      }
    }
  }

  // Step 4: initial check to confirm no violations now.
  console.log("4. Running an initial check...");
  try {
    const result = await apiRequest("POST", `/cloud-accounts/${cloudAccountId}/check`);
    const violations = result.violations ?? [];
    console.log(violations.length ? `   ⚠️ ${violations.length} violation(s):` : "   ✅ No violations — all clear");
    for (const v of violations) {
      console.log(`     - ${v.serviceName}: ${v.metricName} = ${v.currentValue} (threshold: ${v.threshold})`);
    }
    if (result.actionsTaken?.length) console.log(`   Actions taken: ${result.actionsTaken.join(", ")}`);
  } catch (err: any) {
    console.warn(`   Initial check skipped: ${err.message}`);
  }

  console.log(`\n✅ Done. ${DIVINCI_PROD_ATLAS_CLUSTER} now uses reality-based thresholds and will not be auto-paused.\n`);
}

main().catch((err) => {
  console.error("\n❌ Setup failed:", err.message);
  process.exit(1);
});
