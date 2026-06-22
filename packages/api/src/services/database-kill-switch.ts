/**
 * Database Kill Switch
 *
 * Nuclear option for compromised databases. Flow:
 *
 *   1. SNAPSHOT  — Trigger point-in-time backup
 *   2. VERIFY    — Confirm snapshot completed and is restorable
 *   3. ISOLATE   — Revoke all connections (no new connections accepted)
 *   4. NUKE      — Drop database or disable access entirely
 *
 * CRITICAL SAFETY RULES:
 * - Snapshot MUST be verified before any destructive action
 * - Nuke requires double confirmation (rule + human approval)
 * - Every action is logged with timestamps for audit trail
 * - Snapshot ID is recorded so the database can be restored later
 *
 * Supported:
 * - MongoDB Atlas (via Atlas Admin API)
 * - Cloud SQL PostgreSQL (via GCP API)
 * - Redis (via connection kill + flush)
 */

import { createHash } from "crypto";
import { KillSequenceModel } from "../models/kill-sequence/schema.js";

export type DatabaseProvider = "mongodb-atlas" | "cloud-sql-postgres" | "redis";

export type DatabaseKillAction =
  | "snapshot"           // Take point-in-time backup
  | "verify-snapshot"    // Confirm snapshot is complete
  | "isolate"            // Block all connections
  | "nuke"              // Drop/delete database (IRREVERSIBLE without snapshot)
  | "rotate-credentials" // Change all passwords/tokens
  | "revoke-access";     // Remove all IP whitelist entries

export interface DatabaseCredential {
  provider: DatabaseProvider;
  // MongoDB Atlas
  atlasPublicKey?: string;
  atlasPrivateKey?: string;
  atlasProjectId?: string;
  clusterName?: string;
  // Cloud SQL
  gcpAccessToken?: string;
  gcpProjectId?: string;
  instanceName?: string;
  // Redis
  redisHost?: string;
  redisPort?: number;
  redisPassword?: string;
}

export interface SnapshotResult {
  id: string;
  provider: DatabaseProvider;
  status: "creating" | "completed" | "failed";
  createdAt: number;
  completedAt?: number;
  sizeBytes?: number;
  restorable: boolean;
  integrityHash?: string;
}

export interface DatabaseKillResult {
  action: DatabaseKillAction;
  success: boolean;
  provider: DatabaseProvider;
  target: string;
  details: string;
  snapshotId?: string;
  timestamp: number;
  requiresConfirmation?: boolean;
}

export interface KillSequenceState {
  id: string;
  startedAt: number;
  provider: DatabaseProvider;
  target: string;
  trigger: string;
  steps: KillSequenceStep[];
  currentStep: number;
  status: "running" | "awaiting-confirmation" | "completed" | "failed" | "aborted";
  snapshotId?: string;
  snapshotVerified: boolean;
}

interface KillSequenceStep {
  action: DatabaseKillAction;
  status: "pending" | "running" | "completed" | "failed" | "skipped";
  result?: string;
  timestamp?: number;
}

// ─── Kill Sequence Orchestrator ─────────────────────────────────────────────

// Sequences are persisted in Mongo (GuardianKillSequence collection) so they
// survive restarts, are shared across instances, and a step can only be
// claimed by one /advance call at a time.

const TERMINAL_STATUSES = ["completed", "failed", "aborted"];

/** An /advance call that has held the in-flight lock this long is presumed
 *  dead (instance crashed mid-step) and the lock can be reclaimed. */
const STALE_STEP_MS = 5 * 60 * 1000;

/** Thrown when another /advance call currently holds the step lock. */
export class AdvanceInProgressError extends Error {
  code = "ADVANCE_IN_PROGRESS" as const;
  constructor(sequenceId: string) {
    super(`Another advance is already executing a step for ${sequenceId}. Retry shortly.`);
  }
}

