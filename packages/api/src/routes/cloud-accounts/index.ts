/**
 * Cloud Account Routes
 *
 * Connect, configure, and manage cloud provider accounts.
 */

import { Router } from "express";
import { CloudAccountModel } from "../../models/cloud-account/schema.js";
import { storeCredential, deleteCredential } from "../../models/encrypted-credential/schema.js";
import { getProvider } from "../../providers/index.js";
import { runCheckCycle } from "../../services/monitoring-engine.js";
import { enforceTierLimits } from "../billing/index.js";
import type { DecryptedCredential } from "../../providers/types.js";

export const cloudAccountRouter = Router();

// Enforce tier limits on POST (creating new cloud accounts)
cloudAccountRouter.post("/", enforceTierLimits("cloudAccounts"));

/**
 * POST /cloud-accounts — Connect a new cloud provider
 * Body: { provider, name, credential: { apiToken, accountId } | { serviceAccountJson, projectId } }
 */
cloudAccountRouter.post("/", async (req, res, next) => {
  try {
    const { provider: providerId, name, credential } = req.body;
    const guardianAccountId = (req as any).guardianAccountId;

    if (!providerId || !name || !credential) {
      return res.status(400).json({ error: "Missing provider, name, or credential" });
    }

    const provider = getProvider(providerId);
    if (!provider) {
      return res.status(400).json({ error: `Unsupported provider: ${providerId}` });
    }

    // Validate credentials before storing
    const validation = await provider.validateCredential(credential as DecryptedCredential);
    if (!validation.valid) {
      return res.status(400).json({
        error: "Invalid credentials",
        details: validation.error,
      });
    }

    // Encrypt and store credential
    const credentialId = await storeCredential(guardianAccountId, providerId, credential);

    // Create cloud account with default thresholds
    const cloudAccount = await CloudAccountModel.create({
      guardianAccountId,
      provider: providerId,
      name,
      providerAccountId: validation.accountId || credential.accountId || credential.projectId,
      credentialId,
      thresholds: provider.getDefaultThresholds(),
      protectedServices: [],
      autoDisconnect: true,
      autoDelete: false,
    });

    res.status(201).json({
      id: cloudAccount._id,
      provider: cloudAccount.provider,
      name: cloudAccount.name,
      providerAccountId: cloudAccount.providerAccountId,
      providerAccountName: validation.accountName,
      thresholds: cloudAccount.thresholds,
      status: cloudAccount.status,
    });
  } catch (e) {
    next(e);
  }
});

/**
 * GET /cloud-accounts — List all connected accounts
 */
cloudAccountRouter.get("/", async (req, res, next) => {
  try {
    const guardianAccountId = (req as any).guardianAccountId;
    const accounts = await CloudAccountModel.find({ guardianAccountId }).lean();

    res.json({
      accounts: accounts.map(a => ({
        id: a._id,
        provider: a.provider,
        name: a.name,
        providerAccountId: a.providerAccountId,
        status: a.status,
        thresholds: a.thresholds,
        protectedServices: a.protectedServices,
        autoDisconnect: a.autoDisconnect,
        lastCheckAt: a.lastCheckAt,
        lastCheckStatus: a.lastCheckStatus,
        lastViolations: a.lastViolations,
      })),
    });
  } catch (e) {
    next(e);
  }
});

/**
 * GET /cloud-accounts/:id — Get details
 */
cloudAccountRouter.get("/:id", async (req, res, next) => {
  try {
    const guardianAccountId = (req as any).guardianAccountId;
    const account = await CloudAccountModel.findOne({ _id: req.params.id, guardianAccountId }).lean();
    if (!account) {
      return res.status(404).json({ error: "Cloud account not found" });
    }
    res.json(account);
  } catch (e) {
    next(e);
  }
});

/**
 * PUT /cloud-accounts/:id — Update thresholds, protected services, etc.
 */
cloudAccountRouter.put("/:id", async (req, res, next) => {
  try {
    const { thresholds, protectedServices, autoDisconnect, autoDelete, name, status } = req.body;
    const update: any = {};

    if (thresholds) update.thresholds = thresholds;
    if (protectedServices) update.protectedServices = protectedServices;
    if (autoDisconnect !== undefined) update.autoDisconnect = autoDisconnect;
    if (autoDelete !== undefined) update.autoDelete = autoDelete;
    if (name) update.name = name;
    if (status && ["active", "paused"].includes(status)) update.status = status;

    const guardianAccountId = (req as any).guardianAccountId;
    const account = await CloudAccountModel.findOneAndUpdate(
      { _id: req.params.id, guardianAccountId }, update, { new: true }
    );
    if (!account) {
      return res.status(404).json({ error: "Cloud account not found" });
    }

    res.json(account);
  } catch (e) {
    next(e);
  }
});

/**
 * DELETE /cloud-accounts/:id — Disconnect and delete credential
 */
cloudAccountRouter.delete("/:id", async (req, res, next) => {
  try {
    const guardianAccountId = (req as any).guardianAccountId;
    const account = await CloudAccountModel.findOne({ _id: req.params.id, guardianAccountId });
    if (!account) {
      return res.status(404).json({ error: "Cloud account not found" });
    }

    // Delete encrypted credential
    await deleteCredential(account.credentialId);
    // Delete cloud account
    await CloudAccountModel.findByIdAndDelete(req.params.id);

    res.json({ deleted: true });
  } catch (e) {
    next(e);
  }
});

/**
 * POST /cloud-accounts/:id/check — Manual check trigger
 */
cloudAccountRouter.post("/:id/check", async (req, res, next) => {
  try {
    // For now, run full cycle — in future, check single account
    const results = await runCheckCycle();
    const result = results.find(r => r.cloudAccountId === req.params.id);
    res.json(result || { status: "not found" });
  } catch (e) {
    next(e);
  }
});
