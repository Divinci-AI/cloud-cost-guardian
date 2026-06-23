#!/usr/bin/env tsx
/**
 * Divinci Staging Atlas — Kill Switch Setup
 *
 * Applies the reality-based, cost-only-auto-pause integration in
 * `divinci-stage-atlas.config.ts` to the kill switch, REPLACING the original
 * guessed thresholds that auto-paused the STAGING MongoDB cluster during routine
 * internal testing (the guard `pause-cluster`'d staging when real disk usage
 * crossed the old 10GB line). See that config file's header for the measured
 * baseline + rationale.
 *
 * It UPDATES the EXISTING staging mongodb cloud-account (never a duplicate, and
 * NEVER the prod account), setting:
 *   - reality-based thresholds (storage 100GB, conns 1200, ops 5000, $40/day,
 *     $1200/mo) — only a genuine runaway trips them
 *   - productionProtected:false so the cost rule's pause-cluster can fire
 *   - cost-runaway rule => auto pause-cluster; connection/ops rule => snapshot only
 *
 * Account targeting (so we never touch the prod cluster's account):
 *   1. account named "Divinci Staging Atlas", else
 *   2. account whose credential.clusterName === "divinci-stage-api-cluster0", else
 *   3. the single mongodb account that is NOT the prod one.
 *   If still ambiguous, it ABORTS — rename the staging account and re-run.
 *
 * Usage:
 *   GUARDIAN_API_URL=https://api.kill-switch.net \
 *   GUARDIAN_API_KEY=ks_live_... \
 *   ATLAS_PUBLIC_KEY=... ATLAS_PRIVATE_KEY=... ATLAS_PROJECT_ID=... \
 *   tsx packages/api/src/dogfood/divinci-stage-atlas.setup.ts
 *
 * (Atlas creds: private-keys/staging/atlas-api.env in the Divinci server repo.)
 */

import {
  buildDivinciStageAtlasAccountPayload,
  buildDivinciStageAtlasUpdatePayload,
  getDivinciStageAtlasRules,
  DIVINCI_STAGE_ATLAS_ACCOUNT_NAME,
  DIVINCI_STAGE_ATLAS_CLUSTER,
} from "./divinci-stage-atlas.config.js";
import { DIVINCI_PROD_ATLAS_CLUSTER, DIVINCI_PROD_ATLAS_ACCOUNT_NAME } from "./divinci-prod-atlas.config.js";

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

function clusterOf(account: any): string | undefined {
  return (
    account?.credential?.clusterName ??
    account?.clusterName ??
    account?.credentialMeta?.clusterName
  );
}

async function main() {
  if (!ATLAS_PUBLIC_KEY || !ATLAS_PRIVATE_KEY || !ATLAS_PROJECT_ID) {
    console.error("Error: ATLAS_PUBLIC_KEY, ATLAS_PRIVATE_KEY, ATLAS_PROJECT_ID are required");
    process.exit(1);
  }

  console.log(`\n🔧 Divinci Staging Atlas — Kill Switch Setup`);
  console.log(`   API: ${API_URL}\n`);

  // Step 1: locate the EXISTING staging mongodb account — never the prod one.
  console.log("1. Locating the Divinci STAGING mongodb cloud-account...");
  const list = await apiRequest("GET", "/cloud-accounts");
  const accounts: any[] = list.accounts ?? list ?? [];
  const mongoAccounts = accounts.filter((a: any) => a.provider === "mongodb");

  // Anything that is clearly the prod account is excluded up front.
  const isProd = (a: any) =>
    a.name === DIVINCI_PROD_ATLAS_ACCOUNT_NAME || clusterOf(a) === DIVINCI_PROD_ATLAS_CLUSTER;
  const candidates = mongoAccounts.filter((a: any) => !isProd(a));

  let cloudAccountId: string;
  if (mongoAccounts.length === 0) {
    console.log("   No mongodb account found — creating the staging one...");
    const created = await apiRequest(
      "POST",
      "/cloud-accounts",
      buildDivinciStageAtlasAccountPayload({
        publicKey: ATLAS_PUBLIC_KEY,
        privateKey: ATLAS_PRIVATE_KEY,
        projectId: ATLAS_PROJECT_ID,
      }),
    );
    cloudAccountId = created.id;
    console.log(`   Created cloud account: ${cloudAccountId}`);
  } else {
    const byName = candidates.find((a: any) => a.name === DIVINCI_STAGE_ATLAS_ACCOUNT_NAME);
    const byCluster = candidates.find((a: any) => clusterOf(a) === DIVINCI_STAGE_ATLAS_CLUSTER);
    const target = byName ?? byCluster ?? (candidates.length === 1 ? candidates[0] : undefined);
    if (!target) {
      console.error(
        `   Could not unambiguously identify the staging account. mongodb accounts found:\n` +
          mongoAccounts
            .map((a: any) => `     - ${a.id} name="${a.name}" cluster=${clusterOf(a) ?? "?"}${isProd(a) ? " (PROD — excluded)" : ""}`)
            .join("\n"),
      );
      console.error(`   Rename the staging account to "${DIVINCI_STAGE_ATLAS_ACCOUNT_NAME}" (or set its credential clusterName to ${DIVINCI_STAGE_ATLAS_CLUSTER}) and re-run. Aborting to avoid touching the wrong cluster.`);
      process.exit(1);
    }
    cloudAccountId = target.id;
    console.log(`   Targeting staging account: ${cloudAccountId} name="${target.name}" cluster=${clusterOf(target) ?? "?"}`);
  }

  // Step 2: apply reality-based thresholds + cost-only auto-pause posture.
  console.log("2. Applying reality-based thresholds (cost-only auto-pause)...");
  const updatePayload = buildDivinciStageAtlasUpdatePayload();
  await apiRequest("PUT", `/cloud-accounts/${cloudAccountId}`, updatePayload);
  console.log(`   Storage trip raised to ${updatePayload.thresholds.mongodbStorageSizeGB}GB (was 10GB → auto-paused staging)`);
  console.log(`   productionProtected=${updatePayload.productionProtected} autoDisconnect=${updatePayload.autoDisconnect} autoDelete=${updatePayload.autoDelete}`);

  // Step 3: apply rules (cost => pause-cluster; conn/ops => snapshot).
  console.log("3. Applying rules (cost=>auto-pause, conn/ops=>alert only)...");
  for (const rule of getDivinciStageAtlasRules()) {
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

  // Step 4: initial check to confirm staging is no longer in violation.
  console.log("4. Running an initial check...");
  try {
    const result = await apiRequest("POST", `/cloud-accounts/${cloudAccountId}/check`);
    const violations = result.violations ?? [];
    console.log(violations.length ? `   ⚠️ ${violations.length} violation(s):` : "   ✅ No violations — all clear");
    for (const v of violations) {
      console.log(`     - ${v.serviceName}: ${v.metricName} = ${v.currentValue} (threshold: ${v.threshold})`);
    }
    if (result.actionsTaken?.length) console.log(`   Actions taken: ${result.actionsTaken.join(", ")}`);
    if (result.ruleActionsTaken?.length) console.log(`   Rule actions: ${result.ruleActionsTaken.join(", ")}`);
  } catch (err: any) {
    console.warn(`   Initial check skipped: ${err.message}`);
  }

  console.log(`\n✅ Done. ${DIVINCI_STAGE_ATLAS_CLUSTER} now uses reality-based thresholds and will auto-pause ONLY on a cost runaway, never on normal testing load.\n`);
}

main().catch((err) => {
  console.error("\n❌ Setup failed:", err.message);
  process.exit(1);
});
