/**
 * Stripe Billing Routes
 *
 * Handles subscription checkout, webhook events, and billing status.
 */

import { Router, raw } from "express";
import Stripe from "stripe";
import { GuardianAccountModel } from "../../models/guardian-account/schema.js";
import { ProcessedStripeEventModel } from "../../models/stripe-event/schema.js";
import { requirePermission } from "../../middleware/permissions.js";
import type { GuardianTier } from "../../models/guardian-account/schema.js";

const STRIPE_SECRET_KEY = process.env.STRIPE_API_SECRET_KEY || "";
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET_GUARDIAN || "";

// Pin the API version so field locations (e.g. current_period_end) and behavior
// don't shift on `npm update`. Matches the version pinned in app.ts.
const STRIPE_API_VERSION = "2025-02-24.acacia";
const stripe = STRIPE_SECRET_KEY ? new Stripe(STRIPE_SECRET_KEY, { apiVersion: STRIPE_API_VERSION as any }) : null;

// Guardian Stripe price IDs — set via env vars for production, falls back to test mode IDs
const PRICES: Record<string, { tier: GuardianTier; interval: string; priceId: string }> = {
  guardian_pro_monthly: { tier: "pro", interval: "month", priceId: process.env.STRIPE_PRICE_PRO_MONTHLY || "price_1TE2hNIzNdoxvIKmERxnntmt" },
  guardian_pro_annual: { tier: "pro", interval: "year", priceId: process.env.STRIPE_PRICE_PRO_ANNUAL || "price_1TE2hNIzNdoxvIKmfchhqNdF" },
  guardian_team_monthly: { tier: "team", interval: "month", priceId: process.env.STRIPE_PRICE_TEAM_MONTHLY || "price_1TE2hOIzNdoxvIKmSeL0KiC4" },
  guardian_team_annual: { tier: "team", interval: "year", priceId: process.env.STRIPE_PRICE_TEAM_ANNUAL || "price_1TE2hOIzNdoxvIKm9pprqge0" },
};

// Tiers reachable via self-serve Stripe checkout. These MUST be backed by a live
// subscription; if they aren't, billing/status self-heals them to free. Enterprise is
// sales-led (set manually, no self-serve sub) and is intentionally excluded.
const SELF_SERVE_PAID_TIERS = new Set<GuardianTier>(Object.values(PRICES).map((p) => p.tier));

// Fail fast: in production with Stripe enabled, never silently fall back to the
// baked-in test-mode price IDs. A misconfigured deploy must crash, not charge wrong prices.
if (process.env.NODE_ENV === "production" && STRIPE_SECRET_KEY) {
  const missing = (["STRIPE_PRICE_PRO_MONTHLY", "STRIPE_PRICE_PRO_ANNUAL", "STRIPE_PRICE_TEAM_MONTHLY", "STRIPE_PRICE_TEAM_ANNUAL"] as const)
    .filter((k) => !process.env[k]);
  if (missing.length) {
    throw new Error(`[guardian] Stripe is enabled in production but price env vars are missing: ${missing.join(", ")}`);
  }
}

const TIER_LIMITS: Record<GuardianTier, { cloudAccounts: number; checkIntervalMinutes: number; alertChannels: number; teamMembers: number }> = {
  free: { cloudAccounts: 1, checkIntervalMinutes: 360, alertChannels: 1, teamMembers: 0 },
  pro: { cloudAccounts: 3, checkIntervalMinutes: 5, alertChannels: 10, teamMembers: 0 },
  team: { cloudAccounts: 10, checkIntervalMinutes: 5, alertChannels: 10, teamMembers: 10 },
  enterprise: { cloudAccounts: 100, checkIntervalMinutes: 1, alertChannels: 50, teamMembers: 100 },
};

// Ordinal ranking so we can ask "does the owner's tier cover the org's tier?".
const TIER_RANK: Record<GuardianTier, number> = { free: 0, pro: 1, team: 2, enterprise: 3 };

/**
 * Map a Stripe subscription status to the action we take on the account.
 * Pure + exported so the payment-lifecycle policy is unit-testable.
 *   apply     → healthy: (re)apply the plan's tier + limits
 *   downgrade → dead: drop to free
 *   grace     → transient (e.g. past_due): keep current tier, just record status
 */
