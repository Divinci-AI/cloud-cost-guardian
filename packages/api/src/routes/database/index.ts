/**
 * Database Kill Switch Routes
 *
 * API for initiating, monitoring, and confirming database kill sequences.
 * Every destructive action requires a verified snapshot first.
 * All operations are scoped to the authenticated user's account.
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

export const databaseRouter = Router();

/**
 * POST /database/kill — Initiate a database kill sequence
 * Body: { credential, trigger, actions? }
 *
 * SECURITY NOTE: Credentials are passed in request body for now.
 * TODO: Store database credentials encrypted like cloud account credentials
 * and reference by ID instead of passing raw credentials.
 */
databaseRouter.post("/kill", (req, res) => {
  const guardianAccountId = (req as any).guardianAccountId;
  const { credential, trigger, actions } = req.body as {
    credential: DatabaseCredential;
    trigger: string;
    actions?: DatabaseKillAction[];
  };

  if (!credential?.provider || !trigger) {
    return res.status(400).json({ error: "Missing credential.provider or trigger" });
  }

  const sequence = initiateKillSequence(credential, trigger, actions);
  // Tag sequence with owner for access control
  (sequence as any).guardianAccountId = guardianAccountId;

  res.status(201).json({
    sequenceId: sequence.id,
    status: sequence.status,
    steps: sequence.steps.map(s => ({ action: s.action, status: s.status })),
    message: "Kill sequence initiated. Call POST /database/kill/:id/advance to execute each step.",
  });
});

/**
 * POST /database/kill/:id/advance — Execute the next step
 * Body: { credential, humanApproval? }
 */
databaseRouter.post("/kill/:id/advance", async (req, res, next) => {
  try {
    const guardianAccountId = (req as any).guardianAccountId;
    const sequence = getKillSequence(req.params.id);

    if (!sequence) return res.status(404).json({ error: "Kill sequence not found" });
    if ((sequence as any).guardianAccountId && (sequence as any).guardianAccountId !== guardianAccountId) {
      return res.status(403).json({ error: "Not authorized to advance this sequence" });
    }

    const { credential, humanApproval } = req.body;
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
databaseRouter.post("/kill/:id/abort", (req, res) => {
  const guardianAccountId = (req as any).guardianAccountId;
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
databaseRouter.get("/kill/:id", (req, res) => {
  const guardianAccountId = (req as any).guardianAccountId;
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
databaseRouter.get("/kill", (req, res) => {
  const guardianAccountId = (req as any).guardianAccountId;
  const all = listActiveSequences();
  const mine = all.filter(s => (s as any).guardianAccountId === guardianAccountId);
  res.json({ sequences: mine });
});
