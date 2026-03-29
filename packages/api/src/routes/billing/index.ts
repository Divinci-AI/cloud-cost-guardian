/**
 * Stripe Billing Routes
 *
 * Handles subscription checkout, webhook events, and billing status.
 */

import { Router, raw } from "express";
import Stripe from "stripe";
import { GuardianAccountModel } from "../../models/guardian-account/schema.js";
import type { GuardianTier } from "../../models/guardian-account/schema.js";

const STRIPE_SECRET_KEY = process.env.STRIPE_API_SECRET_KEY || "";
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET_GUARDIAN || "";

const stripe = STRIPE_SECRET_KEY ? new Stripe(STRIPE_SECRET_KEY) : null;

// Guardian Stripe price IDs — set via env vars for production, falls back to test mode IDs
const PRICES: Record<string, { tier: GuardianTier; interval: string; priceId: string }> = {
  guardian_pro_monthly: { tier: "pro", interval: "month", priceId: process.env.STRIPE_PRICE_PRO_MONTHLY || "price_1TE2hNIzNdoxvIKmERxnntmt" },
  guardian_pro_annual: { tier: "pro", interval: "year", priceId: process.env.STRIPE_PRICE_PRO_ANNUAL || "price_1TE2hNIzNdoxvIKmfchhqNdF" },
  guardian_team_monthly: { tier: "team", interval: "month", priceId: process.env.STRIPE_PRICE_TEAM_MONTHLY || "price_1TE2hOIzNdoxvIKmSeL0KiC4" },
  guardian_team_annual: { tier: "team", interval: "year", priceId: process.env.STRIPE_PRICE_TEAM_ANNUAL || "price_1TE2hOIzNdoxvIKm9pprqge0" },
};

const TIER_LIMITS: Record<GuardianTier, { cloudAccounts: number; checkIntervalMinutes: number; alertChannels: number }> = {
  free: { cloudAccounts: 1, checkIntervalMinutes: 360, alertChannels: 1 },
  pro: { cloudAccounts: 3, checkIntervalMinutes: 5, alertChannels: 10 },
  team: { cloudAccounts: 10, checkIntervalMinutes: 5, alertChannels: 10 },
  enterprise: { cloudAccounts: 100, checkIntervalMinutes: 1, alertChannels: 50 },
};

export const billingRouter = Router();

/**
 * GET /billing/plans — List available plans with pricing
 */
billingRouter.get("/plans", (_req, res) => {
  res.json({
    plans: [
      {
        tier: "free", name: "Free", price: 0,
        features: ["1 cloud account", "6-hour check interval", "1 alert channel", "Open source kill switch"],
        limits: TIER_LIMITS.free,
      },
      {
        tier: "pro", name: "Pro", monthlyPrice: 29, annualPrice: 290,
        priceIds: { monthly: PRICES.guardian_pro_monthly.priceId, annual: PRICES.guardian_pro_annual.priceId },
        features: ["3 cloud accounts", "5-minute checks", "All alert channels", "Dashboard", "Anomaly detection", "Cost forecasting"],
        limits: TIER_LIMITS.pro,
      },
      {
        tier: "team", name: "Team", monthlyPrice: 99, annualPrice: 990,
        priceIds: { monthly: PRICES.guardian_team_monthly.priceId, annual: PRICES.guardian_team_annual.priceId },
        features: ["10 cloud accounts", "5-minute checks", "All alert channels", "Team roles", "Audit log", "API access", "Budget governance"],
        limits: TIER_LIMITS.team,
      },
      {
        tier: "enterprise", name: "Enterprise", monthlyPrice: null, annualPrice: null,
        features: ["Unlimited accounts", "1-minute checks", "SSO/SAML", "SLA", "Custom integrations", "Dedicated support"],
        limits: TIER_LIMITS.enterprise,
        contactUs: true,
      },
    ],
  });
});

/**
 * GET /billing/status — Current billing status
 */