export type SubscriptionAction = "apply" | "downgrade" | "grace";
export function classifySubscriptionStatus(status: string): SubscriptionAction {
  if (status === "active" || status === "trialing") return "apply";
  if (status === "unpaid" || status === "canceled" || status === "incomplete_expired") return "downgrade";
  return "grace"; // past_due, incomplete, paused, …
}

export const billingRouter = Router();

/**
 * GET /billing/plans — List available plans with pricing
 */
billingRouter.get("/plans", (_req, res) => {
  res.json({
    plans: [
      {
        tier: "free", name: "Free", monthlyPrice: 0, annualPrice: 0,
        features: ["1 cloud account", "6-hour check interval", "1 alert channel", "Self-host the open-source version", "Community support"],
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
billingRouter.get("/status", requirePermission("billing:read"), async (req, res, next) => {
  try {
    const accountId = (req as any).guardianAccountId;
    const account = await GuardianAccountModel.findById(accountId);
    if (!account) return res.status(404).json({ error: "Account not found" });

    let subscription: Stripe.Subscription | null = null;
    let retrieveFailed = false;
    if (stripe && account.stripeSubscriptionId) {
      try {
        subscription = await stripe.subscriptions.retrieve(account.stripeSubscriptionId);
      } catch {
        // Subscription may have been deleted out-of-band — or this could be a transient
        // Stripe error. We can't tell the two apart, so flag it and do NOT self-heal below
        // (a transient blip must never wrongly strip someone's paid tier).
        retrieveFailed = true;
      }
    }

    // Self-heal stale paid tiers. A self-serve paid tier (pro/team) is only legitimate
    // when a live Stripe subscription backs it. If Stripe is configured and there is no
    // active/grace subscription (sub ID missing, or the sub is canceled/unpaid/expired),
    // the tier got stuck elevated — e.g. a subscription deleted in the Stripe dashboard
    // whose webhook never reached us. Reconcile to free so we never grant paid features
    // (or under-bill) on stale state. Skipped on a transient retrieve error and for
    // enterprise (sales-led, no self-serve sub).
    const hasLiveSub = !!(subscription && classifySubscriptionStatus(subscription.status) !== "downgrade");

    // Decide whether this account's paid tier is still backed by a live subscription.
    // Personal accounts are backed by their OWN sub. Organization accounts carry NO sub of
    // their own — their tier is inherited from the owner's personal subscription at creation
    // (see routes/orgs). So we must follow the OWNER's sub: if we naively used the org's own
    // (always-absent) sub we'd wrongly strip a legitimately-paid org to free; if we simply
    // skipped orgs we'd never downgrade an org after the owner cancels (fail-open: free
    // paid-tier usage). Both are wrong — derive the org's backing from the owner.
    let tierIsBacked: boolean;
    let backingTransientError: boolean;
    if (account.type === "personal") {
      tierIsBacked = hasLiveSub;
      backingTransientError = retrieveFailed;
    } else {
      backingTransientError = false;
      const owner = await GuardianAccountModel.findOne({ ownerUserId: account.ownerUserId, type: "personal" });
      if (!stripe || !owner?.stripeSubscriptionId) {
        // No Stripe → can't validate, so don't strip (the self-heal's `stripe &&` guard also
        // skips it). Owner has no subscription → the org's paid tier is stale.
        tierIsBacked = !stripe;
      } else {
        try {
          const ownerSub = await stripe.subscriptions.retrieve(owner.stripeSubscriptionId);
          const ownerLive = classifySubscriptionStatus(ownerSub.status) !== "downgrade";
          // Derive the owner's effective tier from the live sub's price (don't trust stored tier).
          const ownerPriceId = ownerSub.items?.data?.[0]?.price?.id;
          const ownerTier = Object.values(PRICES).find((p) => p.priceId === ownerPriceId)?.tier ?? owner.tier;
          // The org stays provisioned only while the owner has a live sub whose tier covers it.
          tierIsBacked = ownerLive && TIER_RANK[ownerTier] >= TIER_RANK[account.tier];
        } catch {
          // Transient Stripe error retrieving the owner's sub → never strip on uncertainty.
          tierIsBacked = true;
          backingTransientError = true;
        }
      }
    }

    // Self-heal a stale elevated tier: a self-serve paid tier (pro/team) is only legitimate
    // while a live subscription backs it (the account's own, or the owner's for an org). When
    // it doesn't, reconcile to free so we never grant paid features (or under-bill) on stale
    // state. Skipped on a transient retrieve error and for enterprise (sales-led, no self-serve sub).
    if (stripe && SELF_SERVE_PAID_TIERS.has(account.tier) && !tierIsBacked && !backingTransientError) {
      const staleTier = account.tier;
      account.tier = "free";
      account.subscriptionStatus = subscription ? subscription.status : "canceled";
      if (!subscription) account.stripeSubscriptionId = undefined;
      account.settings.checkIntervalMinutes = TIER_LIMITS.free.checkIntervalMinutes;
      await account.save();
      await reconcileTierDowngrade(String(account._id), "free");
      console.log(`[guardian] Self-heal: ${account.type} account ${account._id} had stale paid tier "${staleTier}" with no live backing subscription -> free`);
      subscription = null;
    }

    res.json({
      tier: account.tier,
      limits: TIER_LIMITS[account.tier],
      subscription: subscription ? {
        id: subscription.id,
        status: subscription.status,
        // current_period_end moved onto subscription items in recent API versions;
        // read top-level first, then fall back to the first item so the UI gets a real value.
        currentPeriodEnd: (subscription as any).current_period_end
          ?? (subscription.items?.data?.[0] as any)?.current_period_end,
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
billingRouter.post("/checkout", requirePermission("billing:manage"), async (req, res, next) => {
  try {
    if (!stripe) return res.status(503).json({ error: "Stripe not configured" });

    const accountId = (req as any).guardianAccountId;
    const { planKey, successUrl, cancelUrl } = req.body;

    if (!planKey || typeof planKey !== "string") {
      return res.status(400).json({ error: "Missing or invalid planKey" });
    }

    const plan = PRICES[planKey];
    if (!plan) return res.status(400).json({ error: `Unknown plan: ${planKey}. Options: ${Object.keys(PRICES).join(", ")}` });

    // Validate redirect URLs — restrict to allowed domains to prevent open redirect
    const ALLOWED_REDIRECT_HOSTS = ["app.kill-switch.net", "kill-switch.net", "localhost", "127.0.0.1"];
    for (const [name, url] of Object.entries({ successUrl, cancelUrl })) {
      if (url && typeof url === "string") {
        try {
          const parsed = new URL(url);
          if (process.env.NODE_ENV === "production" && parsed.protocol !== "https:") {
            return res.status(400).json({ error: `${name} must use HTTPS` });
          }
          if (!ALLOWED_REDIRECT_HOSTS.includes(parsed.hostname)) {
            return res.status(400).json({ error: `${name} must redirect to an allowed domain` });
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
billingRouter.post("/portal", requirePermission("billing:manage"), async (req, res, next) => {
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
        const ALLOWED_HOSTS = ["app.kill-switch.net", "kill-switch.net", "localhost", "127.0.0.1"];
        if (!ALLOWED_HOSTS.includes(parsed.hostname)) {
          return res.status(400).json({ error: "returnUrl must redirect to an allowed domain" });
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

  // Idempotency: Stripe re-delivers events on retry. Skip ones we've already handled.
  const alreadyProcessed = await ProcessedStripeEventModel.findOne({ eventId: event.id });
  if (alreadyProcessed) {
    return res.json({ received: true, deduped: true });
  }

  // current_period_end moved onto subscription items in recent API versions — read defensively.
  const periodEndOf = (sub: Stripe.Subscription): number | undefined =>
    (sub as any).current_period_end ?? (sub.items?.data?.[0] as any)?.current_period_end;

  try {
    switch (event.type) {
      case "checkout.session.completed": {
        const session = event.data.object as Stripe.Checkout.Session;
        const accountId = session.metadata?.guardianAccountId;

        // Derive tier from the subscription's price ID instead of trusting metadata
        const VALID_PAID_TIERS = new Set(Object.values(PRICES).map(p => p.tier));
        let tier: GuardianTier = "pro"; // safe default
        let subStatus: string | undefined;
        let periodEnd: number | undefined;
        if (session.subscription) {
          try {
            const sub = await stripe!.subscriptions.retrieve(session.subscription as string);
            subStatus = sub.status;
            periodEnd = periodEndOf(sub);
            const priceId = sub.items.data[0]?.price?.id;
            const matchedPlan = Object.values(PRICES).find(p => p.priceId === priceId);
            if (matchedPlan) {
              tier = matchedPlan.tier;
            }
          } catch {
            // Fall back to metadata if subscription lookup fails
            const metaTier = session.metadata?.tier as GuardianTier | undefined;
            if (metaTier && VALID_PAID_TIERS.has(metaTier)) {
              tier = metaTier;
            }
          }
        } else {
          const metaTier = session.metadata?.tier as GuardianTier | undefined;
          if (metaTier && VALID_PAID_TIERS.has(metaTier)) {
            tier = metaTier;
          }
        }

        if (accountId && TIER_LIMITS[tier]) {
          await GuardianAccountModel.findByIdAndUpdate(accountId, {
            tier,
            stripeCustomerId: session.customer as string,
            stripeSubscriptionId: session.subscription as string,
            subscriptionStatus: subStatus ?? "active",
            ...(periodEnd ? { currentPeriodEnd: periodEnd } : {}),
            "settings.checkIntervalMinutes": TIER_LIMITS[tier].checkIntervalMinutes,
          });
          console.log(`[guardian] Account ${accountId} upgraded to ${tier}`);
        }
        break;
      }

      case "customer.subscription.updated": {
        const subscription = event.data.object as Stripe.Subscription;
        const account = await GuardianAccountModel.findOne({ stripeSubscriptionId: subscription.id });
        if (account) {
          const status = subscription.status;
          account.subscriptionStatus = status;
          const periodEnd = periodEndOf(subscription);
          if (periodEnd) account.currentPeriodEnd = periodEnd;

          const action = classifySubscriptionStatus(status);
          if (action === "apply") {
            // Healthy subscription — (re)apply the plan's tier and limits.
            const priceId = subscription.items.data[0]?.price?.id;
            const plan = Object.values(PRICES).find(p => p.priceId === priceId);
            if (plan) {
              account.tier = plan.tier;
              account.settings.checkIntervalMinutes = TIER_LIMITS[plan.tier].checkIntervalMinutes;
            }
          } else if (action === "downgrade") {
            // Dunning exhausted / subscription dead → downgrade to free.
            account.tier = "free";
            account.settings.checkIntervalMinutes = TIER_LIMITS.free.checkIntervalMinutes;
          }
          // "grace" (past_due / incomplete) → keep current tier; status is recorded above.
          await account.save();
          if (account.tier === "free") await reconcileTierDowngrade(String(account._id), "free");
          // Propagate a real downgrade to the owner's organization accounts (grace keeps tier).
          if (action === "downgrade") await downgradeOwnedOrganizations(account.ownerUserId);
          console.log(`[guardian] Subscription ${account._id} status=${status} tier=${account.tier}`);
        }
        break;
      }

      case "invoice.payment_failed": {
        // Card failed — flag the account as past_due (grace). Final downgrade happens on the
        // eventual subscription.updated(unpaid/canceled) or subscription.deleted event.
        const invoice = event.data.object as Stripe.Invoice;
        const subId = (invoice as any).subscription as string | undefined;
        const account = subId
          ? await GuardianAccountModel.findOne({ stripeSubscriptionId: subId })
          : invoice.customer
            ? await GuardianAccountModel.findOne({ stripeCustomerId: invoice.customer as string })
            : null;
        if (account) {
          account.subscriptionStatus = "past_due";
          await account.save();
          console.log(`[guardian] Payment failed: ${account._id} flagged past_due`);
        }
        break;
      }

      case "customer.subscription.deleted": {
        const subscription = event.data.object as Stripe.Subscription;
        const account = await GuardianAccountModel.findOne({ stripeSubscriptionId: subscription.id });
        if (account) {
          account.tier = "free";
          account.stripeSubscriptionId = undefined;
          account.subscriptionStatus = "canceled";
          account.settings.checkIntervalMinutes = TIER_LIMITS.free.checkIntervalMinutes;
          await account.save();
          await reconcileTierDowngrade(String(account._id), "free");
          // The owner's organization accounts inherit from this (now-dead) sub — downgrade them too.
          await downgradeOwnedOrganizations(account.ownerUserId);
          console.log(`[guardian] Subscription canceled: ${account._id} -> free`);
        }
        break;
      }
    }

    // Mark processed only after successful handling, so a failed handler is retried by Stripe.
    await ProcessedStripeEventModel.create({ eventId: event.id, type: event.type }).catch(() => {});
  } catch (err: any) {
    console.error("[guardian] Webhook handler error:", err.message);
    return res.status(500).send("Webhook handler error");
  }

  res.json({ received: true });
});

/**
 * Middleware: Enforce tier limits
 */
/**
 * On downgrade, pause cloud accounts that exceed the new tier's limit so excess
 * resources aren't left actively monitored under a plan that doesn't allow them.
 * Keeps the oldest N (by createdAt) active; pausing is non-destructive and reversible.
 */
async function reconcileTierDowngrade(accountId: string, tier: GuardianTier): Promise<void> {
  const limit = TIER_LIMITS[tier].cloudAccounts;
  const { CloudAccountModel } = await import("../../models/cloud-account/schema.js");
  const active = await CloudAccountModel.find({ guardianAccountId: accountId, status: "active" });
  if (!Array.isArray(active) || active.length <= limit) return;
  // Keep the oldest `limit` active; pause the rest. Sort in JS so we don't depend on query-builder chaining.
  const sorted = [...active].sort((a: any, b: any) => (a.createdAt ?? 0) - (b.createdAt ?? 0));
  const toPause = sorted.slice(limit);
  for (const doc of toPause) {
    (doc as any).status = "paused";
    await (doc as any).save();
  }
  console.log(`[guardian] Downgrade reconcile: paused ${toPause.length} cloud account(s) for ${accountId} (limit ${limit})`);
}

/**
 * When an owner's personal subscription dies, their organization accounts — whose tier is
 * inherited from that sub and which carry no sub of their own — must downgrade too. Otherwise
 * they retain paid features for free until someone opens their billing page. This is the
 * event-driven counterpart to the owner-derived self-heal in GET /billing/status, and it
 * updates the stored tier promptly so ALL tier-gated routes (not just billing/status) see it.
 */
async function downgradeOwnedOrganizations(ownerUserId: string): Promise<void> {
  const orgs = await GuardianAccountModel.find({ ownerUserId, type: "organization" });
  for (const org of orgs) {
    if (!SELF_SERVE_PAID_TIERS.has(org.tier)) continue; // free/enterprise: nothing to self-heal
    const staleTier = org.tier;
    org.tier = "free";
    org.settings.checkIntervalMinutes = TIER_LIMITS.free.checkIntervalMinutes;
    await org.save();
    await reconcileTierDowngrade(String(org._id), "free");
    console.log(`[guardian] Propagated owner downgrade: org ${org._id} "${staleTier}" -> free`);
  }
}

// Alert-channel limits are enforced directly in routes/alerts/index.ts via TIER_LIMITS.
export function enforceTierLimits(resource: "cloudAccounts") {
  return async (req: any, res: any, next: any) => {
    try {
      const account = await GuardianAccountModel.findById(req.guardianAccountId);
      if (!account) return res.status(404).json({ error: "Account not found" });

      const limits = TIER_LIMITS[account.tier];

      if (resource === "cloudAccounts" && req.method === "POST") {
        const { CloudAccountModel } = await import("../../models/cloud-account/schema.js");
        const count = await CloudAccountModel.countDocuments({ guardianAccountId: account._id });
        if (count >= limits.cloudAccounts) {
          const tierLabel = account.tier === "free" ? "Your current" : account.tier;
          return res.status(403).json({
            error: `${tierLabel} plan allows ${limits.cloudAccounts} cloud account(s). Upgrade to add more.`,
            currentTier: account.tier === "free" ? "none" : account.tier,
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
