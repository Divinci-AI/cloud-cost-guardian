/**
 * Agent Guard Routes
 *
 * Ingest budget-trip events from the @kill-switch/agent-guard hook & proxy, and
 * list them for the dashboard. A coding-agent kill is the analog of a cloud
 * kill: on a `block` event we fan out through the org's existing alert channels
 * (PagerDuty/Slack/GitHub/...), the same path infrastructure kills use.
 *
 * Auth: mounted behind the standard requireAuth + resolveOrg stack in app.ts, so
 * a `ks_live_` API key (or Clerk JWT) identifies the org. Handlers read
 * req.guardianAccountId — never trust an account id from the body.
 */

import { Router } from "express";
import { AgentGuardEventModel } from "../../models/agent-guard-event/schema.js";
import { GuardianAccountModel } from "../../models/guardian-account/schema.js";
import { sendAlerts } from "../../services/alerting.js";
import { requirePermission } from "../../middleware/permissions.js";

export const agentGuardRouter = Router();

interface IncomingEvent {
  ts?: number;
  source?: string;
  sessionId?: string;
  level?: string;
  sessionUSD?: number;
  dailyUSD?: number;
  reasons?: unknown;
  action?: string;
  cwd?: string;
}

function fmtUSD(n: number): string {
  return `$${n.toFixed(n < 1 ? 4 : 2)}`;
}

/**
 * POST /agent-guard/events — record a budget trip; fan out alerts on block.
 */
agentGuardRouter.post("/events", requirePermission("cloud_accounts:read"), async (req, res, next) => {
  try {
    const guardianAccountId = (req as any).guardianAccountId as string;
    const orgId = guardianAccountId;
    const body = (req.body ?? {}) as IncomingEvent;

    // Validate — reject unknown levels/sources rather than silently storing junk.
    if (body.source !== "hook" && body.source !== "proxy") {
      return res.status(400).json({ error: "source must be 'hook' or 'proxy'" });
    }
    if (body.level !== "warn" && body.level !== "block") {
      return res.status(400).json({ error: "level must be 'warn' or 'block'" });
    }
    if (typeof body.sessionId !== "string" || !body.sessionId) {
      return res.status(400).json({ error: "sessionId is required" });
    }
    if (typeof body.sessionUSD !== "number" || typeof body.dailyUSD !== "number") {
      return res.status(400).json({ error: "sessionUSD and dailyUSD must be numbers" });
    }

    const reasons = Array.isArray(body.reasons) ? body.reasons.map(String) : [];

    const doc = await AgentGuardEventModel.create({
      guardianAccountId,
      orgId,
      ts: typeof body.ts === "number" ? body.ts : Date.now(),
      source: body.source,
      sessionId: body.sessionId,
      level: body.level,
      sessionUSD: body.sessionUSD,
      dailyUSD: body.dailyUSD,
      reasons,
      action: typeof body.action === "string" ? body.action : "",
      cwd: typeof body.cwd === "string" ? body.cwd : undefined,
    });

    // Fan out only block-level events through the org's alert channels.
    if (body.level === "block") {
      const account = await GuardianAccountModel.findById(guardianAccountId);
      if (account && account.alertChannels.length > 0) {
        const summary = `Coding agent BLOCKED — session ${fmtUSD(body.sessionUSD)}, daily ${fmtUSD(body.dailyUSD)}`;
        await sendAlerts(account.alertChannels, summary, "critical", {
          source: `agent-guard:${body.source}`,
          sessionId: body.sessionId,
          sessionUSD: body.sessionUSD,
          dailyUSD: body.dailyUSD,
          project: body.cwd ?? "(unknown)",
          action: body.action ?? "",
          reasons,
        }).catch((e) => console.error("[guardian] agent-guard alert fan-out failed:", e?.message || e));
      }
    }

    res.status(200).json({ received: true, id: doc._id.toString() });
  } catch (e) {
    next(e);
  }
});

/**
 * GET /agent-guard/events — recent events for this org (newest first, paginated).
 */
agentGuardRouter.get("/events", requirePermission("cloud_accounts:read"), async (req, res, next) => {
  try {
    const guardianAccountId = (req as any).guardianAccountId as string;
    const limit = Math.min(parseInt(req.query.limit as string) || 50, 200);
    const skip = Math.max(parseInt(req.query.skip as string) || 0, 0);

    const [events, total] = await Promise.all([
      AgentGuardEventModel.find({ guardianAccountId })
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      AgentGuardEventModel.countDocuments({ guardianAccountId }),
    ]);

    res.json({
      events: events.map((e: any) => ({
        id: e._id.toString(),
        ts: e.ts,
        source: e.source,
        sessionId: e.sessionId,
        level: e.level,
        sessionUSD: e.sessionUSD,
        dailyUSD: e.dailyUSD,
        reasons: e.reasons,
        action: e.action,
        cwd: e.cwd,
        createdAt: e.createdAt,
      })),
      total,
      limit,
      skip,
    });
  } catch (e) {
    next(e);
  }
});
