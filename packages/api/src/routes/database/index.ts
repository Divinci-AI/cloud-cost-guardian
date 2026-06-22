/**
 * Database Kill Switch Routes
 *
 * API for initiating, monitoring, and confirming database kill sequences.
 * Every destructive action requires a verified snapshot first.
 * All operations are scoped to the authenticated user's account.
 *
 * Database credentials are stored encrypted at rest and referenced by ID.
 */

import { Router } from "express";
import { requirePermission } from "../../middleware/permissions.js";
import { logActivity } from "../../services/activity-logger.js";
import {
  initiateKillSequence,
  advanceKillSequence,
  abortKillSequence,
  getKillSequence,
  listActiveSequences,
  AdvanceInProgressError,
  type DatabaseCredential,
  type DatabaseKillAction,
} from "../../services/database-kill-switch.js";
import {
  storeGenericCredential,
  getGenericCredential,
  deleteCredential,
  EncryptedCredentialModel,
} from "../../models/encrypted-credential/schema.js";
import { CloudAccountModel } from "../../models/cloud-account/schema.js";

export const databaseRouter = Router();

const DB_PROVIDERS = ["mongodb-atlas", "cloud-sql-postgres", "redis"];

/**
 * GET /database/credentials — List stored database credentials (metadata only,
 * never decrypted). Excludes credentials linked to cloud accounts so the
 * monitoring creds for provider "redis" don't show up as kill targets.
 */
databaseRouter.get("/credentials", requirePermission("kill_switch:read"), async (req: any, res, next) => {
  try {
    const guardianAccountId = req.guardianAccountId;
    const [creds, linked] = await Promise.all([
      EncryptedCredentialModel.find({ guardianAccountId, provider: { $in: DB_PROVIDERS } }).lean(),
      CloudAccountModel.find({ guardianAccountId }).select("credentialId").lean(),
    ]);
    const linkedIds = new Set(linked.map((a: any) => String(a.credentialId)));
    res.json({
      credentials: creds
        .filter((c: any) => !linkedIds.has(String(c._id)))
        .map((c: any) => ({
          id: String(c._id),
          provider: c.provider,
          keyPreview: c.keyPreview,
          createdAt: c.createdAt,
        })),
    });
  } catch (e) { next(e); }
});

/**
 * POST /database/credentials — Store database credentials encrypted
 * Body: { provider, ...credentialFields }
 * Returns: { credentialId }
 */
databaseRouter.post("/credentials", requirePermission("kill_switch:trigger"), async (req: any, res, next) => {
  try {
    const guardianAccountId = req.guardianAccountId;
    const { provider, ...credentialFields } = req.body as DatabaseCredential & Record<string, any>;

    if (!provider) {
      return res.status(400).json({ error: "Missing provider" });
    }

    if (!DB_PROVIDERS.includes(provider)) {
      return res.status(400).json({ error: `Invalid provider. Must be one of: ${DB_PROVIDERS.join(", ")}` });
    }

    // Determine a preview field based on provider
    const previewFields: Record<string, string> = {
      "mongodb-atlas": "atlasPublicKey",
      "cloud-sql-postgres": "instanceName",
      "redis": "redisHost",
    };

    const credentialId = await storeGenericCredential(
      guardianAccountId,
      provider,
      { provider, ...credentialFields },
      previewFields[provider],
    );

    res.status(201).json({ credentialId });
  } catch (e) { next(e); }
});

/**
 * DELETE /database/credentials/:id — Delete stored database credentials
 */
databaseRouter.delete("/credentials/:id", requirePermission("kill_switch:trigger"), async (req: any, res, next) => {
  try {
    const deleted = await deleteCredential(req.params.id, req.guardianAccountId);
    if (!deleted) return res.status(404).json({ error: "Credential not found" });
    res.json({ deleted: true });
  } catch (e) { next(e); }
});

/**
 * POST /database/kill — Initiate a database kill sequence
 * Body: { credentialId, trigger, actions? }
 */
