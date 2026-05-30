/**
 * Organization Routes
 *
 * CRUD for organizations. Users on team/enterprise tier can create
 * named orgs and invite members. Free/pro users have a personal workspace.
 */

import { Router } from "express";
import { GuardianAccountModel, generateSlug } from "../../models/guardian-account/schema.js";
import { CloudAccountModel } from "../../models/cloud-account/schema.js";
import { TeamMemberModel, TeamInvitationModel } from "../../models/team/schema.js";
import { UserProfileModel } from "../../models/user-profile/schema.js";
import { requirePermission } from "../../middleware/permissions.js";
import { logActivity } from "../../services/activity-logger.js";

export const orgsRouter = Router();

/**
 * A Mongo ObjectId is 24 hex chars. Validate `:orgId` route params before any
 * findById so a malformed id resolves to a clean 404 instead of a 500 CastError.
 */
const isValidObjectId = (id: string): boolean => /^[0-9a-fA-F]{24}$/.test(id);

/**
 * GET /orgs — List all orgs the user belongs to (owned + member of)
 */
orgsRouter.get("/", async (req: any, res, next) => {
  try {
    const userId = req.userId;

    // Orgs the user owns
    const ownedAccounts = await GuardianAccountModel.find({ ownerUserId: userId }).lean();

    // Orgs the user is a team member of
    const memberships = await TeamMemberModel.find({ userId }).lean();
    const memberOrgIds = memberships
      .map(m => m.guardianAccountId)
      .filter(id => !ownedAccounts.some(a => a._id.toString() === id));

    const memberAccounts = memberOrgIds.length > 0
      ? await GuardianAccountModel.find({ _id: { $in: memberOrgIds } }).lean()
      : [];

    // Build response
    const orgs = [
      ...ownedAccounts.map(a => ({
        id: a._id.toString(),
        name: a.name,
        slug: a.slug,
        type: a.type || "personal",
        tier: a.tier,
        role: "owner" as const,
      })),
      ...memberAccounts.map(a => {
        const membership = memberships.find(m => m.guardianAccountId === a._id.toString());
        return {
          id: a._id.toString(),
          name: a.name,
          slug: a.slug,
          type: a.type || "personal",
          tier: a.tier,
          role: membership?.role || "viewer",
        };
      }),
    ];

    // Get active org
    const profile = await UserProfileModel.findOne({ userId });
    const activeOrgId = profile?.activeOrgId || (ownedAccounts[0]?._id.toString() ?? null);

    res.json({ orgs, activeOrgId });
  } catch (e) {
    next(e);
  }
});

/**
 * POST /orgs — Create a new organization
 * Requires team/enterprise tier on the user's personal workspace.
 */
orgsRouter.post("/", async (req: any, res, next) => {
  try {
    const userId = req.userId;
    const { name } = req.body;

    if (!name || typeof name !== "string" || name.trim().length < 2) {
      return res.status(400).json({ error: "Organization name must be at least 2 characters" });
    }

    // Check the user's personal workspace tier
    const personalAccount = await GuardianAccountModel.findOne({
      ownerUserId: userId,
      $or: [{ type: "personal" }, { type: { $exists: false } }],
    });

    if (!personalAccount) {
      return res.status(400).json({ error: "No personal workspace found" });
    }

    if (personalAccount.tier !== "team" && personalAccount.tier !== "enterprise") {
      return res.status(403).json({
        error: "Creating organizations requires the Team or Enterprise plan",
        currentTier: personalAccount.tier,
        upgradeUrl: "/billing?plan=team",
      });
    }

    // Create the org
    const slug = generateSlug(name.trim());
    const org = await GuardianAccountModel.create({
      ownerUserId: userId,
      name: name.trim(),
      slug,
      type: "organization",
      tier: personalAccount.tier, // Inherit tier from personal workspace
      alertChannels: [],
      settings: { checkIntervalMinutes: 5, dailyReportEnabled: false },
    });

    logActivity({
      orgId: org._id.toString(), actorUserId: userId, actorEmail: req.auth?.email,
      action: "org.create", resourceType: "organization", resourceId: org._id.toString(),
      details: { name: name.trim(), slug }, ipAddress: req.ip,
    });

    res.status(201).json({
      id: org._id.toString(),
      name: org.name,
      slug: org.slug,
      type: org.type,
      tier: org.tier,
    });
  } catch (e) {
    next(e);
  }
});

