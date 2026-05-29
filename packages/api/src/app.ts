/**
 * Express App Factory
 *
 * Creates the Express app without starting the server.
 * Used by both the production server (index.ts) and tests.
 */

import express from "express";
import cors from "cors";
import morgan from "morgan";
import rateLimit from "express-rate-limit";
import { timingSafeEqual } from "crypto";
import { getAllProviders, getProvider } from "./providers/index.js";
import { cloudAccountRouter } from "./routes/cloud-accounts/index.js";
import { alertRouter } from "./routes/alerts/index.js";
import { rulesRouter } from "./routes/rules/index.js";
import { databaseRouter } from "./routes/database/index.js";
import { billingRouter } from "./routes/billing/index.js";
import { teamRouter } from "./routes/team/index.js";
import { authRouter } from "./routes/auth/index.js";
import { cliAuthRouter } from "./routes/cli-auth/index.js";
import { GuardianAccountModel } from "./models/guardian-account/schema.js";
import { requireAuth, resolveOrg } from "./middleware/auth.js";
import { requirePermission } from "./middleware/permissions.js";
import { logActivity } from "./services/activity-logger.js";
import { activityRouter } from "./routes/activity/index.js";
import { orgsRouter } from "./routes/orgs/index.js";
import { agentGuardRouter } from "./routes/agent-guard/index.js";
import { runCheckCycle } from "./services/monitoring-engine.js";
import { openApiSpec } from "./routes/docs/openapi.js";
import { getUsageHistory, getAlertHistory, getAnalyticsOverview } from "./globals/index.js";

