/**
 * Organization types
 */

import type { GuardianTier, TeamRole } from "./common.js";

export interface Organization {
  id: string;
  name: string;
  slug?: string;
  type: "personal" | "organization";
  tier: GuardianTier;
  role: TeamRole;
}

export interface CreateOrgInput {
  name: string;
}

export interface UpdateOrgInput {
  name?: string;
  slug?: string;
}

export interface OrgDetail extends Record<string, unknown> {
  _id: string;
  name: string;
  slug?: string;
  type: string;
  tier: GuardianTier;
  role: TeamRole;
}