/**
 * GET /orgs/:orgId — Get org details
 */
orgsRouter.get("/:orgId", async (req: any, res, next) => {
  try {
    if (!isValidObjectId(req.params.orgId)) return res.status(404).json({ error: "Organization not found" });
    const account = await GuardianAccountModel.findById(req.params.orgId).lean();
    if (!account) return res.status(404).json({ error: "Organization not found" });

    // Verify access: must be owner or team member
    const isOwner = account.ownerUserId === req.userId;
    const membership = isOwner ? null : await TeamMemberModel.findOne({
      userId: req.userId, guardianAccountId: req.params.orgId,
    });

    if (!isOwner && !membership) {
      return res.status(403).json({ error: "Not a member of this organization" });
    }

    const { stripeCustomerId: _s, ...safe } = account as any;
    res.json({
      ...safe,
      role: isOwner ? "owner" : membership!.role,
    });
  } catch (e) {
    next(e);
  }
});

/**
 * PATCH /orgs/:orgId — Update org name/slug (owner only)
 */
orgsRouter.patch("/:orgId", requirePermission("org:manage"), async (req: any, res, next) => {
  try {
    // Verify the target org matches the resolved org (prevents IDOR)
    if (req.params.orgId !== req.guardianAccountId) {
      return res.status(403).json({ error: "You can only manage the organization you are currently in" });
    }
    const { name, slug } = req.body;
    const updates: Record<string, any> = {};

    if (name && typeof name === "string" && name.trim().length >= 2) {
      updates.name = name.trim();
    }
    if (slug && typeof slug === "string") {
      const cleanSlug = slug.toLowerCase().replace(/[^a-z0-9-]/g, "").replace(/^-|-$/g, "");
      if (cleanSlug.length < 3) {
        return res.status(400).json({ error: "Slug must be at least 3 characters" });
      }
      // Check uniqueness
      const existing = await GuardianAccountModel.findOne({ slug: cleanSlug, _id: { $ne: req.params.orgId } });
      if (existing) {
        return res.status(409).json({ error: "This slug is already taken" });
      }
      updates.slug = cleanSlug;
    }

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ error: "No valid fields to update" });
    }

    let account;
    try {
      account = await GuardianAccountModel.findByIdAndUpdate(req.params.orgId, { $set: updates }, { new: true }).lean();
    } catch (err: any) {
      if (err.code === 11000) {
        return res.status(409).json({ error: "This slug is already taken" });
      }
      throw err;
    }
    if (!account) return res.status(404).json({ error: "Organization not found" });

    logActivity({
      orgId: req.params.orgId, actorUserId: req.userId, actorEmail: req.auth?.email,
      action: "org.update", resourceType: "organization", resourceId: req.params.orgId,
      details: updates, ipAddress: req.ip,
    });

    const { stripeCustomerId: _s, ...safe } = account as any;
    res.json(safe);
  } catch (e) {
    next(e);
  }
});

/**
 * DELETE /orgs/:orgId — Delete org (owner only, cannot delete personal workspace)
 */