export function createApp() {
  const app = express();

  // Safety: abort if dev auth bypass is accidentally enabled in production
  if (process.env.GUARDIAN_DEV_AUTH_BYPASS === "true" && process.env.NODE_ENV === "production") {
    throw new Error("FATAL: GUARDIAN_DEV_AUTH_BYPASS must not be set in production");
  }

  // Trust proxy — 1 hop (Cloud Run sits behind Google's load balancer)
  app.set("trust proxy", 1);

  // CORS — always use explicit allowlist (never open wildcard)
  const defaultOrigins = process.env.NODE_ENV === "test"
    ? ["http://localhost:3000"]
    : [
        "http://localhost:3000",
        "http://localhost:5173",
        "https://kill-switch.net",
        "https://www.kill-switch.net",
        "https://app.kill-switch.net",
      ];
  const allowedOrigins = process.env.ALLOWED_ORIGINS?.split(",") || defaultOrigins;
  app.use(cors({
    origin: allowedOrigins,
    credentials: true,
  }));

  // Security headers
  app.use((_req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("X-XSS-Protection", "1; mode=block");
    res.setHeader("Referrer-Policy", "same-origin");
    res.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data: https:; connect-src 'self' https://*.clerk.accounts.dev https://clerk.kill-switch.net https://*.kill-switch.net https://*.stripe.com https://api.kill-switch.net; frame-src https://*.stripe.com; object-src 'none'; base-uri 'self'");
    if (process.env.NODE_ENV === "production") {
      res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
    }
    next();
  });

  // Origin verification — block direct access to Cloud Run, require CF proxy
  if (process.env.NODE_ENV === "production") {
    const cfSecret = process.env.CF_ORIGIN_SECRET;
    if (!cfSecret) {
      throw new Error("FATAL: CF_ORIGIN_SECRET must be set in production");
    }
    const cfSecretBuf = Buffer.from(cfSecret);
    app.use((req, res, next) => {
      if (req.path === "/" && req.method === "GET") return next();
      const provided = (req.headers["x-origin-secret"] as string) || "";
      if (provided.length !== cfSecret.length ||
          !timingSafeEqual(Buffer.from(provided), cfSecretBuf)) {
        console.error(`[guardian] Blocked direct access from ${req.ip} to ${req.path}`);
        return res.status(403).json({ error: "Forbidden" });
      }
      next();
    });
  }

  // Skip JSON parsing for Stripe webhook (needs raw body for signature verification)
  app.use((req, res, next) => {
    if (req.path === "/billing/webhook") return next();
    express.json({ limit: "1mb" })(req, res, next);
  });

  // Rate limiting
  if (process.env.NODE_ENV !== "test") {
    // Per-user key generator: uses authenticated userId if available, falls back to IP
    const perUserKey = (req: any) => req.userId || req.ip;
    const rlOpts = { validate: { trustProxy: false, xForwardedForHeader: false } };
    // General: 100 requests per 15 minutes per IP — but skip /auth/cli/poll
    // which legitimately polls every 2s for up to 10 min (=300 polls per flow).
    // That path has its own narrower per-IP limit below.
    app.use(rateLimit({
      windowMs: 15 * 60 * 1000,
      max: 100,
      standardHeaders: true,
      legacyHeaders: false,
      skip: (req) => req.path.startsWith("/auth/cli/poll"),
      ...rlOpts,
    }));
    // Strict per-user limits on sensitive endpoints
    app.use("/providers", rateLimit({ windowMs: 15 * 60 * 1000, max: 10, keyGenerator: perUserKey, ...rlOpts }));
    app.use("/database/kill", rateLimit({ windowMs: 15 * 60 * 1000, max: 10, keyGenerator: perUserKey, ...rlOpts }));
    app.use("/billing/checkout", rateLimit({ windowMs: 15 * 60 * 1000, max: 5, keyGenerator: perUserKey, ...rlOpts }));
    app.use("/alerts/test", rateLimit({ windowMs: 15 * 60 * 1000, max: 5, keyGenerator: perUserKey, ...rlOpts }));
    app.use("/team/invite", rateLimit({ windowMs: 15 * 60 * 1000, max: 20, keyGenerator: perUserKey, ...rlOpts }));
    app.use("/agent/report", rateLimit({ windowMs: 15 * 60 * 1000, max: 30, ...rlOpts }));
    // agent-guard event ingest — agents trip caps repeatedly, so allow a higher per-user rate
    app.use("/agent-guard", rateLimit({ windowMs: 15 * 60 * 1000, max: 60, keyGenerator: perUserKey, ...rlOpts }));
    // /check triggers external cloud API calls — tight per-user limit to prevent amplification
    app.use("/check", rateLimit({ windowMs: 60 * 60 * 1000, max: 10, keyGenerator: perUserKey, ...rlOpts }));
    // CLI device-flow code creation — anonymous endpoint, IP-keyed
    app.use("/auth/cli/start", rateLimit({ windowMs: 60 * 60 * 1000, max: 10, standardHeaders: true, legacyHeaders: false, ...rlOpts }));
    // CLI device-flow polling — anonymous, IP-keyed. The CLI polls every 2s
    // for up to 10 min so legitimate use is ~300 polls per flow. 500 per
    // 15min = ~33/min ≈ 1 every 1.8s caps brute-force code-guessing well
    // below what's needed to enumerate the 31^8 ≈ 10^12 code space.
    app.use("/auth/cli/poll", rateLimit({ windowMs: 15 * 60 * 1000, max: 500, standardHeaders: true, legacyHeaders: false, ...rlOpts }));
  }

  // Skip morgan in test
  if (process.env.NODE_ENV !== "test") {
    app.use(morgan(":method :url :status :response-time ms"));
  }

  // Health check
  app.get("/", (_req, res) => {
    res.json({
      service: "kill-switch",
      status: "healthy",
      version: "0.1.0",
      providers: getAllProviders().map(p => ({ id: p.id, name: p.name })),
    });
  });

  // Public endpoints
  app.get("/providers", (_req, res) => {
    res.json({ providers: getAllProviders().map(p => ({ id: p.id, name: p.name, defaultThresholds: p.getDefaultThresholds() })) });
  });

  app.post("/providers/:providerId/validate", requireAuth, async (req, res, next) => {
    try {
      const provider = getProvider(req.params.providerId as any);
      if (!provider) return res.status(404).json({ error: `Unknown provider: ${req.params.providerId}` });
      const result = await provider.validateCredential(req.body);
      res.json(result);
    } catch (e) { next(e); }
  });

  // Public rule presets
  app.get("/rules/presets", (_req, res) => {
    res.json({
      presets: [
        { id: "ddos", name: "DDoS Protection", description: "Kill services getting excessive request volume", category: "security" },
        { id: "brute-force", name: "Brute Force Protection", description: "Rotate credentials on mass auth failures", category: "security" },
        { id: "cost-runaway", name: "Cost Runaway Protection", description: "Disconnect workers exceeding daily cost limit", category: "cost" },
        { id: "error-storm", name: "Error Storm Protection", description: "Scale down on sustained high error rate", category: "reliability" },
        { id: "exfiltration", name: "Data Exfiltration Detection", description: "Isolate services with unusual egress", category: "security" },
        { id: "gpu-runaway", name: "GPU Instance Runaway", description: "Stop unexpected GPU instances (crypto mining, leaked keys)", category: "cost" },
        { id: "lambda-loop", name: "Lambda Recursive Loop", description: "Throttle Lambda functions with runaway concurrency", category: "cost" },
        { id: "aws-cost-runaway", name: "AWS Daily Cost Runaway", description: "Emergency stop when daily AWS spend spikes", category: "cost" },
      ],
    });
  });

  // CLI device-flow auth — must be mounted BEFORE the /auth authStack below.
  // /start and /poll are public (CLI has no creds yet); /approve and /deny
  // apply their own auth middleware at the route level.
  app.use("/auth/cli", cliAuthRouter);

  // Auth middleware for protected routes
  const authStack = [requireAuth, resolveOrg];
  app.use("/cloud-accounts", ...authStack);
  app.use("/alerts", ...authStack);
  app.use("/rules", ...authStack);
  app.use("/database", ...authStack);
  // Billing auth: skip public routes (plans + webhook)
  app.use("/billing", (req, _res, next) => {
    if (req.path === "/plans" && req.method === "GET") return next();
    if (req.path === "/webhook" && req.method === "POST") return next();
    requireAuth(req as any, _res, (err?: any) => {
      if (err) return next(err);
      resolveOrg(req as any, _res, next);
    });
  });
  app.use("/team", ...authStack);
  app.use("/auth", ...authStack);
  app.use("/activity", ...authStack);
  app.use("/agent-guard", ...authStack);
  app.use("/orgs", requireAuth, resolveOrg);

  // Authenticated routes
  app.use("/cloud-accounts", cloudAccountRouter);
  app.use("/alerts", alertRouter);
  app.use("/rules", rulesRouter);
  app.use("/database", databaseRouter);
  app.use("/billing", billingRouter);
  app.use("/team", teamRouter);
  app.use("/auth", authRouter);
  app.use("/activity", activityRouter);
  app.use("/agent-guard", agentGuardRouter);
  app.use("/orgs", orgsRouter);

  // Manual check (requires auth — runs only the authenticated user's accounts)
  app.post("/check", requireAuth, resolveOrg, requirePermission("check:trigger"), async (req, res, next) => {
    try {
      const guardianAccountId = (req as any).guardianAccountId;
      const results = await runCheckCycle(guardianAccountId);
      res.json({ status: "checked", results, timestamp: new Date().toISOString() });
    } catch (e) { next(e); }
  });

  // Account management (requires auth — users can only see their own account)
  app.post("/accounts", requireAuth, async (req: any, res, next) => {
    try {
      const ownerUserId = req.userId; // From JWT, not request body
      const { name } = req.body;
      if (!name) return res.status(400).json({ error: "Missing name" });
      const existing = await GuardianAccountModel.findOne({ ownerUserId, type: "personal" });
      if (existing) return res.json({ id: existing._id, name: existing.name, tier: existing.tier, existing: true });
      const account = await GuardianAccountModel.create({
        ownerUserId, name, type: "personal", tier: "free",
        alertChannels: [], settings: { checkIntervalMinutes: 360, dailyReportEnabled: false },
      });
      res.status(201).json({ id: account._id, name: account.name, tier: account.tier });
    } catch (e) { next(e); }
  });

  app.get("/accounts/me", requireAuth, resolveOrg, requirePermission("settings:read"), async (req: any, res, next) => {
    try {
      const account = await GuardianAccountModel.findById(req.guardianAccountId).lean();
      if (!account) return res.status(404).json({ error: "Account not found" });

      // Fetch user's org list for the org switcher
      const { TeamMemberModel } = await import("./models/team/schema.js");
      const { UserProfileModel } = await import("./models/user-profile/schema.js");

      const ownedAccounts = await GuardianAccountModel.find({ ownerUserId: req.userId }).lean();
      const memberships = await TeamMemberModel.find({ userId: req.userId }).lean();
      const memberOrgIds = memberships
        .map((m: any) => m.guardianAccountId)
        .filter((id: string) => !ownedAccounts.some(a => a._id.toString() === id));
      const memberAccounts = memberOrgIds.length > 0
        ? await GuardianAccountModel.find({ _id: { $in: memberOrgIds } }).lean()
        : [];

      const orgs = [
        ...ownedAccounts.map((a: any) => ({
          id: a._id.toString(), name: a.name, slug: a.slug,
          type: a.type || "personal", tier: a.tier, role: "owner",
        })),
        ...memberAccounts.map((a: any) => {
          const m = memberships.find((m: any) => m.guardianAccountId === a._id.toString());
          return {
            id: a._id.toString(), name: a.name, slug: a.slug,
            type: a.type || "personal", tier: a.tier, role: m?.role || "viewer",
          };
        }),
      ];

      const profile = await UserProfileModel.findOne({ userId: req.userId });
      const activeOrgId = profile?.activeOrgId || req.guardianAccountId;

      // Strip sensitive fields
      const { stripeCustomerId: _s, ...safe } = account as any;
      res.json({ ...safe, orgs, activeOrgId, teamRole: req.teamRole });
    } catch (e) { next(e); }
  });

  app.patch("/accounts/me", requireAuth, resolveOrg, requirePermission("settings:write"), async (req: any, res, next) => {
    try {
      const allowedFields: Record<string, boolean> = { name: true, onboardingCompleted: true, "settings.timezone": true, "settings.dailyReportEnabled": true };
      const updates: Record<string, any> = {};
      for (const [key, value] of Object.entries(req.body)) {
        if (key === "settings" && typeof value === "object" && value !== null) {
          for (const [sk, sv] of Object.entries(value as Record<string, any>)) {
            const fullKey = `settings.${sk}`;
            if (allowedFields[fullKey]) updates[fullKey] = sv;
          }
        } else if (allowedFields[key]) {
          updates[key] = value;
        }
      }
      if (Object.keys(updates).length === 0) return res.status(400).json({ error: "No valid fields to update" });
      const account = await GuardianAccountModel.findByIdAndUpdate(req.guardianAccountId, { $set: updates }, { new: true }).lean();
      if (!account) return res.status(404).json({ error: "Account not found" });

      logActivity({
        orgId: req.guardianAccountId, actorUserId: req.userId, actorEmail: req.auth?.email,
        action: "settings.update", resourceType: "account", resourceId: req.guardianAccountId,
        details: updates, ipAddress: req.ip,
      });

      const { stripeCustomerId: _s, ...safe } = account as any;
      res.json(safe);
    } catch (e) { next(e); }
  });

  /**
   * DELETE /accounts/me — Permanently delete caller's account and all owned data.
   * Cascade-deletes every org owned by the user: cloud accounts, credentials, API keys,
   * team members, invitations, and activity logs. Also removes the user profile.
   */
  app.delete("/accounts/me", requireAuth, async (req: any, res, next) => {
    try {
      const userId = req.userId;

      // Lazy imports to avoid circular deps
      const { CloudAccountModel } = await import("./models/cloud-account/schema.js");
      const { TeamMemberModel } = await import("./models/team/schema.js");
      const { UserProfileModel } = await import("./models/user-profile/schema.js");
      const { deleteAllCredentialsForAccount } = await import("./models/encrypted-credential/schema.js");
      const { deleteAllApiKeysForAccount } = await import("./models/api-key/schema.js");
      const { getPostgresPool } = await import("./globals/index.js");

      // All orgs this user owns (personal + team workspaces)
      const ownedAccounts = await GuardianAccountModel.find({ ownerUserId: userId }).lean();
      const ownedOrgIds = ownedAccounts.map((a: any) => a._id.toString());

      // Cancel active Stripe subscriptions so the user stops being billed
      try {
        const { default: Stripe } = await import("stripe");
        const stripeKey = process.env.STRIPE_API_SECRET_KEY;
        if (stripeKey) {
          const stripe = new Stripe(stripeKey, { apiVersion: "2025-02-24.acacia" });
          await Promise.all(
            (ownedAccounts as any[])
              .filter(a => a.stripeSubscriptionId)
              .map(a => stripe.subscriptions.cancel(a.stripeSubscriptionId).catch(() => {}))
          );
        }
      } catch {
        // Non-fatal: Stripe may not be configured in all envs
      }

      // Cascade-delete per org
      await Promise.all(
        ownedOrgIds.map(orgId =>
          Promise.all([
            CloudAccountModel.deleteMany({ guardianAccountId: orgId }),
            TeamMemberModel.deleteMany({ guardianAccountId: orgId }),
            deleteAllCredentialsForAccount(orgId).catch(() => {}),
            deleteAllApiKeysForAccount(orgId).catch(() => {}),
          ])
        )
      );

      // Delete invitations for all owned orgs
      const { TeamInvitationModel } = await import("./models/team/schema.js");
      if (ownedOrgIds.length > 0) {
        await TeamInvitationModel.deleteMany({ guardianAccountId: { $in: ownedOrgIds } });
      }

      // Delete Postgres activity log rows for all owned orgs
      if (ownedOrgIds.length > 0) {
        try {
          const pool = getPostgresPool();
          const placeholders = ownedOrgIds.map((_: string, i: number) => `$${i + 1}`).join(", ");
          await pool.query(`DELETE FROM activity_log WHERE org_id IN (${placeholders})`, ownedOrgIds);
        } catch {
          // Postgres may not be configured in all envs; non-fatal
        }
      }

      // Remove this user's memberships in orgs they don't own
      await TeamMemberModel.deleteMany({ userId });

      // Delete user profile and all owned accounts
      await Promise.all([
        UserProfileModel.deleteMany({ userId }),
        GuardianAccountModel.deleteMany({ ownerUserId: userId }),
      ]);

      // Delete the Clerk user so they can't sign back in with the same account.
      // Non-fatal: if CLERK_SECRET_KEY is absent (e.g. local dev), skip silently.
      try {
        const clerkSecret = process.env.CLERK_SECRET_KEY;
        if (clerkSecret) {
          const clerkRes = await fetch(`https://api.clerk.com/v1/users/${userId}`, {
            method: "DELETE",
            headers: { Authorization: `Bearer ${clerkSecret}` },
          });
          if (!clerkRes.ok) {
            console.warn(`[guardian] Clerk user deletion failed for ${userId}: ${clerkRes.status}`);
          }
        }
      } catch {
        // Non-fatal
      }

      res.json({ deleted: true });
    } catch (e) { next(e); }
  });

  // Analytics overview (aggregate FinOps data across all accounts)
  app.get("/analytics/overview", requireAuth, resolveOrg, requirePermission("cloud_accounts:read"), async (req: any, res, next) => {
    try {
      const days = parseInt(req.query.days as string) || 30;
      const overview = await getAnalyticsOverview(req.guardianAccountId, days);
      res.json(overview);
    } catch (e) { next(e); }
  });

  // Usage history (requires auth + ownership check)
  app.get("/cloud-accounts/:id/usage", requireAuth, resolveOrg, requirePermission("cloud_accounts:read"), async (req: any, res, next) => {
    try {
      // Lazy import to avoid circular deps
      const { CloudAccountModel } = await import("./models/cloud-account/schema.js");
      const account = await CloudAccountModel.findOne({ _id: req.params.id, guardianAccountId: req.guardianAccountId });
      if (!account) return res.status(404).json({ error: "Cloud account not found" });
      const days = parseInt(req.query.days as string) || 7;
      const history = await getUsageHistory(req.params.id, days);
      res.json({ usage: history, days });
    } catch (e) { next(e); }
  });

  // Agent report — validated against GUARDIAN_AGENT_API_KEY
  app.post("/agent/report", async (req, res, next) => {
    try {
      const apiKey = req.headers.authorization?.replace("Bearer ", "");
      if (!apiKey) return res.status(401).json({ error: "Missing API key" });

      const validKey = process.env.GUARDIAN_AGENT_API_KEY;
      if (!validKey) return res.status(503).json({ error: "Agent API key not configured" });
      if (apiKey.length !== validKey.length ||
          !timingSafeEqual(Buffer.from(apiKey), Buffer.from(validKey))) {
        return res.status(403).json({ error: "Invalid API key" });
      }

      res.json({ received: true, timestamp: Date.now() });
    } catch (e) { next(e); }
  });

  // Docs
  app.get("/docs/openapi.json", (_req, res) => res.json(openApiSpec));

  // Error handler
  app.use((err: any, _req: any, res: any, _next: any) => {
    console.error("[guardian] Unhandled error:", err.message || err);
    if (err.stack) console.error(err.stack);
    res.status(err.status || 500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : (err.message || "Internal server error") });
  });

  return app;
}
