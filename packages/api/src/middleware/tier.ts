/**
 * Tier-gating middleware
 *
 * Enforces that the resolved Guardian account is on one of the allowed tiers.
 * Tier is read from the trusted DB record (set only by verified Stripe webhooks),
 * so this gates direct API / `ks_live_` API-key callers identically to the UI.
 */

import type { Request, Response, NextFunction } from "express";
import { GuardianAccountModel, type GuardianTier } from "../models/guardian-account/schema.js";

export function requireTier(...allowed: GuardianTier[]) {
  return async (req: any, res: Response, next: NextFunction) => {
    try {
      const account = await GuardianAccountModel.findById(req.guardianAccountId);
      if (!account) return res.status(404).json({ error: "Account not found" });
      if (!allowed.includes(account.tier)) {
        const label = allowed.map(t => t[0].toUpperCase() + t.slice(1)).join(" or ");
        return res.status(403).json({
          error: `This feature requires the ${label} plan`,
          currentTier: account.tier,
          upgradeUrl: `/billing?plan=${allowed[0]}`,
        });
      }
      (req as any).guardianAccount = account;
      next();
    } catch (e) {
      next(e);
    }
  };
}