billingRouter.get("/status", async (req, res, next) => {
  try {
    const accountId = (req as any).guardianAccountId;
    const account = await GuardianAccountModel.findById(accountId);
    if (!account) return res.status(404).json({ error: "Account not found" });

    let subscription = null;
    if (stripe && account.stripeSubscriptionId) {
      try {
        subscription = await stripe.subscriptions.retrieve(account.stripeSubscriptionId);
      } catch {
        // Subscription may have been deleted
      }
    }

    res.json({
      tier: account.tier,
      limits: TIER_LIMITS[account.tier],
      stripeCustomerId: account.stripeCustomerId,
      subscription: subscription ? {
        id: subscription.id,
        status: subscription.status,
        currentPeriodEnd: subscription.current_period_end,
        cancelAtPeriodEnd: subscription.cancel_at_period_end,
      } : null,
    });
  } catch (e) {
    next(e);
  }
});

/**
 * POST /billing/checkout — Create Stripe Checkout session
 */
billingRouter.post("/checkout", async (req, res, next) => {
  try {
    if (!stripe) return res.status(503).json({ error: "Stripe not configured" });

    const accountId = (req as any).guardianAccountId;
    const { planKey, successUrl, cancelUrl } = req.body;

    if (!planKey || typeof planKey !== "string") {
      return res.status(400).json({ error: "Missing or invalid planKey" });
    }

    const plan = PRICES[planKey];
    if (!plan) return res.status(400).json({ error: `Unknown plan: ${planKey}. Options: ${Object.keys(PRICES).join(", ")}` });

    // Validate redirect URLs if provided (must be HTTPS in production)
    for (const [name, url] of Object.entries({ successUrl, cancelUrl })) {
      if (url && typeof url === "string") {
        try {
          const parsed = new URL(url);
          if (process.env.NODE_ENV === "production" && parsed.protocol !== "https:") {
            return res.status(400).json({ error: `${name} must use HTTPS` });
          }
        } catch {
          return res.status(400).json({ error: `Invalid ${name} URL` });
        }
      }
    }

    const account = await GuardianAccountModel.findById(accountId);
    if (!account) return res.status(404).json({ error: "Account not found" });

    // Create or reuse Stripe customer
    let customerId = account.stripeCustomerId;
    if (!customerId) {
      const customer = await stripe.customers.create({
        metadata: { guardianAccountId: accountId, ownerUserId: account.ownerUserId },
      });
      customerId = customer.id;
      await GuardianAccountModel.findByIdAndUpdate(accountId, { stripeCustomerId: customerId });
    }

    const session = await stripe.checkout.sessions.create({
      customer: customerId,
      mode: "subscription",
      line_items: [{ price: plan.priceId, quantity: 1 }],
      success_url: successUrl || "https://app.kill-switch.net/billing?success=true",
      cancel_url: cancelUrl || "https://app.kill-switch.net/billing?canceled=true",
      metadata: { guardianAccountId: accountId, tier: plan.tier },
    });

    res.json({ checkoutUrl: session.url, sessionId: session.id });
  } catch (e) {
    next(e);
  }
});

/**
 * POST /billing/portal — Create Stripe Customer Portal session (manage subscription)
 */
billingRouter.post("/portal", async (req, res, next) => {
  try {
    if (!stripe) return res.status(503).json({ error: "Stripe not configured" });

    const accountId = (req as any).guardianAccountId;
    const account = await GuardianAccountModel.findById(accountId);
    if (!account?.stripeCustomerId) return res.status(400).json({ error: "No billing account" });

    let returnUrl = req.body.returnUrl || "https://app.kill-switch.net/billing";
    if (typeof returnUrl === "string" && returnUrl !== "https://app.kill-switch.net/billing") {
      try {
        const parsed = new URL(returnUrl);
        if (process.env.NODE_ENV === "production" && parsed.protocol !== "https:") {
          return res.status(400).json({ error: "returnUrl must use HTTPS" });
        }
      } catch {
        return res.status(400).json({ error: "Invalid returnUrl" });
      }
    }

    const session = await stripe.billingPortal.sessions.create({
      customer: account.stripeCustomerId,
      return_url: returnUrl,
    });

    res.json({ portalUrl: session.url });
  } catch (e) {
    next(e);
  }
});

