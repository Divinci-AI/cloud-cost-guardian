/**
 * CLI Device-Flow Auth Routes
 *
 * Browser-based login for the `ks` CLI. Flow:
 *   1. CLI hits POST /auth/cli/start (anonymous) → receives short code + URL
 *   2. User opens URL in browser, signs in via Clerk on /cli-auth?code=...
 *   3. Browser hits POST /auth/cli/approve (Clerk JWT + X-Org-Id) → mints API key
 *   4. CLI polls POST /auth/cli/poll (anonymous) → receives plaintext key once
 *
 * Routes /start and /poll are public; /approve and /deny require Clerk JWT.
 */

import { Router } from "express";
import {
  createCliCode,
  approveCliCode,
  denyCliCode,
  consumeCliCode,
} from "../../models/cli-auth/schema.js";
import { requireAuth, resolveOrg } from "../../middleware/auth.js";
import { requirePermission } from "../../middleware/permissions.js";
import { logActivity } from "../../services/activity-logger.js";

export const cliAuthRouter = Router();

const VERIFY_BASE_URL = process.env.CLI_AUTH_VERIFY_BASE_URL || "https://app.kill-switch.net/cli-auth";

/**
 * POST /auth/cli/start — Anonymous. CLI initiates the device flow.
 * Body: { hostname?, cliVersion? }
 */
cliAuthRouter.post("/start", async (req, res, next) => {
  try {
    const { hostname, cliVersion } = req.body ?? {};
    const { code, expiresAt } = await createCliCode({ hostname, cliVersion });

    res.status(201).json({
      code,
      verification_url: `${VERIFY_BASE_URL}?code=${encodeURIComponent(code)}`,
      expires_in: Math.floor((expiresAt.getTime() - Date.now()) / 1000),
      polling_interval: 2,
    });
  } catch (e) { next(e); }
});

/**
 * POST /auth/cli/poll — Anonymous. CLI polls until approved or expired.
 * Body: { code }
 * Maps the consumeCliCode result to HTTP status codes that the CLI loop reads.
 */
cliAuthRouter.post("/poll", async (req, res, next) => {
  try {
    const { code } = req.body ?? {};
    if (!code || typeof code !== "string") {
      return res.status(400).json({ error: "Missing code" });
    }

    const result = await consumeCliCode(code);

    switch (result.status) {
      case "approved":
        return res.status(200).json({ status: "approved", api_key: result.apiKey });
      case "pending":
        return res.status(202).json({ status: "pending" });
      case "denied":
        return res.status(410).json({ status: "denied" });
      case "expired":
        return res.status(410).json({ status: "expired" });
      case "consumed":
        return res.status(410).json({ status: "consumed" });
      case "unknown":
        return res.status(404).json({ status: "unknown" });
    }
  } catch (e) { next(e); }
});

/**
 * POST /auth/cli/approve — Clerk JWT required. Browser confirms the code.
 * Body: { code, keyName? }
 * Header: X-Org-Id selects which org the new API key belongs to.
 */
cliAuthRouter.post(
  "/approve",
  requireAuth,
  resolveOrg,
  requirePermission("api_keys:manage"),
  async (req: any, res, next) => {
    try {
      const { code, keyName } = req.body ?? {};
      if (!code || typeof code !== "string") {
        return res.status(400).json({ error: "Missing code" });
      }

      const finalKeyName = (typeof keyName === "string" && keyName.trim())
        ? keyName.trim().slice(0, 100)
        : `CLI on ${req.body?.hostnameHint || "unknown"}`;

      const result = await approveCliCode(
        code,
        req.userId,
        req.guardianAccountId,
        finalKeyName,
      );

      if ("error" in result) {
        const httpStatus = result.error === "not_found" ? 404 : 410;
        return res.status(httpStatus).json({ error: result.error });
      }

      logActivity({
        orgId: req.guardianAccountId,
        actorUserId: req.userId,
        actorEmail: req.auth?.email,
        action: "api_key.create",
        resourceType: "api_key",
        resourceId: result.apiKeyId,
        details: { name: finalKeyName, source: "cli-device-flow" },
        ipAddress: req.ip,
      });

      res.status(200).json({ approved: true });
    } catch (e) { next(e); }
  },
);

/**
 * POST /auth/cli/deny — Clerk JWT required. Browser rejects the code.
 * Body: { code }
 */
cliAuthRouter.post(
  "/deny",
  requireAuth,
  resolveOrg,
  async (req: any, res, next) => {
    try {
      const { code } = req.body ?? {};
      if (!code || typeof code !== "string") {
        return res.status(400).json({ error: "Missing code" });
      }
      const denied = await denyCliCode(code);
      if (!denied) return res.status(410).json({ error: "Code is not pending" });
      res.status(200).json({ denied: true });
    } catch (e) { next(e); }
  },
);