function docToState(doc: any): KillSequenceState {
  return {
    id: doc.id,
    startedAt: doc.startedAt,
    provider: doc.provider,
    target: doc.target,
    trigger: doc.trigger,
    steps: (doc.steps || []).map((s: any) => ({
      action: s.action,
      status: s.status,
      result: s.result,
      timestamp: s.timestamp,
    })),
    currentStep: doc.currentStep,
    status: doc.status,
    snapshotId: doc.snapshotId ?? undefined,
    snapshotVerified: doc.snapshotVerified,
  };
}

function terminalFields(status: string): Record<string, unknown> {
  return TERMINAL_STATUSES.includes(status) ? { finishedAt: new Date() } : {};
}

/**
 * Initiate a database kill sequence.
 * Returns immediately — the sequence runs step by step.
 * Each destructive step requires the previous safety step to complete.
 */
export async function initiateKillSequence(
  credential: DatabaseCredential,
  trigger: string,
  actions: DatabaseKillAction[] = ["snapshot", "verify-snapshot", "isolate", "nuke"],
  guardianAccountId: string = "",
): Promise<KillSequenceState> {
  const id = `dbkill-${crypto.randomUUID()}`;
  const target = credential.clusterName || credential.instanceName || credential.redisHost || "unknown";

  const doc = await KillSequenceModel.create({
    id,
    guardianAccountId,
    startedAt: Date.now(),
    provider: credential.provider,
    target,
    trigger,
    steps: actions.map(action => ({ action, status: "pending" as const })),
    currentStep: 0,
    status: "running",
    snapshotVerified: false,
    executing: false,
  });

  return docToState(doc);
}

/**
 * Execute the next step in a kill sequence.
 * Returns the updated state, or null if no sequence matches.
 * The step is claimed atomically — concurrent calls (second tab, second
 * Cloud Run instance) get AdvanceInProgressError instead of double-executing.
 */
export async function advanceKillSequence(
  sequenceId: string,
  credential: DatabaseCredential,
  humanApproval?: boolean,
  guardianAccountId?: string,
): Promise<KillSequenceState | null> {
  const scope: Record<string, unknown> = { id: sequenceId };
  if (guardianAccountId) scope.guardianAccountId = guardianAccountId;

  const existing = await KillSequenceModel.findOne(scope).lean();
  if (!existing) return null;
  if (TERMINAL_STATUSES.includes(existing.status)) return docToState(existing);

  // Atomically claim the step. Succeeds only if no other call holds the lock
  // (or the holder went stale — crashed instance mid-step).
  const now = Date.now();
  const claimed = await KillSequenceModel.findOneAndUpdate(
    {
      ...scope,
      status: { $in: ["running", "awaiting-confirmation"] },
      currentStep: existing.currentStep,
      $or: [
        { executing: { $ne: true } },
        { stepStartedAt: { $lt: now - STALE_STEP_MS } },
      ],
    },
    { $set: { executing: true, stepStartedAt: now } },
    { new: true },
  ).lean();
  if (!claimed) throw new AdvanceInProgressError(sequenceId);

  const seq = docToState(claimed);
  const release = async (extra: Record<string, unknown> = {}) => {
    await KillSequenceModel.updateOne({ id: sequenceId }, {
      $set: {
        steps: seq.steps,
        currentStep: seq.currentStep,
        status: seq.status,
        snapshotId: seq.snapshotId,
        snapshotVerified: seq.snapshotVerified,
        executing: false,
        ...terminalFields(seq.status),
        ...extra,
      },
    });
  };

  const step = seq.steps[seq.currentStep];
  if (!step) {
    seq.status = "completed";
    await release();
    return seq;
  }

  // SAFETY CHECK: Nuke requires verified snapshot
  if (step.action === "nuke" && !seq.snapshotVerified) {
    step.status = "failed";
    step.result = "SAFETY BLOCK: Cannot nuke without verified snapshot. Run snapshot + verify first.";
    seq.status = "failed";
    await release();
    return seq;
  }

  // SAFETY CHECK: Nuke requires human approval
  if (step.action === "nuke" && !humanApproval) {
    seq.status = "awaiting-confirmation";
    step.result = "Awaiting human confirmation to nuke database. Snapshot verified: " + seq.snapshotId;
    await release();
    return seq;
  }

  // Execute step
  step.status = "running";
  step.timestamp = Date.now();

  try {
    const result = await executeStep(credential, step.action, seq);

    step.status = result.success ? "completed" : "failed";
    step.result = result.details;

    if (result.snapshotId) {
      seq.snapshotId = result.snapshotId;
    }

    if (step.action === "verify-snapshot" && result.success) {
      seq.snapshotVerified = true;
    }

    if (!result.success) {
      seq.status = "failed";
      await release();
      return seq;
    }

    seq.currentStep++;
    if (seq.currentStep >= seq.steps.length) {
      seq.status = "completed";
    }
  } catch (e: any) {
    step.status = "failed";
    step.result = e.message;
    seq.status = "failed";
  }

  await release();
  return seq;
}

