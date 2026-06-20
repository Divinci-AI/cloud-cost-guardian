/**
 * Divinci Production Atlas — Kill Switch Integration (config-as-code)
 *
 * Version-controlled replacement for the hand-entered ("guessed") thresholds
 * that were originally set when onboarding the Divinci production MongoDB Atlas
 * cluster through the dashboard.
 *
 * Why this exists
 * ───────────────
 * The original onboarding used placeholder thresholds (10GB storage / 200 conns
 * / 5000 ops/s / $30 day). The cluster's REAL usage exceeded the 10GB storage
 * line, so the kill switch fired a `pause-cluster` action and took Divinci
 * production MongoDB OFFLINE — twice (2026-06-12 and 2026-06-20). Pausing a
 * fixed-tier production database does NOT save runaway cost (the tier bills the
 * same hourly rate whether storage is 1GB or 40GB) — it just causes an outage.
 *
 * REAL measured baseline (M30, 7-day window, 2026-06-20, via Atlas API):
 *   - Disk:        40 GB provisioned, ~16.8 GB used (~42%)
 *   - Connections: max 67, avg 56   (M30 hard cap ~1500)
 *   - Ops/sec:     ~25 max (cmd 23, query 1.4, insert/update ~0)
 *   - Cost:        ~$450/mo all-in (M30 fixed dedicated tier)
 *
 * Thresholds below are anchored to that reality with generous headroom so the
 * guard only fires on a GENUINE runaway (a connection leak, a tier auto-scale
 * to M50+, an ops/cost explosion) — never on normal operation or routine data
 * growth. And critically the action is forensic/alert-only (`snapshot`), and the
 * cluster is PROTECTED from any destructive action: a production database must
 * never be auto-paused/auto-killed. Humans decide pauses, the guard just warns.
 */

import type { ThresholdConfig, KillSwitchRule } from "../providers/types.js";

export const DIVINCI_PROD_ATLAS_PROVIDER = "mongodb" as const;

export const DIVINCI_PROD_ATLAS_ACCOUNT_NAME = "Divinci Production Atlas";

/** The production cluster — must NEVER be auto-paused/auto-killed. */
export const DIVINCI_PROD_ATLAS_CLUSTER = "divinci-prod-api-cluster0";

/** Protected resources: destructive actions on these are blocked. */
export const DIVINCI_PROD_PROTECTED = [DIVINCI_PROD_ATLAS_CLUSTER];

/**
 * Reality-based thresholds (see header for the measured baseline + rationale).
 * Each value sits well above normal so a trip means a real anomaly.
 */
export const DIVINCI_PROD_ATLAS_THRESHOLDS: ThresholdConfig = {
  // Storage: 40GB disk, ~16.8GB used. Storage is NOT a cost-runaway vector on a
  // fixed-tier cluster, so this is set far above disk capacity — it should never
  // trip on data growth (the old 10GB value is what caused both outages).
  mongodbStorageSizeGB: 100,

  // Connections: normal max ~67; M30 cap ~1500. Alert near the cap (a leak), not
  // anywhere near normal load.
  mongodbActiveConnections: 1200,

  // Ops/sec: normal ~25. 5000 = ~200x headroom; only a true runaway trips it.
  mongodbOpsPerSec: 5000,

  // Collections: generous; document SaaS has well under this.
  mongodbCollectionCount: 1000,

  // Cost: M30 ~$15/day. $40/day catches an auto-scale to M40+ or surprise
  // data-transfer charges, with headroom over normal.
  mongodbDailyCostUSD: 40,

  // Monthly: M30 ~$450/mo. $1200 catches a sustained multi-tier runaway
  // (e.g. stuck on M50) while never tripping on the normal fixed bill.
  monthlySpendLimitUSD: 1200,
};

/**
 * Rules for the production cluster. Action is forensic/alert-only (`snapshot`)
 * with approval required — a production DB is never auto-paused or auto-killed.
 */
export function getDivinciProdAtlasRules(): KillSwitchRule[] {
  return [
    {
      id: "divinci-prod-atlas-cost-guard",
      name: "Divinci Prod Atlas: Cost / Tier-Scale Guard (alert only)",
      enabled: true,
      trigger: "cost",
      conditions: [
        { metric: "monthlySpendLimitUSD", operator: "gt", value: 1200 },
        { metric: "mongodbDailyCostUSD", operator: "gt", value: 40 },
      ],
      conditionLogic: "any",
      actions: [
        // Forensic snapshot + human approval only. NEVER pause-cluster on prod.
        { type: "snapshot", target: DIVINCI_PROD_ATLAS_CLUSTER, requireApproval: false },
      ],
      cooldownMinutes: 60,
      forensicsEnabled: true,
    },
    {
      id: "divinci-prod-atlas-runaway-guard",
      name: "Divinci Prod Atlas: Connection/Ops Runaway (alert only)",
      enabled: true,
      trigger: "cost",
      conditions: [
        { metric: "mongodbActiveConnections", operator: "gt", value: 1200, windowMinutes: 5 },
        { metric: "mongodbOpsPerSec", operator: "gt", value: 5000, windowMinutes: 5 },
      ],
      conditionLogic: "any",
      actions: [
        { type: "snapshot", target: DIVINCI_PROD_ATLAS_CLUSTER, requireApproval: false },
      ],
      cooldownMinutes: 30,
      forensicsEnabled: true,
    },
  ];
}

/**
 * POST /cloud-accounts payload. Atlas creds come from env at setup time
 * (never hard-code keys); see divinci-prod-atlas.setup.ts.
 */
export function buildDivinciProdAtlasAccountPayload(credential: {
  publicKey: string;
  privateKey: string;
  projectId: string;
}) {
  return {
    provider: DIVINCI_PROD_ATLAS_PROVIDER,
    name: DIVINCI_PROD_ATLAS_ACCOUNT_NAME,
    credential: {
      provider: DIVINCI_PROD_ATLAS_PROVIDER,
      type: "atlas",
      publicKey: credential.publicKey,
      privateKey: credential.privateKey,
      projectId: credential.projectId,
      clusterName: DIVINCI_PROD_ATLAS_CLUSTER,
    },
  };
}

/**
 * PUT /cloud-accounts/:id payload — reality-based thresholds + protection,
 * and NO auto-destructive actions (autoDelete/auto-pause off).
 */
export function buildDivinciProdAtlasUpdatePayload() {
  return {
    thresholds: DIVINCI_PROD_ATLAS_THRESHOLDS,
    protectedServices: DIVINCI_PROD_PROTECTED,
    autoDisconnect: false, // never auto-pause/disconnect the prod database
    autoDelete: false,
  };
}
