/**
 * Team Routes
 *
 * Manage team members and invitations.
 * Requires team or enterprise tier.
 */

import { Router } from "express";
import { GuardianAccountModel } from "../../models/guardian-account/schema.js";
import { TeamMemberModel, TeamInvitationModel, generateInviteToken } from "../../models/team/schema.js";
import type { TeamRole } from "../../models/team/schema.js";

export const teamRouter = Router();

/** Tier check middleware — only team/enterprise can use team features */
async function requireTeamTier(req: any, res: any, next: any) {
  const account = await GuardianAccountModel.findById(req.guardianAccountId);
  if (!account) return res.status(404).json({ error: "Account not found" });
  if (account.tier !== "team" && account.tier !== "enterprise") {
    return res.status(403).json({
      error: "Team features require the Team or Enterprise plan",
      currentTier: account.tier,
      upgradeUrl: "/billing?plan=team",
    });
  }
  (req as any).guardianAccount = account;
  next();
}

/** Role check — only owner/admin can manage team */
function requireRole(...allowed: TeamRole[]) {
  return async (req: any, res: any, next: any) => {
    const teamRole = req.teamRole;
    // Account owner always has full access
    const account = req.guardianAccount || await GuardianAccountModel.findById(req.guardianAccountId);
    if (account?.ownerUserId === req.userId) return next();
    if (!teamRole || !allowed.includes(teamRole)) {
      return res.status(403).json({ error: "Insufficient permissions" });
    }
    next();
  };
}

/**
 * GET /team/members — List team members and pending invitations
 */
teamRouter.get("/members", requireTeamTier, async (req: any, res, next) => {
  try {
    const accountId = req.guardianAccountId;
    const account = req.guardianAccount;

    const members = await TeamMemberModel.find({ guardianAccountId: accountId }).lean();
    const invitations = await TeamInvitationModel.find({
      guardianAccountId: accountId,
      status: "pending",
      expiresAt: { $gt: Date.now() },
    }).lean();

    // Include the owner as first member
    const ownerEntry = {
      userId: account.ownerUserId,
      email: account.name,
      role: "owner" as TeamRole,
      joinedAt: account.createdAt,
      isOwner: true,
    };

    res.json({
      members: [ownerEntry, ...members.map(m => ({
        id: m._id,
        userId: m.userId,
        email: m.email,
        role: m.role,
        joinedAt: m.joinedAt,
        isOwner: false,
      }))],
      invitations: invitations.map(inv => ({
        id: inv._id,
        email: inv.email,
        role: inv.role,
        status: inv.status,
        createdAt: inv.createdAt,
        expiresAt: inv.expiresAt,
      })),
    });
  } catch (e) { next(e); }
});

/**
 * POST /team/invite — Send a team invitation
 */
teamRouter.post("/invite", requireTeamTier, requireRole("owner", "admin"), async (req: any, res, next) => {
  try {
    const { email, role = "member" } = req.body;
    if (!email) return res.status(400).json({ error: "Email is required" });
    if (typeof email !== "string" || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ error: "Invalid email format" });
    }

    const validRoles: TeamRole[] = ["admin", "member", "viewer"];
    if (!validRoles.includes(role)) {
      return res.status(400).json({ error: `Invalid role. Must be one of: ${validRoles.join(", ")}` });
    }

    const accountId = req.guardianAccountId;

    // Check for existing active member with this email
    const existingMember = await TeamMemberModel.findOne({ guardianAccountId: accountId, email });
    if (existingMember) {
      return res.status(409).json({ error: "This user is already a team member" });
    }

    // Check for existing pending invitation
    const existingInvite = await TeamInvitationModel.findOne({
      guardianAccountId: accountId,
      email,
      status: "pending",
      expiresAt: { $gt: Date.now() },
    });
    if (existingInvite) {
      return res.status(409).json({ error: "An invitation is already pending for this email" });
    }

    // Check team member limit based on tier
    const account = req.guardianAccount;
    const currentMemberCount = await TeamMemberModel.countDocuments({ guardianAccountId: accountId });
    const limits: Record<string, number> = { team: 10, enterprise: 100 };
    const maxMembers = limits[account.tier] || 10;
    if (currentMemberCount >= maxMembers) {
      return res.status(403).json({
        error: `Team member limit reached (${maxMembers} for ${account.tier} tier)`,
        limit: maxMembers,
      });
    }

    const token = generateInviteToken();
    const invitation = await TeamInvitationModel.create({
      guardianAccountId: accountId,
      email,
      role,
      token,
      invitedBy: req.userId,
      status: "pending",
      expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000, // 7 days
    });

    res.status(201).json({
      invitation: {
        id: invitation._id,
        email: invitation.email,
        role: invitation.role,
        token: invitation.token,
        expiresAt: invitation.expiresAt,
      },
      // The frontend can construct the invite link
      acceptUrl: `/team/invite/accept?token=${token}`,
    });
  } catch (e) { next(e); }
});

