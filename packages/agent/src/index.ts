/**
 * Cloud Cost Guardian — Edge Agent
 *
 * A lightweight Cloudflare Worker that runs IN the customer's account.
 * Their API token never leaves their infrastructure.
 *
 * Flow:
 * 1. Cron fires every 5 minutes
 * 2. Agent queries Cloudflare GraphQL for DO/Worker usage
 * 3. Compares against local thresholds
 * 4. If violation: auto-disconnects locally + reports to Guardian API
 * 5. If normal: reports metrics to Guardian API for dashboard/history
 *
 * Security model:
 * - Customer's CF API token stays in their account (wrangler secret)
 * - Only aggregated metrics are sent to Guardian API
 * - Kill switch executes locally (no remote access to customer's workers)
 * - Guardian API key authenticates the metric reports
 */

interface Env {
  CLOUDFLARE_API_TOKEN: string;
  CLOUDFLARE_ACCOUNT_ID: string;
  GUARDIAN_API_URL: string;
  GUARDIAN_API_KEY: string;
  DO_REQUEST_THRESHOLD: string;
  DO_WALLTIME_HOURS_THRESHOLD: string;
  WORKER_REQUEST_THRESHOLD: string;
}

interface ServiceMetrics {
  name: string;
  doRequests: number;
  doWalltimeHours: number;
  workerRequests: number;
  estimatedDailyCostUSD: number;
}

interface CheckResult {
  accountId: string;
  checkedAt: number;
  services: ServiceMetrics[];
  totalEstimatedDailyCostUSD: number;
  violations: string[];
  actionsTaken: string[];
}

// ─── Cloudflare GraphQL ─────────────────────────────────────────────────────

