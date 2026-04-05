/**
 * Clerk JWT Middleware
 *
 * Validates JWT tokens from Clerk and attaches user info to requests.
 * Uses JWKS for token verification.
 */

import type { Request, Response, NextFunction } from "express";
import { createRemoteJWKSet, jwtVerify } from "jose";

const CLERK_ISSUER = process.env.CLERK_ISSUER;
if (!CLERK_ISSUER) {
  throw new Error("CLERK_ISSUER environment variable is required");
}

// Allowed authorized-party origins — tokens whose azp isn't in this list are rejected.
// Clerk sets azp to the frontend origin that requested the token.
const CLERK_ALLOWED_AZP = (process.env.CLERK_ALLOWED_AZP || "https://app.kill-switch.net")
  .split(",")
  .map(s => s.trim())
  .filter(Boolean);

const JWKS = createRemoteJWKSet(new URL(`${CLERK_ISSUER}/.well-known/jwks.json`));

export interface AuthenticatedRequest extends Request {
  userId?: string;
  guardianAccountId?: string;
  orgType?: "personal" | "organization";
  teamRole?: "owner" | "admin" | "member" | "viewer";
  auth?: {
    sub: string;
    email?: string;
    permissions?: string[];
  };
}

/**
 * Require valid Clerk JWT token.
 * Extracts userId from the `sub` claim.
 */
export async function requireAuth(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
  // Development bypass: ONLY active in test environment with explicit opt-in
  // NEVER active in production — guarded by both NODE_ENV and ENVIRONMENT checks
  if (
    process.env.GUARDIAN_DEV_AUTH_BYPASS === "true" &&
    process.env.NODE_ENV === "test" &&
    process.env.ENVIRONMENT === "local"
  ) {
    const devAccountId = req.headers["x-guardian-account-id"] as string;
    const devUserId = req.headers["x-guardian-user-id"] as string;
    if (devAccountId || devUserId) {
      req.guardianAccountId = devAccountId;
      req.userId = devUserId || "dev-user";
      req.teamRole = (req.headers["x-guardian-role"] as any) || "owner";
      req.orgType = "personal";
      return next();
    }
  }

  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith("Bearer ")) {
    res.status(401).json({ error: "Missing or invalid Authorization header" });
    return;
  }

  const token = authHeader.substring(7);

  // Personal API key path (ks_ prefix)
  if (token.startsWith("ks_")) {
    try {
      const { validateApiKey } = await import("../models/api-key/schema.js");
      const result = await validateApiKey(token);
      if (!result) {
        res.status(401).json({ error: "Invalid API key" });
        return;
      }
      req.userId = result.userId;
      req.guardianAccountId = result.guardianAccountId;
      return next();
    } catch (error: any) {
      console.error("[guardian] API key validation failed:", error.message);
      res.status(401).json({ error: "API key validation failed" });
      return;
    }
  }

  // Clerk JWT path
  try {
    const { payload } = await jwtVerify(token, JWKS, {
      issuer: CLERK_ISSUER,
    });

    // Validate azp (authorized party) — Clerk sets this to the requesting frontend origin.
    // This prevents tokens issued for other apps on the same Clerk instance from being accepted.
    const azp = (payload as any).azp as string | undefined;
    if (azp && !CLERK_ALLOWED_AZP.includes(azp)) {
      res.status(401).json({ error: "Token not authorized for this service" });
      return;
    }

    req.userId = payload.sub;
    req.auth = {
      sub: payload.sub as string,
      email: (payload as any).email as string | undefined,
      permissions: (payload as any).permissions as string[] | undefined,
    };

    next();
  } catch (error: any) {
    console.error("[guardian] JWT verification failed:", error.message);
    res.status(401).json({ error: "Invalid or expired token" });
  }
}

/**
 * Resolve the organization (GuardianAccount) for the authenticated user.
 *
 * Resolution order:
 * 1. X-Org-Id header (explicit org selection from frontend)
 * 2. UserProfile.activeOrgId (last-used org)
 * 3. Personal workspace fallback (ownerUserId match)
 * 4. Team membership fallback
 * 5. Auto-create personal workspace
 *
 * Sets req.guardianAccountId, req.teamRole, and req.orgType.
 */