databaseRouter.post("/kill", requirePermission("kill_switch:trigger"), async (req: any, res, next) => {
  try {
    const guardianAccountId = req.guardianAccountId;
    const { credentialId, trigger, actions } = req.body as {
      credentialId?: string;
      trigger: string;
      actions?: DatabaseKillAction[];
    };

    if (!trigger) {
      return res.status(400).json({ error: "Missing trigger" });
    }

    let credential: DatabaseCredential;

    if (!credentialId) {
      return res.status(400).json({ error: "Missing credentialId. Store credentials first via POST /database/credentials" });
    }

    const decrypted = await getGenericCredential(credentialId, guardianAccountId);
    if (!decrypted) return res.status(404).json({ error: "Credential not found" });
    credential = decrypted as DatabaseCredential;

    const sequence = await initiateKillSequence(credential, trigger, actions, guardianAccountId);

    logActivity({
      orgId: guardianAccountId, actorUserId: req.userId, actorEmail: req.auth?.email,
      action: "kill_switch.trigger", resourceType: "database_kill", resourceId: sequence.id,
      details: { trigger }, ipAddress: req.ip,
    });

    res.status(201).json({
      sequenceId: sequence.id,
      status: sequence.status,
      steps: sequence.steps.map(s => ({ action: s.action, status: s.status })),
      message: "Kill sequence initiated. Call POST /database/kill/:id/advance to execute each step.",
    });
  } catch (e) { next(e); }
});

/**
 * POST /database/kill/:id/advance — Execute the next step
 * Body: { credentialId?, humanApproval? }
 */
databaseRouter.post("/kill/:id/advance", requirePermission("kill_switch:trigger"), async (req: any, res, next) => {
  try {
    const guardianAccountId = req.guardianAccountId;
    const { credentialId, humanApproval } = req.body;

    if (!credentialId) {
      return res.status(400).json({ error: "Missing credentialId. Store credentials first via POST /database/credentials" });
    }

    const decrypted = await getGenericCredential(credentialId, guardianAccountId);
    if (!decrypted) return res.status(404).json({ error: "Credential not found" });
    const credential = decrypted as DatabaseCredential;

    let updated;
    try {
      updated = await advanceKillSequence(req.params.id, credential, humanApproval, guardianAccountId);
    } catch (e: any) {
      if (e instanceof AdvanceInProgressError) {
        return res.status(409).json({ error: e.message });
      }
      throw e;
    }
    if (!updated) return res.status(404).json({ error: "Kill sequence not found" });

    logActivity({
      orgId: guardianAccountId, actorUserId: req.userId, actorEmail: req.auth?.email,
      action: "kill_switch.advance", resourceType: "database_kill", resourceId: req.params.id,
      details: { step: updated.currentStep }, ipAddress: req.ip,
    });

    res.json({
      sequenceId: updated.id,
      status: updated.status,
      currentStep: updated.currentStep,
      snapshotId: updated.snapshotId,
      snapshotVerified: updated.snapshotVerified,
      steps: updated.steps.map(s => ({
        action: s.action, status: s.status, result: s.result, timestamp: s.timestamp,
      })),
    });
  } catch (e: any) {
    next(e);
  }
});

/**
 * POST /database/kill/:id/abort — Abort a kill sequence
 */
databaseRouter.post("/kill/:id/abort", requirePermission("kill_switch:trigger"), async (req: any, res, next) => {
  try {
    const guardianAccountId = req.guardianAccountId;
    const aborted = await abortKillSequence(req.params.id, guardianAccountId);

    if (!aborted) return res.status(404).json({ error: "Kill sequence not found" });

    logActivity({
      orgId: guardianAccountId, actorUserId: req.userId, actorEmail: req.auth?.email,
      action: "kill_switch.abort", resourceType: "database_kill", resourceId: req.params.id,
      ipAddress: req.ip,
    });

    res.json({ sequenceId: aborted.id, status: aborted.status, message: "Kill sequence aborted" });
  } catch (e) { next(e); }
});

/**
 * GET /database/kill/:id — Get status of a kill sequence (ownership verified)
 */
databaseRouter.get("/kill/:id", requirePermission("kill_switch:read"), async (req: any, res, next) => {
  try {
    const sequence = await getKillSequence(req.params.id, req.guardianAccountId);
    if (!sequence) return res.status(404).json({ error: "Kill sequence not found" });
    res.json(sequence);
  } catch (e) { next(e); }
});

/**
 * GET /database/kill — List active kill sequences (filtered to current user)
 */
databaseRouter.get("/kill", requirePermission("kill_switch:read"), async (req: any, res, next) => {
  try {
    const sequences = await listActiveSequences(req.guardianAccountId);
    res.json({ sequences });
  } catch (e) { next(e); }
});
