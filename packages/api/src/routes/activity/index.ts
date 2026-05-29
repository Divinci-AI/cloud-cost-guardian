/**
 * Activity Log Routes
 *
 * Query the audit trail of security-relevant and mutation operations.
 * Restricted to owner and admin roles.
 */

import { Router } from "express";
import { requirePermission } from "../../middleware/permissions.js";
import { requireTier } from "../../middleware/tier.js";
import { queryActivityLog } from "../../services/activity-logger.js";

export const activityRouter = Router();

/**
 * GET /activity — Query activity log with pagination and filters
 *
 * Query params:
 *   page (default 1), limit (default 50, max 100),
 *   action, resourceType, resourceId, actorUserId,
 *   from (ISO date), to (ISO date)
 */
activityRouter.get("/", requireTier("team", "enterprise"), requirePermission("activity:read"), async (req: any, res, next) => {
  try {
    const result = await queryActivityLog(req.guardianAccountId, {
      page: parseInt(req.query.page as string) || undefined,
      limit: parseInt(req.query.limit as string) || undefined,
      action: req.query.action as string,
      resourceType: req.query.resourceType as string,
      resourceId: req.query.resourceId as string,
      actorUserId: req.query.actorUserId as string,
      from: req.query.from as string,
      to: req.query.to as string,
    });

    res.json(result);
  } catch (e) {
    next(e);
  }
});
