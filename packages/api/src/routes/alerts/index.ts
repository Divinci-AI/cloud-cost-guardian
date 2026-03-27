/**
 * Alert Routes
 *
 * View alert history and test alert channels.
 */

import { Router } from "express";
import { GuardianAccountModel } from "../../models/guardian-account/schema.js";
import { sendAlerts } from "../../services/alerting.js";

export const alertRouter = Router();

/**
 * GET /alerts/channels — Get configured alert channels
 */
alertRouter.get("/channels", async (req, res, next) => {
  try {
    const guardianAccountId = (req as any).guardianAccountId;
    const account = await GuardianAccountModel.findById(guardianAccountId);
    if (!account) {
      return res.status(404).json({ error: "Account not found" });
    }

    res.json({
      channels: account.alertChannels.map(c => ({
        type: c.type,
        name: c.name,
        enabled: c.enabled,
        config: c.config,
        // Masked values for display (full values needed for PUT round-trip)
        configPreview: c.config.email
          || (c.config.webhookUrl ? c.config.webhookUrl.substring(0, 40) + "..." : null)
          || (c.config.routingKey ? "****" + c.config.routingKey.slice(-4) : null)
          || null,
      })),
    });
  } catch (e) {
    next(e);
  }
});

/**
 * PUT /alerts/channels — Update alert channels
 */
alertRouter.put("/channels", async (req, res, next) => {
  try {
    const guardianAccountId = (req as any).guardianAccountId;
    const { channels } = req.body;

    if (!Array.isArray(channels)) {
      return res.status(400).json({ error: "channels must be an array" });
    }

    const account = await GuardianAccountModel.findByIdAndUpdate(
      guardianAccountId,
      { alertChannels: channels },
      { new: true }
    );

    if (!account) {
      return res.status(404).json({ error: "Account not found" });
    }

    res.json({ updated: true, channelCount: account.alertChannels.length });
  } catch (e) {
    next(e);
  }
});

/**
 * POST /alerts/test — Send a test alert to all configured channels
 */
alertRouter.post("/test", async (req, res, next) => {
  try {
    const guardianAccountId = (req as any).guardianAccountId;
    const account = await GuardianAccountModel.findById(guardianAccountId);
    if (!account) {
      return res.status(404).json({ error: "Account not found" });
    }

    if (account.alertChannels.length === 0) {
      return res.status(400).json({ error: "No alert channels configured" });
    }

    await sendAlerts(account.alertChannels, "Test alert from Kill Switch", "info", {
      test: true,
      message: "If you received this, your alert integration is working correctly.",
      timestamp: new Date().toISOString(),
    });

    res.json({
      status: "sent",
      channelsSent: account.alertChannels.filter(c => c.enabled).length,
    });
  } catch (e) {
    next(e);
  }
});
