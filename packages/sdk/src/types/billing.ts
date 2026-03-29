/**
 * Billing types
 */

import type { GuardianTier } from "./common.js";

export interface TierLimits {
  cloudAccounts: number;
  checkIntervalMinutes: number;
  alertChannels: number;
}

export interface Plan {
  tier: GuardianTier;
  name: string;
  price?: number;
  monthlyPrice?: number | null;
  annualPrice?: number | null;
  priceIds?: { monthly: string; annual: string };
  features: string[];
  limits: TierLimits;
  contactUs?: boolean;
}

export interface BillingStatus {
  tier: GuardianTier;
  limits: TierLimits;
  stripeCustomerId?: string;
  subscription: {
    id: string;
    status: string;
    currentPeriodEnd: number;
    cancelAtPeriodEnd: boolean;
  } | null;
}

export interface CheckoutInput {
  planKey: string;
  successUrl?: string;
  cancelUrl?: string;
}

export interface CheckoutResult {
  checkoutUrl: string;
  sessionId: string;
}

export interface PortalInput {
  returnUrl?: string;
}

export interface PortalResult {
  portalUrl: string;
}
