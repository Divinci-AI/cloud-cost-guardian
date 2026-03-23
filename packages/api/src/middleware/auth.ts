/**
 * Auth0 JWT Middleware
 *
 * Validates JWT tokens from Auth0 and attaches user info to requests.
 * Uses JWKS for token verification (same pattern as public-api).
 */

import type { Request, Response, NextFunction } from "express";
import { createRemoteJWKSet, jwtVerify } from "jose";

const AUTH0_DOMAIN = process.env.AUTH0_DOMAIN || "divinci-staging.us.auth0.com";
const AUTH0_AUDIENCE = process.env.AUTH0_AUDIENCE || "https://guardian-api.divinci.app";

const JWKS = createRemoteJWKSet(new URL(`https://${AUTH0_DOMAIN}/.well-known/jwks.json`));

export interface AuthenticatedRequest extends Request {
  userId?: string;
  guardianAccountId?: string;
  auth?: {
    sub: string;
    email?: string;
    permissions?: string[];
  };
}

/**
 * Require valid Auth0 JWT token.
 * Extracts userId from the `sub` claim.
 */
export async function requireAuth(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
  // Development bypass: ONLY active when GUARDIAN_DEV_AUTH_BYPASS=true AND NOT in production
  if (process.env.GUARDIAN_DEV_AUTH_BYPASS === "true" && process.env.NODE_ENV !== "production") {
    const devAccountId = req.headers["x-guardian-account-id"] as string;
    const devUserId = req.headers["x-guardian-user-id"] as string;
    if (devAccountId || devUserId) {
      req.guardianAccountId = devAccountId;
      req.userId = devUserId || "dev-user";
      return next();
    }
  }

  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith("Bearer ")) {
    res.status(401).json({ error: "Missing or invalid Authorization header" });
    return;
  }

  const token = authHeader.substring(7);

  try {
    const { payload } = await jwtVerify(token, JWKS, {
      issuer: `https://${AUTH0_DOMAIN}/`,
      audience: AUTH0_AUDIENCE,
    });

    req.userId = payload.sub;
    req.auth = {
      sub: payload.sub as string,
      email: payload.email as string | undefined,
      permissions: payload.permissions as string[] | undefined,
    };

    next();
  } catch (error: any) {
    console.error("[guardian] JWT verification failed:", error.message);
    res.status(401).json({ error: "Invalid or expired token" });
  }
}

/**
 * Resolve the GuardianAccount for the authenticated user.
 * Creates one if it doesn't exist (auto-provisioning).
 */
export async function resolveGuardianAccount(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
  if (req.guardianAccountId) {
    return next(); // Already set (dev mode)
  }

  if (!req.userId) {
    res.status(401).json({ error: "Not authenticated" });
    return;
  }

  try {
    // Lazy import to avoid circular deps
    const { GuardianAccountModel } = await import("../models/guardian-account/schema.js");

    let account = await GuardianAccountModel.findOne({ ownerUserId: req.userId });

    if (!account) {
      // Auto-create account on first authenticated request
      account = await GuardianAccountModel.create({
        ownerUserId: req.userId,
        name: req.auth?.email || `User ${req.userId.substring(0, 8)}`,
        tier: "free",
        alertChannels: [],
        settings: { checkIntervalMinutes: 360, dailyReportEnabled: false },
      });
      console.error(`[guardian] Auto-created account for ${req.userId}`);
    }

    req.guardianAccountId = account._id.toString();
    next();
  } catch (error: any) {
    console.error("[guardian] Failed to resolve Guardian account:", error.message);
    res.status(500).json({ error: "Failed to resolve account" });
  }
}