export async function resolveOrg(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
  if (req.guardianAccountId && req.teamRole) {
    return next(); // Already fully resolved (dev mode)
  }

  // API key auth sets guardianAccountId but not teamRole — resolve role
  if (req.guardianAccountId && !req.teamRole && req.userId) {
    try {
      const { GuardianAccountModel } = await import("../models/guardian-account/schema.js");
      const { TeamMemberModel } = await import("../models/team/schema.js");
      const account = await GuardianAccountModel.findById(req.guardianAccountId);
      if (account?.ownerUserId === req.userId) {
        req.teamRole = "owner";
        req.orgType = (account.type as any) || "personal";
      } else {
        const membership = await TeamMemberModel.findOne({ userId: req.userId, guardianAccountId: req.guardianAccountId });
        req.teamRole = membership?.role || "viewer";
        req.orgType = (account?.type as any) || "personal";
      }
      return next();
    } catch (error: any) {
      console.error("[guardian] Failed to resolve role for API key:", error.message);
      res.status(500).json({ error: "Failed to resolve account" });
      return;
    }
  }

  if (!req.userId) {
    res.status(401).json({ error: "Not authenticated" });
    return;
  }

  try {
    const { GuardianAccountModel } = await import("../models/guardian-account/schema.js");
    const { TeamMemberModel } = await import("../models/team/schema.js");
    const { UserProfileModel } = await import("../models/user-profile/schema.js");

    // 1. Explicit org selection via header
    const orgIdHeader = req.headers["x-org-id"] as string | undefined;
    if (orgIdHeader) {
      const resolved = await resolveOrgById(orgIdHeader, req.userId, GuardianAccountModel, TeamMemberModel);
      if (resolved) {
        req.guardianAccountId = resolved.accountId;
        req.teamRole = resolved.role;
        req.orgType = resolved.orgType;
        return next();
      }
      // Header specified an org the user doesn't have access to — reject
      res.status(403).json({ error: "You don't have access to this organization" });
      return;
    }

    // 2. UserProfile.activeOrgId
    const profile = await UserProfileModel.findOne({ userId: req.userId });
    if (profile?.activeOrgId) {
      const resolved = await resolveOrgById(profile.activeOrgId, req.userId, GuardianAccountModel, TeamMemberModel);
      if (resolved) {
        req.guardianAccountId = resolved.accountId;
        req.teamRole = resolved.role;
        req.orgType = resolved.orgType;
        return next();
      }
    }

    // 3. Fall back to personal workspace
    let account = await GuardianAccountModel.findOne({
      ownerUserId: req.userId,
      $or: [{ type: "personal" }, { type: { $exists: false } }],
    });

    if (account) {
      req.guardianAccountId = account._id.toString();
      req.teamRole = "owner";
      req.orgType = (account.type as any) || "personal";
      return next();
    }

    // 4. Check team memberships
    const membership = await TeamMemberModel.findOne({ userId: req.userId });
    if (membership) {
      const memberAccount = await GuardianAccountModel.findById(membership.guardianAccountId);
      req.guardianAccountId = membership.guardianAccountId;
      req.teamRole = membership.role;
      req.orgType = (memberAccount?.type as any) || "personal";
      return next();
    }

    // 5. Auto-create personal workspace (use findOneAndUpdate+upsert to avoid race duplicates)
    const { generateSlug } = await import("../models/guardian-account/schema.js");
    const autoName = req.auth?.email || `User ${req.userId.substring(0, 8)}`;
    account = await GuardianAccountModel.findOneAndUpdate(
      { ownerUserId: req.userId, type: "personal" },
      {
        $setOnInsert: {
          ownerUserId: req.userId,
          name: autoName,
          slug: generateSlug(autoName),
          type: "personal",
          tier: "free",
          alertChannels: [],
          settings: { checkIntervalMinutes: 360, dailyReportEnabled: false },
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
      },
      { upsert: true, new: true }
    );
    console.error(`[guardian] Resolved personal workspace for ${req.userId}`);

    // Also create a UserProfile
    await UserProfileModel.findOneAndUpdate(
      { userId: req.userId },
      {
        userId: req.userId,
        email: req.auth?.email || "",
        name: req.auth?.email || "",
        activeOrgId: account!._id.toString(),
      },
      { upsert: true }
    );

    req.guardianAccountId = account!._id.toString();
    req.teamRole = "owner";
    req.orgType = "personal";
    next();
  } catch (error: any) {
    console.error("[guardian] Failed to resolve org:", error.message);
    res.status(500).json({ error: "Failed to resolve account" });
  }
}

/** Helper: resolve an org by ID and determine the user's role in it */
async function resolveOrgById(
  orgId: string,
  userId: string,
  GuardianAccountModel: any,
  TeamMemberModel: any
): Promise<{ accountId: string; role: "owner" | "admin" | "member" | "viewer"; orgType: "personal" | "organization" } | null> {
  const account = await GuardianAccountModel.findById(orgId);
  if (!account) return null;

  // Owner check
  if (account.ownerUserId === userId) {
    return { accountId: account._id.toString(), role: "owner", orgType: account.type || "personal" };
  }

  // Team member check
  const membership = await TeamMemberModel.findOne({ userId, guardianAccountId: orgId });
  if (membership) {
    return { accountId: account._id.toString(), role: membership.role, orgType: account.type || "personal" };
  }

  return null;
}

/** @deprecated Use resolveOrg instead. Kept for backwards compatibility. */
export const resolveGuardianAccount = resolveOrg;
