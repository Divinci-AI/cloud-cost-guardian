/**
 * Web Push Routes
 *
 * Subscribe/unsubscribe browser push endpoints plus the VAPID public key
 * needed for the browser to create a push subscription.
 */

import { Router } from "express";
import { PushSubscriptionModel } from "../../models/push-subscription/schema.js";
import { requireAuth, resolveOrg } from "../../middleware/auth.js";

export const pushRouter = Router();

/**
 * SSRF guard using an ALLOWLIST of known push provider domains.
 *
 * Denylist approaches are bypassable via decimal/octal/hex IP notation
 * (e.g. http://2130706433/ = 127.0.0.1) and via exotic IPv6 forms. An
 * allowlist of the ~4 real push providers eliminates that entire class.
 *
 * Covered providers:
 *   FCM (Chrome/Android)   — fcm.googleapis.com
 *   Mozilla autopush       — *.push.services.mozilla.com
 *   Apple WebPush (Safari) — *.push.apple.com
 *   WNS (Edge/Windows)     — *.notify.windows.com
 *
 * Tradeoff: self-hosted / UnifiedPush endpoints are blocked. That's acceptable
 * for Kill Switch since we target mainstream consumer browsers.
 */
const ALLOWED_PUSH_HOSTS: RegExp[] = [
  /^fcm\.googleapis\.com$/,
  /^[a-z0-9-]+\.push\.services\.mozilla\.com$/,
  /^[a-z0-9-]+\.push\.apple\.com$/,
  /^[a-z0-9-]+\.notify\.windows\.com$/,
];

function isPushEndpointSafe(urlString: string): boolean {
  try {
    const url = new URL(urlString);
    if (url.protocol !== "https:") return false;
    const host = url.hostname.toLowerCase();
    return ALLOWED_PUSH_HOSTS.some(re => re.test(host));
  } catch {
    return false;
  }
}

/** GET /push/vapid-public-key — public key the browser needs to create a subscription */
pushRouter.get("/vapid-public-key", (_req, res) => {
  const publicKey = process.env.VAPID_PUBLIC_KEY?.trim() || null;
  res.json({ publicKey });
});

/** POST /push/subscribe — register a push subscription for the current user + org */
pushRouter.post("/subscribe", requireAuth, resolveOrg, async (req, res, next) => {
  try {
    const userId = (req as any).userId;
    const guardianAccountId = (req as any).guardianAccountId;
    const { endpoint, keys } = req.body;

    if (!endpoint || typeof endpoint !== "string") {
      return res.status(400).json({ error: "endpoint is required" });
    }
    if (!isPushEndpointSafe(endpoint)) {
      return res.status(400).json({ error: "Invalid push endpoint URL" });
    }
    if (!keys?.p256dh || !keys?.auth) {
      return res.status(400).json({ error: "keys.p256dh and keys.auth are required" });
    }
    if (typeof keys.p256dh !== "string" || typeof keys.auth !== "string") {
      return res.status(400).json({ error: "keys must be strings" });
    }

    await PushSubscriptionModel.findOneAndUpdate(
      { endpoint },
      { guardianAccountId, userId, endpoint, keys },
      { upsert: true, new: true },
    );

    res.json({ subscribed: true });
  } catch (e) { next(e); }
});

/** DELETE /push/subscribe — remove a push subscription */
pushRouter.delete("/subscribe", requireAuth, async (req, res, next) => {
  try {
    const { endpoint } = req.body;
    if (!endpoint) return res.status(400).json({ error: "endpoint is required" });

    await PushSubscriptionModel.deleteOne({
      endpoint,
      userId: (req as any).userId,
    });

    res.json({ unsubscribed: true });
  } catch (e) { next(e); }
});
