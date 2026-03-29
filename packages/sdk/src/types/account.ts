/**
 * Current account (user profile) types
 */

import type { GuardianTier } from "./common.js";
import type { Organization } from "./orgs.js";

export interface AccountInfo {
  _id: string;
  name: string;
  tier: GuardianTier;
  ownerUserId: string;
  type?: string;
  slug?: string;
  orgs: Organization[];
  activeOrgId: string;
  teamRole: string;
  onboardingCompleted?: boolean;
  settings?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface UpdateAccountSettingsInput {
  name?: string;
  onboardingCompleted?: boolean;
  settings?: {
    timezone?: string;
    dailyReportEnabled?: boolean;
  };
}