async function queryUsage(env: Env): Promise<{ doServices: any[]; workerServices: any[] }> {
  const today = new Date().toISOString().split("T")[0];

  const doQuery = `{
    viewer { accounts(filter: {accountTag: "${env.CLOUDFLARE_ACCOUNT_ID}"}) {
      durableObjectsInvocationsAdaptiveGroups(limit: 50, filter: {date_geq: "${today}"}, orderBy: [sum_requests_DESC]) {
        dimensions { scriptName } sum { requests wallTime }
      }
    }}
  }`;

  const workerQuery = `{
    viewer { accounts(filter: {accountTag: "${env.CLOUDFLARE_ACCOUNT_ID}"}) {
      workersInvocationsAdaptive(limit: 50, filter: {date_geq: "${today}"}, orderBy: [sum_requests_DESC]) {
        dimensions { scriptName } sum { requests errors wallTime }
      }
    }}
  }`;

  const [doRes, workerRes] = await Promise.all([
    fetch("https://api.cloudflare.com/client/v4/graphql", {
      method: "POST",
      headers: { "Authorization": `Bearer ${env.CLOUDFLARE_API_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({ query: doQuery }),
    }),
    fetch("https://api.cloudflare.com/client/v4/graphql", {
      method: "POST",
      headers: { "Authorization": `Bearer ${env.CLOUDFLARE_API_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({ query: workerQuery }),
    }),
  ]);

  const doData = await doRes.json() as any;
  const workerData = await workerRes.json() as any;

  return {
    doServices: doData?.data?.viewer?.accounts?.[0]?.durableObjectsInvocationsAdaptiveGroups || [],
    workerServices: workerData?.data?.viewer?.accounts?.[0]?.workersInvocationsAdaptive || [],
  };
}

// ─── Local Kill Switch ──────────────────────────────────────────────────────

async function disconnectWorker(env: Env, scriptName: string): Promise<string> {
  const baseUrl = `https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}`;
  const headers = { "Authorization": `Bearer ${env.CLOUDFLARE_API_TOKEN}`, "Content-Type": "application/json" };
  const actions: string[] = [];

  // Disable workers.dev
  try {
    const res = await fetch(`${baseUrl}/workers/scripts/${scriptName}/subdomain`, {
      method: "POST", headers, body: JSON.stringify({ enabled: false }),
    });
    if (res.ok) actions.push(`Disabled workers.dev for ${scriptName}`);
  } catch { /* continue */ }

  // Remove custom domains
  try {
    const res = await fetch(`${baseUrl}/workers/domains?service=${scriptName}`, { headers });
    if (res.ok) {
      const data = await res.json() as any;
      for (const domain of data.result || []) {
        await fetch(`${baseUrl}/workers/domains/${domain.id}`, { method: "DELETE", headers });
        actions.push(`Removed domain ${domain.hostname}`);
      }
    }
  } catch { /* continue */ }

  return actions.join("; ") || "No actions taken";
}

// ─── Report to Guardian API ─────────────────────────────────────────────────

async function reportToGuardian(env: Env, result: CheckResult): Promise<void> {
  if (!env.GUARDIAN_API_KEY || !env.GUARDIAN_API_URL) return;

  try {
    await fetch(`${env.GUARDIAN_API_URL}/agent/report`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${env.GUARDIAN_API_KEY}`,
        "X-Guardian-Agent": "cloudflare-edge",
      },
      body: JSON.stringify(result),
    });
  } catch {
    // Non-fatal — agent works independently even if Guardian API is down
  }
}

// ─── Main Check ─────────────────────────────────────────────────────────────

async function runCheck(env: Env): Promise<CheckResult> {
  const doThreshold = parseInt(env.DO_REQUEST_THRESHOLD || "1000000");
  const wallThreshold = parseFloat(env.DO_WALLTIME_HOURS_THRESHOLD || "100");
  const workerThreshold = parseInt(env.WORKER_REQUEST_THRESHOLD || "10000000");

  const { doServices, workerServices } = await queryUsage(env);

  // Merge metrics
  const serviceMap = new Map<string, ServiceMetrics>();

  for (const s of doServices) {
    const name = s.dimensions.scriptName;
    const requests = s.sum.requests;
    const wallHours = s.sum.wallTime / 1e6 / 3600;
    const cost = Math.max(0, (requests - 1_000_000)) * 0.15 / 1_000_000;

    serviceMap.set(name, {
      name, doRequests: requests, doWalltimeHours: wallHours,
      workerRequests: 0, estimatedDailyCostUSD: cost,
    });
  }

  for (const s of workerServices) {
    const name = s.dimensions.scriptName;
    const requests = s.sum.requests;
    const existing = serviceMap.get(name);
    const cost = Math.max(0, (requests - 10_000_000)) * 0.30 / 1_000_000;

    if (existing) {
      existing.workerRequests = requests;
      existing.estimatedDailyCostUSD += cost;
    } else {
      serviceMap.set(name, {
        name, doRequests: 0, doWalltimeHours: 0,
        workerRequests: requests, estimatedDailyCostUSD: cost,
      });
    }
  }

  const services = Array.from(serviceMap.values());
  const violations: string[] = [];
  const actionsTaken: string[] = [];

  for (const svc of services) {
    if (svc.doRequests > doThreshold) {
      violations.push(`${svc.name}: ${svc.doRequests.toLocaleString()} DO requests (threshold: ${doThreshold.toLocaleString()})`);
      const action = await disconnectWorker(env, svc.name);
      actionsTaken.push(action);
    }
    if (svc.doWalltimeHours > wallThreshold) {
      violations.push(`${svc.name}: ${svc.doWalltimeHours.toFixed(0)}h DO wall-time (threshold: ${wallThreshold}h)`);
    }
    if (svc.workerRequests > workerThreshold) {
      violations.push(`${svc.name}: ${svc.workerRequests.toLocaleString()} worker requests (threshold: ${workerThreshold.toLocaleString()})`);
      const action = await disconnectWorker(env, svc.name);
      actionsTaken.push(action);
    }
  }

  return {
    accountId: env.CLOUDFLARE_ACCOUNT_ID,
    checkedAt: Date.now(),
    services,
    totalEstimatedDailyCostUSD: services.reduce((sum, s) => sum + s.estimatedDailyCostUSD, 0),
    violations,
    actionsTaken,
  };
}

// ─── Worker Entry Points ────────────────────────────────────────────────────

export default {
  async scheduled(_event: ScheduledEvent, env: Env, _ctx: ExecutionContext): Promise<void> {
    const result = await runCheck(env);
    await reportToGuardian(env, result);

    if (result.violations.length > 0) {
      console.error(`[guardian-agent] ${result.violations.length} violation(s) detected!`);
      result.violations.forEach(v => console.error(`  - ${v}`));
      result.actionsTaken.forEach(a => console.error(`  Action: ${a}`));
    } else {
      console.error(`[guardian-agent] All clear. ${result.services.length} services checked.`);
    }
  },

  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // Auth: require GUARDIAN_API_KEY for non-health endpoints
    if (url.pathname !== "/") {
      const authHeader = request.headers.get("Authorization");
      if (env.GUARDIAN_API_KEY && authHeader !== `Bearer ${env.GUARDIAN_API_KEY}`) {
        return Response.json({ error: "Unauthorized" }, { status: 401 });
      }
    }

    if (url.pathname === "/check") {
      const result = await runCheck(env);
      await reportToGuardian(env, result);
      return Response.json({ status: "checked", ...result });
    }

    if (url.pathname === "/usage") {
      const { doServices, workerServices } = await queryUsage(env);
      return Response.json({ doServices, workerServices, timestamp: Date.now() });
    }

    return Response.json({
      service: "guardian-agent",
      mode: "edge-deployed",
      description: "Runs in your Cloudflare account. Your API token never leaves your infrastructure.",
      schedule: "every 5 minutes",
      endpoints: {
        "/": "Health check",
        "/check": "Run usage check and report to Guardian",
        "/usage": "View raw usage data",
      },
    });
  },
};
