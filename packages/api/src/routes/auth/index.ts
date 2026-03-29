/**
 * Auth Routes — Personal API Key Management
 *
 * Allows users to create, list, roll, and revoke API keys for CLI access.
 * All endpoints require Clerk JWT authentication (you need to be logged
 * in via the web dashboard to manage API keys).
 */

import { Router } from "express";
import { createApiKey, listApiKeys, deleteApiKey } from "../../models/api-key/schema.js";

export const authRouter = Router();

/**
 * POST /auth/api-keys — Create a new personal API key
 * Body: { name: string }
 * Returns: { id, key, name } — key is shown ONLY once
 */
authRouter.post("/api-keys", async (req: any, res, next) => {
  try {
    const { name } = req.body;
    if (!name) return res.status(400).json({ error: "Missing name" });

    const result = await createApiKey(req.guardianAccountId, req.userId, name);

    res.status(201).json({
      id: result.id,
      key: result.key,
      name,
      message: "Save this key — it will not be shown again.",
    });
  } catch (e) { next(e); }
});

/**
 * GET /auth/api-keys — List API keys (metadata only)
 */
authRouter.get("/api-keys", async (req: any, res, next) => {
  try {
    const keys = await listApiKeys(req.guardianAccountId);
    res.json({ keys });
  } catch (e) { next(e); }
});

/**
 * POST /auth/api-keys/:id/roll — Roll (rotate) an API key
 * Creates a new key with the same name and revokes the old one atomically.
 * Returns: { id, key, name, previousKeyRevoked: true }
 */
authRouter.post("/api-keys/:id/roll", async (req: any, res, next) => {
  try {
    // Get the existing key's metadata
    const keys = await listApiKeys(req.guardianAccountId);
    const existing = keys.find((k: any) => k._id.toString() === req.params.id);
    if (!existing) return res.status(404).json({ error: "API key not found" });

    // Create new key with same name
    const result = await createApiKey(
      req.guardianAccountId,
      req.userId,
      existing.name
    );

    // Revoke old key
    await deleteApiKey(req.params.id, req.guardianAccountId);

    res.status(201).json({
      id: result.id,
      key: result.key,
      name: existing.name,
      previousKeyRevoked: true,
      message: "New key created and old key revoked. Save this key — it will not be shown again.",
    });
  } catch (e) { next(e); }
});

/**
 * DELETE /auth/api-keys/:id — Revoke an API key
 */
authRouter.delete("/api-keys/:id", async (req: any, res, next) => {
  try {
    const deleted = await deleteApiKey(req.params.id, req.guardianAccountId);
    if (!deleted) return res.status(404).json({ error: "API key not found" });
    res.json({ deleted: true });
  } catch (e) { next(e); }
});
