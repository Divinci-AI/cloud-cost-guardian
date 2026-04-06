/**
 * Product Context Snapshot
 *
 * Assembled once per run and shared with every sub-agent.
 * Add live metric fetching here as the product matures.
 */

export interface ProductContext {
  date: string;
  product: string;
  providers: string[];
  tiers: TierInfo[];
  features: string[];
  stack: string[];
  targetAudience: string[];
  knownChallenges: string[];
  recentWork: string[];
}

interface TierInfo {
  name: string;
  price: string;
  limits: string;
}

/**
 * Build the context snapshot for the current advisory run.
 * In the future, augment with live metrics from the Kill Switch API.
 */
export function buildContext(): ProductContext {
  return {
    date: new Date().toISOString().split("T")[0],

    product: `Kill Switch (kill-switch.net) — a SaaS product that monitors cloud spending across
providers and auto-kills runaway services before they generate surprise bills.
Born from a real $91K Cloudflare Durable Objects billing incident.
The core value: set thresholds, connect your cloud accounts, and sleep soundly.
If a service goes rogue, Kill Switch disconnects it automatically and fires alerts.`,

    providers: [
      "Cloudflare (Workers, Durable Objects, R2, D1, Queues, Stream, Zones)",
      "GCP (Cloud Run, Compute Engine, GKE, BigQuery, Cloud Functions, Cloud Storage)",
      "AWS (EC2, Lambda, RDS, ECS, EKS, S3, SageMaker, Cost Explorer)",
      "RunPod (GPU Pods on-demand & spot, Serverless Endpoints, Network Volumes)",
      "Redis (Redis Cloud, AWS ElastiCache, self-hosted)",
      "MongoDB (MongoDB Atlas, self-hosted)",
      "OpenAI (token usage, daily cost monitoring)",
      "Anthropic (Claude API token usage and cost tracking)",
      "xAI / Grok (API token usage and cost tracking)",
      "Replicate (GPU prediction costs, model usage)",
      "Snowflake (warehouse credits, query costs, data scanning)",
      "Vercel (function invocations, bandwidth, build minutes)",
      "Datadog (host count, log ingestion, custom metrics costs)",
    ],

    tiers: [
      {
        name: "Free",
        price: "$0/mo",
        limits: "1 cloud account, basic thresholds, email alerts only",
      },
      {
        name: "Pro",
        price: "$29/mo",
        limits: "10 cloud accounts, all alert channels, CLI + SDK access, activity log",
      },
      {
        name: "Enterprise",
        price: "Custom",
        limits: "Unlimited accounts, multi-org/RBAC, SLA, dedicated support, custom integrations",
      },
    ],

    features: [
      "Web dashboard — connect accounts, set thresholds, view real-time status",
      "Auto-kill (disconnect) — reversible: removes routes/workers, doesn't delete data",
      "Alert channels — Slack, PagerDuty, GitHub Issues, email, custom webhook",
      "CLI (`ks`) — one-command onboarding, check, alerts, accounts management",
      "SDK (TypeScript) — programmatic integration for CI/CD pipelines",
      "Multi-org support — team accounts with role-based permissions (owner/admin/member/viewer)",
      "Activity log — full audit trail of all changes and kill events",
      "Manual check endpoint — on-demand threshold evaluation",
      "Rule presets — DDoS, brute-force, cost runaway, error storm, GPU runaway, lambda loop",
      "Agent model — edge workers run in customer accounts (no credential sharing)",
      "Dogfooding — Kill Switch monitors itself (meta self-protection)",
      "OpenAPI docs — machine-readable API spec at /docs/openapi.json",
    ],

    stack: [
      "Frontend: React + Vite + Cloudflare Workers (kill-switch-app)",
      "API: Express.js on GCP Cloud Run (guardian-api)",
      "Auth: Clerk (JWT + API keys with ks_live_ prefix)",
      "Database: MongoDB (accounts, cloud accounts, rules, alerts) + PostgreSQL (activity log)",
      "Billing: Stripe (subscriptions, checkout, webhook)",
      "CF Workers: kill-switch-cf (cron monitor), edge-agent (per-customer cron), advisor (this)",
      "Marketing site: Cloudflare Workers (cloud-switch-site)",
      "Domains: kill-switch.net, app.kill-switch.net, api.kill-switch.net",
    ],

    targetAudience: [
      "Indie hackers and solo founders using Cloudflare Workers at scale",
      "Startups running GPU workloads on RunPod / AWS SageMaker",
      "DevOps engineers managing multi-cloud infrastructure",
      "AI/ML teams running expensive API-driven workloads (OpenAI, Anthropic, Replicate)",
      "SaaS companies with usage-based billing on cloud infrastructure",
      "Engineering teams that have already been burned by a surprise bill",
    ],

    knownChallenges: [
      "Discoverability — target users don't know Kill Switch exists until after a billing incident",
      "Trust gap — connecting cloud credentials requires users to trust the platform",
      "Free tier conversion — unclear what triggers upgrade from free to pro",
      "Onboarding friction — multi-step credential setup (IAM roles, API tokens) has drop-off",
      "Alert fatigue risk — thresholds too aggressive = noise; too loose = misses real events",
      "Bidirectional awareness — users understand 'alert' but 'auto-kill' requires more trust",
      "Stripe live mode — webhook integration pending live keys",
      "SDK adoption — CLI exists but programmatic SDK underused",
    ],

    recentWork: [
      "Added 10 new providers (Redis, MongoDB, OpenAI, Anthropic, xAI, Replicate, Snowflake, Vercel, Datadog) on top of existing Cloudflare/GCP/AWS",
      "Added multi-org RBAC with 4 roles: owner, admin, member, viewer",
      "Added activity log (full audit trail in PostgreSQL)",
      "Added rule presets (8 common protection patterns)",
      "Added OpenAPI spec endpoint",
      "Improved marketing site with provider cards and documentation pages",
      "Refactored auth middleware to support both Clerk JWTs and API keys",
      "Security hardening: CF origin secret fail-close, timing-safe compares, rate limiting",
    ],
  };
}
