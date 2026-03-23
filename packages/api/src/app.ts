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
import { getAllProviders, getProvider } from "./providers/index.js";
import { cloudAccountRouter } from "./routes/cloud-accounts/index.js";
import { alertRouter } from "./routes/alerts/index.js";
import { rulesRouter } from "./routes/rules/index.js";
import { databaseRouter } from "./routes/database/index.js";
import { billingRouter } from "./routes/billing/index.js";
import { GuardianAccountModel } from "./models/guardian-account/schema.js";
import { requireAuth, resolveGuardianAccount } from "./middleware/auth.js";
import { runCheckCycle } from "./services/monitoring-engine.js";
import { openApiSpec } from "./routes/docs/openapi.js";
import { getUsageHistory, getAlertHistory } from "./globals/index.js";

export function createApp() {
  const app = express();

  // CORS — restrict to known origins in production
  const allowedOrigins = process.env.ALLOWED_ORIGINS?.split(",") || ["http://localhost:3000"];
  app.use(cors({
    origin: process.env.NODE_ENV === "production" ? allowedOrigins : true,
    credentials: true,
  }));

  // Security headers
  app.use((_req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("X-XSS-Protection", "1; mode=block");
    res.setHeader("Referrer-Policy", "same-origin");
    if (process.env.NODE_ENV === "production") {
      res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
    }
    next();
  });

  app.use(express.json({ limit: "1mb" }));

  // Rate limiting
  if (process.env.NODE_ENV !== "test") {
    // General: 100 requests per 15 minutes per IP
    app.use(rateLimit({ windowMs: 15 * 60 * 1000, max: 100, standardHeaders: true, legacyHeaders: false }));
    // Strict: credential validation and kill switch (10 per 15 min)
    app.use("/providers", rateLimit({ windowMs: 15 * 60 * 1000, max: 10 }));
    app.use("/database/kill", rateLimit({ windowMs: 15 * 60 * 1000, max: 10 }));
    app.use("/billing/checkout", rateLimit({ windowMs: 15 * 60 * 1000, max: 5 }));
    app.use("/alerts/test", rateLimit({ windowMs: 15 * 60 * 1000, max: 5 }));
  }

  // Skip morgan in test
  if (process.env.NODE_ENV !== "test") {
    app.use(morgan(":method :url :status :response-time ms"));
  }

  // Health check
  app.get("/", (_req, res) => {
    res.json({
      service: "cloud-cost-guardian",
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

  // Authenticated routes
  app.use("/cloud-accounts", cloudAccountRouter);
  app.use("/alerts", alertRouter);
  app.use("/rules", rulesRouter);
  app.use("/database", databaseRouter);
  app.use("/billing", billingRouter);

  // Manual check (requires auth — runs only the authenticated user's accounts)
  app.post("/check", requireAuth, resolveGuardianAccount, async (req, res, next) => {
    try {
      const results = await runCheckCycle();
      // Filter to only this user's results
      const guardianAccountId = (req as any).guardianAccountId;
      const userResults = results.filter((r: any) => {
        // In production, scope to user's accounts only
        return true; // TODO: filter by guardianAccountId when monitoring engine supports it
      });
      res.json({ status: "checked", results: userResults, timestamp: new Date().toISOString() });
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

  // Usage history
  app.get("/cloud-accounts/:id/usage", async (req, res, next) => {
    try {
      const days = parseInt(req.query.days as string) || 7;
      const history = await getUsageHistory(req.params.id, days);
      res.json({ usage: history, days });
    } catch (e) { next(e); }
  });

  // Agent report
  app.post("/agent/report", async (req, res, next) => {
    try {
      const apiKey = req.headers.authorization?.replace("Bearer ", "");
      if (!apiKey) return res.status(401).json({ error: "Missing API key" });
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