orgsRouter.delete("/:orgId", requirePermission("org:delete"), async (req: any, res, next) => {
  try {
    // Verify the target org matches the resolved org (prevents IDOR)
    if (req.params.orgId !== req.guardianAccountId) {
      return res.status(403).json({ error: "You can only delete the organization you are currently in" });
    }
    const account = await GuardianAccountModel.findById(req.params.orgId);
    if (!account) return res.status(404).json({ error: "Organization not found" });

    if (account.type === "personal" || !account.type) {
      return res.status(400).json({ error: "Cannot delete your personal workspace" });
    }

    // Cascade delete all related resources
    const orgId = req.params.orgId;
    const { deleteAllCredentialsForAccount } = await import("../../models/encrypted-credential/schema.js");
    const { deleteAllApiKeysForAccount } = await import("../../models/api-key/schema.js");

    await Promise.all([
      TeamMemberModel.deleteMany({ guardianAccountId: orgId }),
      TeamInvitationModel.deleteMany({ guardianAccountId: orgId }),
      CloudAccountModel.deleteMany({ guardianAccountId: orgId }),
      deleteAllCredentialsForAccount(orgId).catch(() => {}),
      deleteAllApiKeysForAccount(orgId).catch(() => {}),
      // Clear activeOrgId for any users who had this org selected
      UserProfileModel.updateMany({ activeOrgId: orgId }, { $set: { activeOrgId: null } }),
    ]);

    // Delete the org itself
    await GuardianAccountModel.findByIdAndDelete(orgId);

    logActivity({
      orgId: req.params.orgId, actorUserId: req.userId, actorEmail: req.auth?.email,
      action: "org.delete", resourceType: "organization", resourceId: req.params.orgId,
      details: { name: account.name }, ipAddress: req.ip,
    });

    res.json({ deleted: true });
  } catch (e) {
    next(e);
  }
});

/**
 * POST /orgs/:orgId/switch — Set as active org
 */
orgsRouter.post("/:orgId/switch", async (req: any, res, next) => {
  try {
    const userId = req.userId;
    const orgId = req.params.orgId;

    if (!isValidObjectId(orgId)) return res.status(404).json({ error: "Organization not found" });

    // Verify access
    const account = await GuardianAccountModel.findById(orgId);
    if (!account) return res.status(404).json({ error: "Organization not found" });

    const isOwner = account.ownerUserId === userId;
    const membership = isOwner ? null : await TeamMemberModel.findOne({ userId, guardianAccountId: orgId });

    if (!isOwner && !membership) {
      return res.status(403).json({ error: "Not a member of this organization" });
    }

    // Update active org
    await UserProfileModel.findOneAndUpdate(
      { userId },
      { userId, activeOrgId: orgId, updatedAt: Date.now() },
      { upsert: true }
    );

    res.json({ switched: true, activeOrgId: orgId });
  } catch (e) {
    next(e);
  }
});

/**
 * POST /orgs/convert-personal — Convert personal workspace to organization
 * Requires team/enterprise tier.
 */
orgsRouter.post("/convert-personal", async (req: any, res, next) => {
  try {
    const userId = req.userId;
    const { name } = req.body;

    const personalAccount = await GuardianAccountModel.findOne({
      ownerUserId: userId,
      $or: [{ type: "personal" }, { type: { $exists: false } }],
    });

    if (!personalAccount) {
      return res.status(404).json({ error: "No personal workspace found" });
    }

    if (personalAccount.tier !== "team" && personalAccount.tier !== "enterprise") {
      return res.status(403).json({
        error: "Converting to an organization requires the Team or Enterprise plan",
        currentTier: personalAccount.tier,
      });
    }

    if (personalAccount.type === "organization") {
      return res.status(400).json({ error: "Already an organization" });
    }

    const updates: Record<string, any> = { type: "organization" };
    if (name && typeof name === "string" && name.trim().length >= 2) {
      updates.name = name.trim();
      updates.slug = generateSlug(name.trim());
    }

    let updated;
    try {
      updated = await GuardianAccountModel.findByIdAndUpdate(
        personalAccount._id,
        { $set: updates },
        { new: true }
      ).lean();
    } catch (err: any) {
      if (err.code === 11000) {
        return res.status(409).json({ error: "Generated slug already exists. Please try again." });
      }
      throw err;
    }

    logActivity({
      orgId: personalAccount._id.toString(), actorUserId: userId, actorEmail: req.auth?.email,
      action: "org.create", resourceType: "organization", resourceId: personalAccount._id.toString(),
      details: { convertedFrom: "personal", name: updates.name || personalAccount.name }, ipAddress: req.ip,
    });

    const { stripeCustomerId: _s, ...safe } = updated as any;
    res.json(safe);
  } catch (e) {
    next(e);
  }
});
