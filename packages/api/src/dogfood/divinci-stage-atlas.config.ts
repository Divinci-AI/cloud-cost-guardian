/**
 * Divinci Staging Atlas — Kill Switch Integration (config-as-code)
 *
 * Staging counterpart to `divinci-prod-atlas.config.ts`. It fixes the SAME
 * misconfiguration that took prod down twice — original dashboard onboarding
 * set placeholder thresholds (10GB storage / 200 conns / 5000 ops/s / $30 day)
 * with a destructive `pause-cluster` action. Staging's REAL disk usage (~22GB)
 * sits far above the 10GB line, so the guard auto-paused the staging cluster
 * during routine internal testing (multiple concurrent Claude Code sessions +
 * customers on staging push connections to ~150, well past the 200-ish guess at
 * sub-minute granularity). A staging pause 503s every DB-backed route.
 *
 * REAL measured baseline (M30, 7-day hourly window, 2026-06-22, via Atlas API):
 *   - Disk:        33 GB provisioned, ~22 GB used (~67%)
 *   - Connections: primary max 149, avg 91   (M30 hard cap ~1500)
 *   - Ops/sec:     primary ~46 cmd / ~8 query / ~70 total max
 *   - Cost:        M30 fixed dedicated ~$0.44/hr ≈ $10.5/day ≈ $320–450/mo
 *
 * Policy (differs from prod — owner decision 2026-06-22):
 * ──────────────────────────────────────────────────────
 * Prod is alert-only and NEVER auto-paused (a prod pause is an outage). Staging
 * is non-prod and an outage is tolerable, so the kill switch MAY auto-pause it —
 * but ONLY on a genuine COST runaway. Storage / connection / ops triggers are
 * alert-only (`snapshot`): on a fixed-tier M30 they don't represent runaway cost
 * (the tier bills the same hourly rate at 1GB or 33GB), so pausing on them just
 * causes a pointless outage — exactly the bug we're removing. The single
 * auto-pause trigger is a cost trip (>~$40/day or >~$1200/mo), which means the
 * tier auto-scaled to M50+ or a surprise data-transfer charge — a real runaway
 * worth killing.
 *
 * Mechanism note: the auto-pause is driven by the explicit cost rule's
 * `pause-cluster` action, which only fires because this account sets
 * `productionProtected: false` (the monitoring engine blocks destructive
 * managed-DB actions otherwise). `autoDisconnect` is intentionally false — its
 * default mongodb kill action is `kill-connections`, a no-op on Atlas managed
 * clusters, so it cannot pause and would only add log noise.
 *
 * Idle overnight cost-saving (the deliberate ~87%-off compute pause from
 * notebooks/2026-06-12-atlas-pause-policy.md) is a SEPARATE concern and should
 * be an Atlas App Services Scheduled Trigger (cron), NOT this load/cost guard.
 */

import type { ThresholdConfig, KillSwitchRule } from "../providers/types.js";

export const DIVINCI_STAGE_ATLAS_PROVIDER = "mongodb" as const;

export const DIVINCI_STAGE_ATLAS_ACCOUNT_NAME = "Divinci Staging Atlas";

/** The staging cluster. May be auto-paused, but ONLY on a cost runaway. */
export const DIVINCI_STAGE_ATLAS_CLUSTER = "divinci-stage-api-cluster0";

/**
 * Reality-based thresholds (see header for the measured baseline + rationale).
 * Each value sits far above normal staging load so a trip means a real anomaly.
 * Identical headroom to the prod config — staging usage is even lower, so these
 * are amply safe.
 */
export const DIVINCI_STAGE_ATLAS_THRESHOLDS: ThresholdConfig = {
  // Storage: 33GB disk, ~22GB used. Storage is NOT a cost-runaway vector on a
  // fixed-tier cluster, so this is set above disk capacity — it never trips on
  // data growth (the old 10GB value is what auto-paused staging).
  mongodbStorageSizeGB: 100,

  // Connections: normal max ~149; M30 cap ~1500. Alert near the cap (a leak),
  // never on normal multi-session testing load.
  mongodbActiveConnections: 1200,

  // Ops/sec: normal ~70. 5000 = ~70x headroom; only a true runaway trips it.
  mongodbOpsPerSec: 5000,

  // Collections: generous; document SaaS has well under this.
  mongodbCollectionCount: 1000,

  // Cost: M30 ~$10.5/day. $40/day catches an auto-scale to M50+ or surprise
  // data-transfer charges, never the normal fixed bill. THIS is the only
  // metric that auto-pauses staging (via the cost rule below).
  mongodbDailyCostUSD: 40,

  // Monthly: M30 ~$320–450/mo. $1200 catches a sustained multi-tier runaway
  // while never tripping on the normal fixed bill.
  monthlySpendLimitUSD: 1200,
};

