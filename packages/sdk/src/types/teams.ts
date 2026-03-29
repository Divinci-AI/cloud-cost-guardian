/**
 * Team types
 */

import type { TeamRole } from "./common.js";

export interface TeamMember {
  id?: string;
  userId: string;
  email: string;
  role: TeamRole;
  joinedAt?: string | number;
  isOwner: boolean;
}

export interface TeamInvitation {
  id: string;
  email: string;
  role: TeamRole;
  status: "pending" | "accepted" | "expired" | "revoked";
  createdAt?: string | number;
  expiresAt?: string | number;
}

export interface InviteInput {
  email: string;
  role?: TeamRole;
}

export interface InviteResult {
  invitation: {
    id: string;
    email: string;
    role: TeamRole;
    token: string;
    expiresAt: number;
  };
  acceptUrl: string;
}

export interface AcceptInviteInput {
  token: string;
}

export interface UpdateMemberInput {
  role: TeamRole;
}
