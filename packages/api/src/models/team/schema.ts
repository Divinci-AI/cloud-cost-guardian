import mongoose, { Schema, Document } from "mongoose";
import crypto from "crypto";

// ─── Team Member ──────────────────────────────────────────────────────────────

export type TeamRole = "owner" | "admin" | "member" | "viewer";

export interface TeamMemberProps {
  guardianAccountId: string;
  userId: string;
  email: string;
  role: TeamRole;
  invitedBy: string;
  joinedAt: number;
}

export type TeamMemberDocument = TeamMemberProps & Document;

const teamMemberSchema = new Schema<TeamMemberDocument>({
  guardianAccountId: { type: String, required: true, index: true },
  userId: { type: String, required: true, index: true },
  email: { type: String, required: true },
  role: { type: String, required: true, enum: ["owner", "admin", "member", "viewer"], default: "member" },
  invitedBy: { type: String, required: true },
  joinedAt: { type: Number, default: () => Date.now() },
});

// A user can only be a member of one team account
teamMemberSchema.index({ userId: 1, guardianAccountId: 1 }, { unique: true });

export const TeamMemberModel = (mongoose.models?.["TeamMember"] as mongoose.Model<TeamMemberDocument>) ||
  mongoose.model<TeamMemberDocument>("TeamMember", teamMemberSchema);

// ─── Team Invitation ──────────────────────────────────────────────────────────

export type InvitationStatus = "pending" | "accepted" | "expired" | "revoked";

export interface TeamInvitationProps {
  guardianAccountId: string;
  email: string;
  role: TeamRole;
  token: string;
  invitedBy: string;
  status: InvitationStatus;
  createdAt: number;
  expiresAt: number;
  acceptedAt?: number;
}

export type TeamInvitationDocument = TeamInvitationProps & Document;

const teamInvitationSchema = new Schema<TeamInvitationDocument>({
  guardianAccountId: { type: String, required: true, index: true },
  email: { type: String, required: true },
  role: { type: String, required: true, enum: ["owner", "admin", "member", "viewer"], default: "member" },
  token: { type: String, required: true, unique: true, index: true },
  invitedBy: { type: String, required: true },
  status: { type: String, required: true, enum: ["pending", "accepted", "expired", "revoked"], default: "pending" },
  createdAt: { type: Number, default: () => Date.now() },
  expiresAt: { type: Number, required: true },
  acceptedAt: { type: Number },
});

export const TeamInvitationModel = (mongoose.models?.["TeamInvitation"] as mongoose.Model<TeamInvitationDocument>) ||
  mongoose.model<TeamInvitationDocument>("TeamInvitation", teamInvitationSchema);

/** Generate a cryptographically secure invitation token */
export function generateInviteToken(): string {
  return crypto.randomBytes(32).toString("hex");
}