/**
 * POST /team/invite/accept — Accept a team invitation (requires auth, validates token)
 */
teamRouter.post("/invite/accept", async (req: any, res, next) => {
  try {
    const { token } = req.body;
    if (!token) return res.status(400).json({ error: "Invitation token is required" });

    const invitation = await TeamInvitationModel.findOne({ token, status: "pending" });
    if (!invitation) {
      return res.status(404).json({ error: "Invalid or expired invitation" });
    }

    if (invitation.expiresAt < Date.now()) {
      await TeamInvitationModel.findByIdAndUpdate(invitation._id, { status: "expired" });
      return res.status(410).json({ error: "This invitation has expired" });
    }

    // Check if user is already a member
    const existing = await TeamMemberModel.findOne({
      guardianAccountId: invitation.guardianAccountId,
      userId: req.userId,
    });
    if (existing) {
      return res.status(409).json({ error: "You are already a member of this team" });
    }

    // Create team membership
    const member = await TeamMemberModel.create({
      guardianAccountId: invitation.guardianAccountId,
      userId: req.userId,
      email: invitation.email,
      role: invitation.role,
      invitedBy: invitation.invitedBy,
    });

    // Mark invitation as accepted
    await TeamInvitationModel.findByIdAndUpdate(invitation._id, {
      status: "accepted",
      acceptedAt: Date.now(),
    });

    res.json({
      joined: true,
      member: {
        id: member._id,
        email: member.email,
        role: member.role,
        guardianAccountId: member.guardianAccountId,
      },
    });
  } catch (e) { next(e); }
});

/**
 * PATCH /team/members/:memberId — Update a team member's role
 */
teamRouter.patch("/members/:memberId", requireTeamTier, requireRole("owner", "admin"), async (req: any, res, next) => {
  try {
    const { role } = req.body;
    const validRoles: TeamRole[] = ["admin", "member", "viewer"];
    if (!role || !validRoles.includes(role)) {
      return res.status(400).json({ error: `Invalid role. Must be one of: ${validRoles.join(", ")}` });
    }

    const member = await TeamMemberModel.findOneAndUpdate(
      { _id: req.params.memberId, guardianAccountId: req.guardianAccountId },
      { role },
      { new: true },
    );

    if (!member) return res.status(404).json({ error: "Team member not found" });

    res.json({
      updated: true,
      member: { id: member._id, email: member.email, role: member.role },
    });
  } catch (e) { next(e); }
});

/**
 * DELETE /team/members/:memberId — Remove a team member
 */
teamRouter.delete("/members/:memberId", requireTeamTier, requireRole("owner", "admin"), async (req: any, res, next) => {
  try {
    const member = await TeamMemberModel.findOneAndDelete({
      _id: req.params.memberId,
      guardianAccountId: req.guardianAccountId,
    });

    if (!member) return res.status(404).json({ error: "Team member not found" });

    res.json({ removed: true, email: member.email });
  } catch (e) { next(e); }
});

/**
 * DELETE /team/invitations/:invitationId — Revoke a pending invitation
 */
teamRouter.delete("/invitations/:invitationId", requireTeamTier, requireRole("owner", "admin"), async (req: any, res, next) => {
  try {
    const invitation = await TeamInvitationModel.findOneAndUpdate(
      { _id: req.params.invitationId, guardianAccountId: req.guardianAccountId, status: "pending" },
      { status: "revoked" },
      { new: true },
    );

    if (!invitation) return res.status(404).json({ error: "Pending invitation not found" });

    res.json({ revoked: true, email: invitation.email });
  } catch (e) { next(e); }
});
