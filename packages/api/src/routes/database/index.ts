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
import {
  initiateKillSequence,
  advanceKillSequence,
  abortKillSequence,
  getKillSequence,
  listActiveSequences,
  type DatabaseCredential,
  type DatabaseKillAction,
} from "../../services/database-kill-switch.js";
import {
  storeGenericCredential,
  getGenericCredential,
  deleteCredential,
} from "../../models/encrypted-credential/schema.js";

export const databaseRouter = Router();

/**
 * POST /database/credentials — Store database credentials encrypted
 * Body: { provider, ...credentialFields }
 * Returns: { credentialId }
 */
databaseRouter.post("/credentials", async (req: any, res, next) => {
  try {
    const guardianAccountId = req.guardianAccountId;
    const { provider, ...credentialFields } = req.body as DatabaseCredential & Record<string, any>;

    if (!provider) {
      return res.status(400).json({ error: "Missing provider" });
    }

    const validProviders = ["mongodb-atlas", "cloud-sql-postgres", "redis"];
    if (!validProviders.includes(provider)) {
      return res.status(400).json({ error: `Invalid provider. Must be one of: ${validProviders.join(", ")}` });
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
databaseRouter.delete("/credentials/:id", async (req: any, res, next) => {
  try {
    const deleted = await deleteCredential(req.params.id);
    if (!deleted) return res.status(404).json({ error: "Credential not found" });
    res.json({ deleted: true });
  } catch (e) { next(e); }
});

/**
 * POST /database/kill — Initiate a database kill sequence
 * Body: { credentialId, trigger, actions? }
 *   OR: { credential, trigger, actions? }  (legacy — still supported but deprecated)
 */
databaseRouter.post("/kill", async (req: any, res, next) => {
  try {
    const guardianAccountId = req.guardianAccountId;
    const { credentialId, credential: rawCredential, trigger, actions } = req.body as {
      credentialId?: string;
      credential?: DatabaseCredential;
      trigger: string;
      actions?: DatabaseKillAction[];
    };

    if (!trigger) {
      return res.status(400).json({ error: "Missing trigger" });
    }

    let credential: DatabaseCredential;

    if (credentialId) {
      // Preferred: decrypt stored credential
      const decrypted = await getGenericCredential(credentialId);
      if (!decrypted) return res.status(404).json({ error: "Credential not found" });
      credential = decrypted as DatabaseCredential;
    } else if (rawCredential?.provider) {
      // Legacy: raw credential in body (deprecated)
      credential = rawCredential;
    } else {
      return res.status(400).json({ error: "Missing credentialId or credential.provider" });
    }

    const sequence = initiateKillSequence(credential, trigger, actions);
    (sequence as any).guardianAccountId = guardianAccountId;

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
 * Body: { credentialId, humanApproval? }
 *   OR: { credential, humanApproval? }  (legacy)
 */
databaseRouter.post("/kill/:id/advance", async (req: any, res, next) => {
  try {
    const guardianAccountId = req.guardianAccountId;
    const sequence = getKillSequence(req.params.id);

    if (!sequence) return res.status(404).json({ error: "Kill sequence not found" });
    if ((sequence as any).guardianAccountId && (sequence as any).guardianAccountId !== guardianAccountId) {
      return res.status(403).json({ error: "Not authorized to advance this sequence" });
    }

    const { credentialId, credential: rawCredential, humanApproval } = req.body;

    let credential: DatabaseCredential | undefined;
    if (credentialId) {
      const decrypted = await getGenericCredential(credentialId);
      if (!decrypted) return res.status(404).json({ error: "Credential not found" });
      credential = decrypted as DatabaseCredential;
    } else if (rawCredential) {
      credential = rawCredential;
    }

    const updated = await advanceKillSequence(req.params.id, credential, humanApproval);

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
databaseRouter.post("/kill/:id/abort", (req: any, res) => {
  const guardianAccountId = req.guardianAccountId;
  const sequence = getKillSequence(req.params.id);

  if (!sequence) return res.status(404).json({ error: "Kill sequence not found" });
  if ((sequence as any).guardianAccountId && (sequence as any).guardianAccountId !== guardianAccountId) {
    return res.status(403).json({ error: "Not authorized to abort this sequence" });
  }

  const aborted = abortKillSequence(req.params.id);
  res.json({ sequenceId: aborted!.id, status: aborted!.status, message: "Kill sequence aborted" });
});

/**
 * GET /database/kill/:id — Get status of a kill sequence (ownership verified)
 */
databaseRouter.get("/kill/:id", (req: any, res) => {
  const guardianAccountId = req.guardianAccountId;
  const sequence = getKillSequence(req.params.id);

  if (!sequence) return res.status(404).json({ error: "Kill sequence not found" });
  if ((sequence as any).guardianAccountId && (sequence as any).guardianAccountId !== guardianAccountId) {
    return res.status(403).json({ error: "Not authorized to view this sequence" });
  }

  res.json(sequence);
});

/**
 * GET /database/kill — List active kill sequences (filtered to current user)
 */
databaseRouter.get("/kill", (req: any, res) => {
  const guardianAccountId = req.guardianAccountId;
  const all = listActiveSequences();
  const mine = all.filter(s => (s as any).guardianAccountId === guardianAccountId);
  res.json({ sequences: mine });
});