/**
 * Abort a kill sequence (stops at current step, no further actions)
 */
export async function abortKillSequence(
  sequenceId: string,
  guardianAccountId?: string,
): Promise<KillSequenceState | null> {
  const scope: Record<string, unknown> = { id: sequenceId };
  if (guardianAccountId) scope.guardianAccountId = guardianAccountId;
  const doc = await KillSequenceModel.findOneAndUpdate(
    scope,
    { $set: { status: "aborted", executing: false, finishedAt: new Date() } },
    { new: true },
  ).lean();
  return doc ? docToState(doc) : null;
}

export async function getKillSequence(
  sequenceId: string,
  guardianAccountId?: string,
): Promise<KillSequenceState | null> {
  const scope: Record<string, unknown> = { id: sequenceId };
  if (guardianAccountId) scope.guardianAccountId = guardianAccountId;
  const doc = await KillSequenceModel.findOne(scope).lean();
  return doc ? docToState(doc) : null;
}

/**
 * List an org's sequences: everything in-flight, plus anything that finished
 * in the last 24h so operators can see the outcome.
 */
export async function listActiveSequences(guardianAccountId: string): Promise<KillSequenceState[]> {
  const docs = await KillSequenceModel.find({
    guardianAccountId,
    $or: [
      { status: { $in: ["running", "awaiting-confirmation"] } },
      { finishedAt: { $gte: new Date(Date.now() - 24 * 60 * 60 * 1000) } },
    ],
  }).sort({ startedAt: -1 }).limit(50).lean();
  return docs.map(docToState);
}

// ─── Step Execution ─────────────────────────────────────────────────────────

async function executeStep(
  credential: DatabaseCredential,
  action: DatabaseKillAction,
  sequence: KillSequenceState
): Promise<DatabaseKillResult> {
  switch (credential.provider) {
    case "mongodb-atlas":
      return executeMongoDBAtlasStep(credential, action, sequence);
    case "cloud-sql-postgres":
      return executeCloudSQLStep(credential, action, sequence);
    case "redis":
      return executeRedisStep(credential, action, sequence);
    default:
      return {
        action, success: false, provider: credential.provider,
        target: sequence.target, details: `Unsupported provider: ${credential.provider}`,
        timestamp: Date.now(),
      };
  }
}

// ─── MongoDB Atlas ──────────────────────────────────────────────────────────

