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
import { GuardianAccountModel } from "./models/guardian-account/schema.js";
import { requireAuth, resolveGuardianAccount } from "./middleware/auth.js";
import { runCheckCycle } from "./services/monitoring-engine.js";
import { openApiSpec } from "./routes/docs/openapi.js";
import { getUsageHistory, getAlertHistory, getAnalyticsOverview } from "./globals/index.js";

export function createApp() {
  const app = express();

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
    res.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data: https:; connect-src 'self' https://*.auth0.com https://*.stripe.com https://api.kill-switch.net; frame-src https://*.stripe.com; object-src 'none'; base-uri 'self'");
    if (process.env.NODE_ENV === "production") {
      res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
    }
    next();
  });

  // Origin verification — block direct access to Cloud Run, require CF proxy
  if (process.env.NODE_ENV === "production") {
    const cfSecret = process.env.CF_ORIGIN_SECRET;
    if (cfSecret) {
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
  }

  app.use(express.json({ limit: "1mb" }));

  // Rate limiting
  if (process.env.NODE_ENV !== "test") {
    // Per-user key generator: uses authenticated userId if available, falls back to IP
    const perUserKey = (req: any) => req.userId || req.ip;
    // General: 100 requests per 15 minutes per IP
    app.use(rateLimit({ windowMs: 15 * 60 * 1000, max: 100, standardHeaders: true, legacyHeaders: false }));
    // Strict per-user limits on sensitive endpoints
    app.use("/providers", rateLimit({ windowMs: 15 * 60 * 1000, max: 10, keyGenerator: perUserKey }));
    app.use("/database/kill", rateLimit({ windowMs: 15 * 60 * 1000, max: 10, keyGenerator: perUserKey }));
    app.use("/billing/checkout", rateLimit({ windowMs: 15 * 60 * 1000, max: 5, keyGenerator: perUserKey }));
    app.use("/alerts/test", rateLimit({ windowMs: 15 * 60 * 1000, max: 5, keyGenerator: perUserKey }));
    app.use("/team/invite", rateLimit({ windowMs: 15 * 60 * 1000, max: 20, keyGenerator: perUserKey }));
    app.use("/agent/report", rateLimit({ windowMs: 15 * 60 * 1000, max: 30 }));
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

  // Public billing plans
  app.get("/billing/plans", (_req, res) => {
    res.json({
      plans: [
        { tier: "free", name: "Free", price: 0, monthlyPrice: 0, features: ["1 cloud account", "6-hour checks", "1 alert channel"] },
        { tier: "pro", name: "Pro", monthlyPrice: 29, annualPrice: 290, features: ["3 cloud accounts", "5-minute checks", "All channels", "Dashboard"] },
        { tier: "team", name: "Team", monthlyPrice: 99, annualPrice: 990, features: ["10 cloud accounts", "Team roles", "Audit log", "API"] },
        { tier: "enterprise", name: "Enterprise", monthlyPrice: null, features: ["Unlimited", "SSO", "SLA"], contactUs: true },
      ],
    });
  });

  // Auth middleware for protected routes
  const authStack = [requireAuth, resolveGuardianAccount];
  app.use("/cloud-accounts", ...authStack);
  app.use("/alerts", ...authStack);
  app.use("/rules", ...authStack);
  app.use("/database", ...authStack);
  app.use("/billing", ...authStack);
  app.use("/team", ...authStack);

  // Authenticated routes
  app.use("/cloud-accounts", cloudAccountRouter);
  app.use("/alerts", alertRouter);
  app.use("/rules", rulesRouter);
  app.use("/database", databaseRouter);
  app.use("/billing", billingRouter);
  app.use("/team", teamRouter);

  // Manual check (requires auth — runs only the authenticated user's accounts)
  app.post("/check", requireAuth, resolveGuardianAccount, async (req, res, next) => {
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
      const existing = await GuardianAccountModel.findOne({ ownerUserId });
      if (existing) return res.json({ id: existing._id, name: existing.name, tier: existing.tier, existing: true });
      const account = await GuardianAccountModel.create({ ownerUserId, name, tier: "free", alertChannels: [], settings: { checkIntervalMinutes: 360, dailyReportEnabled: false } });
      res.status(201).json({ id: account._id, name: account.name, tier: account.tier });
    } catch (e) { next(e); }
  });

  app.get("/accounts/me", requireAuth, resolveGuardianAccount, async (req: any, res, next) => {
    try {
      const account = await GuardianAccountModel.findById(req.guardianAccountId).lean();
      if (!account) return res.status(404).json({ error: "Account not found" });
      // Strip sensitive fields
      const { stripeCustomerId: _s, ...safe } = account as any;
      res.json(safe);
    } catch (e) { next(e); }
  });

  app.patch("/accounts/me", requireAuth, resolveGuardianAccount, async (req: any, res, next) => {
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
      const { stripeCustomerId: _s, ...safe } = account as any;
      res.json(safe);
    } catch (e) { next(e); }
  });

  // Analytics overview (aggregate FinOps data across all accounts)
  app.get("/analytics/overview", requireAuth, resolveGuardianAccount, async (req: any, res, next) => {
    try {
      const days = parseInt(req.query.days as string) || 30;
      const overview = await getAnalyticsOverview(req.guardianAccountId, days);
      res.json(overview);
    } catch (e) { next(e); }
  });

  // Usage history (requires auth + ownership check)
  app.get("/cloud-accounts/:id/usage", requireAuth, resolveGuardianAccount, async (req: any, res, next) => {
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
    res.status(err.status || 500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : (err.message || "Internal server error") });
  });

  return app;
}