/**
 * Rules for the staging cluster.
 *   - cost-guard: auto `pause-cluster` ON A COST TRIP ONLY (tier-scale / runaway).
 *   - runaway-guard: connection/ops spikes are `snapshot` (alert) only — pausing
 *     a fixed tier on load saves nothing and just causes an outage.
 */
export function getDivinciStageAtlasRules(): KillSwitchRule[] {
  return [
    {
      id: "divinci-stage-atlas-cost-guard",
      name: "Divinci Stage Atlas: Cost / Tier-Scale Guard (auto-pause)",
      enabled: true,
      trigger: "cost",
      conditions: [
        { metric: "monthlySpendLimitUSD", operator: "gt", value: 1200 },
        { metric: "mongodbDailyCostUSD", operator: "gt", value: 40 },
      ],
      conditionLogic: "any",
      actions: [
        // Forensic snapshot first, then auto-pause — staging outage is tolerable
        // and a real cost runaway is worth stopping. requireApproval:false so it
        // actually fires without a human in the loop.
        { type: "snapshot", target: DIVINCI_STAGE_ATLAS_CLUSTER, requireApproval: false },
        { type: "pause-cluster", target: DIVINCI_STAGE_ATLAS_CLUSTER, requireApproval: false },
      ],
      cooldownMinutes: 60,
      forensicsEnabled: true,
    },
    {
      id: "divinci-stage-atlas-runaway-guard",
      name: "Divinci Stage Atlas: Connection/Ops Runaway (alert only)",
      enabled: true,
      trigger: "cost",
      conditions: [
        { metric: "mongodbActiveConnections", operator: "gt", value: 1200, windowMinutes: 5 },
        { metric: "mongodbOpsPerSec", operator: "gt", value: 5000, windowMinutes: 5 },
      ],
      conditionLogic: "any",
      actions: [
        // Alert only — NEVER pause on load (fixed-tier billing makes it pointless).
        { type: "snapshot", target: DIVINCI_STAGE_ATLAS_CLUSTER, requireApproval: false },
      ],
      cooldownMinutes: 30,
      forensicsEnabled: true,
    },
  ];
}

/**
 * POST /cloud-accounts payload. Atlas creds come from env at setup time
 * (never hard-code keys); see divinci-stage-atlas.setup.ts.
 */
export function buildDivinciStageAtlasAccountPayload(credential: {
  publicKey: string;
  privateKey: string;
  projectId: string;
}) {
  return {
    provider: DIVINCI_STAGE_ATLAS_PROVIDER,
    name: DIVINCI_STAGE_ATLAS_ACCOUNT_NAME,
    credential: {
      provider: DIVINCI_STAGE_ATLAS_PROVIDER,
      type: "atlas",
      publicKey: credential.publicKey,
      privateKey: credential.privateKey,
      projectId: credential.projectId,
      clusterName: DIVINCI_STAGE_ATLAS_CLUSTER,
    },
  };
}

/**
 * PUT /cloud-accounts/:id payload — reality-based thresholds, and
 * productionProtected:false so the cost rule's `pause-cluster` action is allowed
 * to fire. NO protectedServices (staging may be paused). autoDisconnect:false
 * (its mongodb action is a no-op on Atlas; the pause is the explicit rule).
 */
export function buildDivinciStageAtlasUpdatePayload() {
  return {
    thresholds: DIVINCI_STAGE_ATLAS_THRESHOLDS,
    protectedServices: [] as string[],
    productionProtected: false, // allow the cost-runaway rule to auto-pause staging
    autoDisconnect: false,      // no-op for mongodb/Atlas; pause is the explicit rule
    autoDelete: false,          // never auto-DELETE the staging cluster
  };
}