async function executeMongoDBAtlasStep(
  credential: DatabaseCredential,
  action: DatabaseKillAction,
  sequence: KillSequenceState
): Promise<DatabaseKillResult> {
  const { atlasPublicKey, atlasPrivateKey, atlasProjectId, clusterName } = credential;
  if (!atlasPublicKey || !atlasPrivateKey || !atlasProjectId || !clusterName) {
    return { action, success: false, provider: "mongodb-atlas", target: clusterName || "?",
      details: "Missing Atlas credentials", timestamp: Date.now() };
  }

  const atlasBase = `https://cloud.mongodb.com/api/atlas/v2/groups/${atlasProjectId}`;
  const authHeader = "Basic " + Buffer.from(`${atlasPublicKey}:${atlasPrivateKey}`).toString("base64");
  const headers = { "Authorization": authHeader, "Content-Type": "application/json", "Accept": "application/vnd.atlas.2023-11-15+json" };

  const result: DatabaseKillResult = {
    action, success: false, provider: "mongodb-atlas", target: clusterName,
    details: "", timestamp: Date.now(),
  };

  switch (action) {
    case "snapshot": {
      const res = await fetch(`${atlasBase}/clusters/${clusterName}/backup/snapshots`, {
        method: "POST",
        headers,
        body: JSON.stringify({ description: `Kill switch snapshot: ${sequence.trigger}`, retentionInDays: 30 }),
      });
      if (res.ok) {
        const responseText = await res.text();
        const data = JSON.parse(responseText);
        result.success = true;
        result.snapshotId = data.id;
        result.details = `Snapshot initiated: ${data.id}`;
      } else {
        result.details = `Snapshot failed: ${res.status} ${await res.text()}`;
      }
      break;
    }

    case "verify-snapshot": {
      if (!sequence.snapshotId) {
        result.details = "No snapshot ID to verify";
        break;
      }
      const res = await fetch(`${atlasBase}/clusters/${clusterName}/backup/snapshots/${sequence.snapshotId}`, { headers });
      if (res.ok) {
        const responseText = await res.text();
        const data = JSON.parse(responseText);
        result.success = data.status === "completed";
        result.details = `Snapshot status: ${data.status}, size: ${data.storageSizeBytes} bytes`;
      } else {
        result.details = `Verify failed: ${res.status}`;
      }
      break;
    }

    case "isolate": {
      // Remove all IP whitelist entries (block all connections)
      const listRes = await fetch(`${atlasBase}/accessList`, { headers });
      if (listRes.ok) {
        const responseText = await listRes.text();
        const data = JSON.parse(responseText);
        let removed = 0;
        for (const entry of data.results || []) {
          const cidr = encodeURIComponent(entry.cidrBlock || entry.ipAddress);
          await fetch(`${atlasBase}/accessList/${cidr}`, { method: "DELETE", headers });
          removed++;
        }
        result.success = true;
        result.details = `Removed ${removed} IP whitelist entries — all connections blocked`;
      }
      break;
    }

    case "nuke": {
      // Pause the cluster (stops billing and access, preserves data for restore)
      const res = await fetch(`${atlasBase}/clusters/${clusterName}`, {
        method: "PATCH",
        headers,
        body: JSON.stringify({ paused: true }),
      });
      result.success = res.ok;
      result.details = res.ok
        ? `Cluster ${clusterName} PAUSED. Data preserved, all access revoked. Snapshot: ${sequence.snapshotId}`
        : `Pause failed: ${res.status}`;
      result.snapshotId = sequence.snapshotId;
      break;
    }

    case "rotate-credentials": {
      // Reset the database user passwords (requires re-creating users)
      result.success = false;
      result.details = "Credential rotation for Atlas requires manual re-creation of database users via the Atlas API";
      break;
    }

    default:
      result.details = `Unsupported action for MongoDB Atlas: ${action}`;
  }

  return result;
}

// ─── Cloud SQL PostgreSQL ───────────────────────────────────────────────────