/**
 * POST /billing/webhook — Stripe webhook handler
 * Handles subscription lifecycle events.
 */
billingRouter.post("/webhook", raw({ type: "application/json" }), async (req, res) => {
  if (!stripe) return res.status(503).send("Stripe not configured");

  let event: Stripe.Event;

  try {
    if (!STRIPE_WEBHOOK_SECRET) {
      return res.status(503).send("Webhook secret not configured — cannot verify signatures");
    }
    event = stripe.webhooks.constructEvent(req.body, req.headers["stripe-signature"] as string, STRIPE_WEBHOOK_SECRET);
  } catch (err: any) {
    console.error("[guardian] Webhook signature verification failed:", err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  try {
    switch (event.type) {
      case "checkout.session.completed": {
        const session = event.data.object as Stripe.Checkout.Session;
        const accountId = session.metadata?.guardianAccountId;
        const tier = (session.metadata?.tier || "pro") as GuardianTier;

        if (accountId) {
          await GuardianAccountModel.findByIdAndUpdate(accountId, {
            tier,
            stripeCustomerId: session.customer as string,
            stripeSubscriptionId: session.subscription as string,
            "settings.checkIntervalMinutes": TIER_LIMITS[tier].checkIntervalMinutes,
          });
          console.error(`[guardian] Account ${accountId} upgraded to ${tier}`);
        }
        break;
      }

      case "customer.subscription.updated": {
        const subscription = event.data.object as Stripe.Subscription;
        const account = await GuardianAccountModel.findOne({ stripeSubscriptionId: subscription.id });
        if (account && subscription.status === "active") {
          const priceId = subscription.items.data[0]?.price?.id;
          const plan = Object.values(PRICES).find(p => p.priceId === priceId);
          if (plan) {
            account.tier = plan.tier;
            account.settings.checkIntervalMinutes = TIER_LIMITS[plan.tier].checkIntervalMinutes;
            await account.save();
            console.error(`[guardian] Subscription updated: ${account._id} -> ${plan.tier}`);
          }
        }
        break;
      }

      case "customer.subscription.deleted": {
        const subscription = event.data.object as Stripe.Subscription;
        const account = await GuardianAccountModel.findOne({ stripeSubscriptionId: subscription.id });
        if (account) {
          account.tier = "free";
          account.stripeSubscriptionId = undefined;
          account.settings.checkIntervalMinutes = TIER_LIMITS.free.checkIntervalMinutes;
          await account.save();
          console.error(`[guardian] Subscription canceled: ${account._id} -> free`);
        }
        break;
      }
    }
  } catch (err: any) {
    console.error("[guardian] Webhook handler error:", err.message);
  }

  res.json({ received: true });
});

/**
 * Middleware: Enforce tier limits
 */
export function enforceTierLimits(resource: "cloudAccounts" | "alertChannels") {
  return async (req: any, res: any, next: any) => {
    try {
      const account = await GuardianAccountModel.findById(req.guardianAccountId);
      if (!account) return res.status(404).json({ error: "Account not found" });

      const limits = TIER_LIMITS[account.tier];

      if (resource === "cloudAccounts" && req.method === "POST") {
        const { CloudAccountModel } = await import("../../models/cloud-account/schema.js");
        const count = await CloudAccountModel.countDocuments({ guardianAccountId: account._id });
        if (count >= limits.cloudAccounts) {
          return res.status(403).json({
            error: `${account.tier} plan allows ${limits.cloudAccounts} cloud account(s). Upgrade to add more.`,
            currentTier: account.tier,
            limit: limits.cloudAccounts,
            current: count,
          });
        }
      }

      next();
    } catch (e) {
      next(e);
    }
  };
}

export { TIER_LIMITS };