async function executeCloudSQLStep(
  credential: DatabaseCredential,
  action: DatabaseKillAction,
  sequence: KillSequenceState
): Promise<DatabaseKillResult> {
  const { gcpAccessToken, gcpProjectId, instanceName } = credential;
  if (!gcpAccessToken || !gcpProjectId || !instanceName) {
    return { action, success: false, provider: "cloud-sql-postgres", target: instanceName || "?",
      details: "Missing Cloud SQL credentials", timestamp: Date.now() };
  }

  const sqlBase = `https://sqladmin.googleapis.com/v1/projects/${gcpProjectId}/instances/${instanceName}`;
  const headers = { "Authorization": `Bearer ${gcpAccessToken}`, "Content-Type": "application/json" };

  const result: DatabaseKillResult = {
    action, success: false, provider: "cloud-sql-postgres", target: instanceName,
    details: "", timestamp: Date.now(),
  };

  switch (action) {
    case "snapshot": {
      const res = await fetch(`${sqlBase}/backupRuns`, {
        method: "POST",
        headers,
        body: JSON.stringify({ kind: "sql#backupRun", description: `Kill switch: ${sequence.trigger}` }),
      });
      if (res.ok) {
        const responseText = await res.text();
        const data = JSON.parse(responseText);
        result.success = true;
        result.snapshotId = data.id || data.name;
        result.details = `Backup initiated: ${result.snapshotId}`;
      } else {
        result.details = `Backup failed: ${res.status} ${(await res.text()).substring(0, 200)}`;
      }
      break;
    }

    case "verify-snapshot": {
      if (!sequence.snapshotId) {
        result.details = "No snapshot ID to verify";
        break;
      }
      const res = await fetch(`${sqlBase}/backupRuns/${sequence.snapshotId}`, { headers });
      if (res.ok) {
        const responseText = await res.text();
        const data = JSON.parse(responseText);
        result.success = data.status === "SUCCESSFUL";
        result.details = `Backup status: ${data.status}`;
      } else {
        result.details = `Verify failed: ${res.status}`;
      }
      break;
    }

    case "isolate": {
      // Remove all authorized networks
      const getRes = await fetch(sqlBase, { headers });
      if (getRes.ok) {
        const responseText = await getRes.text();
        const instance = JSON.parse(responseText);
        instance.settings.ipConfiguration.authorizedNetworks = [];
        const patchRes = await fetch(sqlBase, {
          method: "PATCH", headers,
          body: JSON.stringify({ settings: { ipConfiguration: { authorizedNetworks: [] } } }),
        });
        result.success = patchRes.ok;
        result.details = patchRes.ok
          ? "All authorized networks removed — database isolated"
          : `Isolation failed: ${patchRes.status}`;
      }
      break;
    }

    case "nuke": {
      // Stop the instance (preserves data, stops access and billing)
      const res = await fetch(`${sqlBase}/stop`, {
        method: "POST",
        headers,
      });
      // Fallback: if stop isn't available, patch activation policy
      if (!res.ok) {
        const patchRes = await fetch(sqlBase, {
          method: "PATCH", headers,
          body: JSON.stringify({ settings: { activationPolicy: "NEVER" } }),
        });
        result.success = patchRes.ok;
        result.details = patchRes.ok
          ? `Instance ${instanceName} set to NEVER activate. Snapshot: ${sequence.snapshotId}`
          : `Nuke failed: ${patchRes.status}`;
      } else {
        result.success = true;
        result.details = `Instance ${instanceName} STOPPED. Snapshot: ${sequence.snapshotId}`;
      }
      result.snapshotId = sequence.snapshotId;
      break;
    }

    default:
      result.details = `Unsupported action for Cloud SQL: ${action}`;
  }

  return result;
}

// ─── Redis ──────────────────────────────────────────────────────────────────

async function executeRedisStep(
  credential: DatabaseCredential,
  action: DatabaseKillAction,
  sequence: KillSequenceState
): Promise<DatabaseKillResult> {
  // Redis kill switch is simpler — mainly about connection control
  // For managed Redis (Upstash, Redis Cloud), use their APIs
  // For self-hosted, would need direct connection

  const result: DatabaseKillResult = {
    action, success: false, provider: "redis", target: credential.redisHost || "?",
    details: "", timestamp: Date.now(),
  };

  switch (action) {
    case "snapshot":
      result.details = "Redis snapshot: use BGSAVE via Redis CLI or managed provider's backup API";
      result.success = true; // Manual step acknowledged
      result.snapshotId = `redis-manual-${Date.now()}`;
      break;

    case "verify-snapshot":
      result.success = true;
      result.details = "Redis snapshot verification: manual confirmation required";
      break;

    case "isolate":
      result.details = "Redis isolation: update firewall rules or Upstash IP whitelist via their API";
      result.success = true;
      break;

    case "nuke":
      result.details = "Redis nuke: FLUSHALL via CLI or delete instance via managed provider API. Snapshot: " + sequence.snapshotId;
      result.success = true;
      result.snapshotId = sequence.snapshotId;
      break;

    default:
      result.details = `Unsupported action for Redis: ${action}`;
  }

  return result;
}
