/**
 * Cloudflare Billing Kill Switch
 *
 * A Cloudflare Worker that monitors usage metrics and automatically disconnects
 * runaway workers before they generate surprise bills. Born from an $80K
 * Durable Objects bill.
 *
 * Features:
 * - Monitors Durable Object requests, wall-time, and Worker request volume
 * - Auto-disconnects offending workers (reversible — removes routes, not code)
 * - Alerts via PagerDuty, Discord, Slack, or custom webhooks
 * - Protected workers list to prevent killing critical infrastructure
 * - Configurable thresholds via environment variables
 * - Manual check endpoint for testing
 *
 * @see https://github.com/AiExpanse/cloudflare-billing-kill-switch
 * @license MIT
 */

interface Env {
  // Required secrets (set via `wrangler secret put`)
  CLOUDFLARE_API_TOKEN: string;
  CLOUDFLARE_ACCOUNT_ID: string;

  // Alert destinations (at least one recommended)
  PAGERDUTY_ROUTING_KEY?: string;  // Events API v2 integration key
  DISCORD_WEBHOOK_URL?: string;    // Discord channel webhook URL
  SLACK_WEBHOOK_URL?: string;      // Slack incoming webhook URL
  CUSTOM_WEBHOOK_URL?: string;     // Any HTTP endpoint that accepts POST JSON

  // Thresholds (configurable via wrangler.toml [vars])
  DO_REQUEST_THRESHOLD: string;           // Daily DO requests before alerting
  DO_WALLTIME_HOURS_THRESHOLD: string;    // Daily DO wall-time hours before alerting
  WORKER_REQUEST_THRESHOLD: string;       // Daily Worker requests before alerting

  // Kill switch behavior
  AUTO_DISCONNECT: string;   // "true" to auto-disconnect routes (reversible)
  AUTO_DELETE: string;       // "true" to auto-delete workers (nuclear, irreversible)
  PROTECTED_WORKERS: string; // Comma-separated worker names to never kill

  ENVIRONMENT: string;
}

interface DOUsage {
  scriptName: string;
  requests: number;
  wallTimeHours: number;
}

interface WorkerUsage {
  scriptName: string;
  requests: number;
  errors: number;
  cpuTimeMs: number;
}

interface CheckResult {
  violations: string[];
  actions: string[];
  doUsage: DOUsage[];
  workerUsage: WorkerUsage[];
}

// ─── Cloudflare GraphQL Analytics ───────────────────────────────────────────

async function queryDOUsage(env: Env): Promise<DOUsage[]> {
  const today = new Date().toISOString().split("T")[0];
  const query = `{
    viewer {
      accounts(filter: {accountTag: "${env.CLOUDFLARE_ACCOUNT_ID.replace(/[^a-zA-Z0-9-]/g, "")}"}) {
        durableObjectsInvocationsAdaptiveGroups(
          limit: 50,
          filter: {date_geq: "${today}"},
          orderBy: [sum_requests_DESC]
        ) {
          dimensions { scriptName }
          sum { requests wallTime }
        }
      }
    }
  }`;

  const data = await cfGraphQL(env, query);
  const groups = data?.data?.viewer?.accounts?.[0]?.durableObjectsInvocationsAdaptiveGroups ?? [];
  return groups.map((g: any) => ({
    scriptName: g.dimensions.scriptName,
    requests: g.sum.requests,
    wallTimeHours: g.sum.wallTime / 1e6 / 3600, // microseconds to hours
  }));
}

async function queryWorkerUsage(env: Env): Promise<WorkerUsage[]> {
  const today = new Date().toISOString().split("T")[0];
  const query = `{
    viewer {
      accounts(filter: {accountTag: "${env.CLOUDFLARE_ACCOUNT_ID.replace(/[^a-zA-Z0-9-]/g, "")}"}) {
        workersInvocationsAdaptive(
          limit: 50,
          filter: {date_geq: "${today}"},
          orderBy: [sum_requests_DESC]
        ) {
          dimensions { scriptName }
          sum { requests errors wallTime }
        }
      }
    }
  }`;

  const data = await cfGraphQL(env, query);
  const groups = data?.data?.viewer?.accounts?.[0]?.workersInvocationsAdaptive ?? [];
  return groups.map((g: any) => ({
    scriptName: g.dimensions.scriptName,
    requests: g.sum.requests,
    errors: g.sum.errors,
    cpuTimeMs: g.sum.wallTime / 1000,
  }));
}

async function cfGraphQL(env: Env, query: string): Promise<any> {
  const res = await fetch("https://api.cloudflare.com/client/v4/graphql", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${env.CLOUDFLARE_API_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query }),
  });

  const text = await res.text();
  let data: any;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`CF GraphQL parse error: ${text.substring(0, 200)}`);
  }

  if (data.errors) {
    throw new Error(`CF GraphQL error: ${JSON.stringify(data.errors)}`);
  }
  return data;
}

// ─── Worker Kill Switch ─────────────────────────────────────────────────────

async function disconnectWorker(env: Env, scriptName: string): Promise<string[]> {
  const actions: string[] = [];
  const baseUrl = `https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}`;
  const headers = {
    "Authorization": `Bearer ${env.CLOUDFLARE_API_TOKEN}`,
    "Content-Type": "application/json",
  };

  // 1. Disable workers.dev subdomain
  try {
    const res = await fetch(`${baseUrl}/workers/scripts/${scriptName}/subdomain`, {
      method: "POST",
      headers,
      body: JSON.stringify({ enabled: false }),
    });
    if (res.ok) {
      actions.push(`Disabled workers.dev subdomain for ${scriptName}`);
    } else {
      const text = await res.text();
      actions.push(`Failed to disable subdomain: ${res.status} ${text.substring(0, 100)}`);
    }
  } catch (e) {
    actions.push(`Error disabling subdomain: ${e}`);
  }

  // 2. Get and remove custom domains
  try {
    const res = await fetch(`${baseUrl}/workers/domains?service=${scriptName}`, { headers });
    if (res.ok) {
      const responseText = await res.text();
      let data: any;
      try {
        data = JSON.parse(responseText);
      } catch {
        actions.push(`Failed to parse domains response: ${responseText.substring(0, 100)}`);
        return actions;
      }
      for (const domain of data.result || []) {
        const delRes = await fetch(`${baseUrl}/workers/domains/${domain.id}`, {
          method: "DELETE",
          headers,
        });
        if (delRes.ok) {
          actions.push(`Removed custom domain ${domain.hostname} from ${scriptName}`);
        }
      }
    }
  } catch (e) {
    actions.push(`Error removing domains: ${e}`);
  }

  return actions;
}

async function deleteWorker(env: Env, scriptName: string): Promise<string> {
  const res = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/workers/scripts/${scriptName}?force=true`,
    {
      method: "DELETE",
      headers: { "Authorization": `Bearer ${env.CLOUDFLARE_API_TOKEN}` },
    }
  );
  if (res.ok) {
    return `DELETED worker ${scriptName}`;
  }
  const text = await res.text();
  return `Failed to delete ${scriptName}: ${res.status} ${text.substring(0, 100)}`;
}

// ─── Alerting ───────────────────────────────────────────────────────────────

async function sendAlerts(
  env: Env,
  summary: string,
  severity: "critical" | "error" | "warning" | "info",
  details: Record<string, unknown>,
  dedupSuffix = ""
): Promise<void> {
  const promises: Promise<void>[] = [];

  if (env.PAGERDUTY_ROUTING_KEY) {
    promises.push(alertPagerDuty(env, summary, severity, details, dedupSuffix));
  }
  if (env.DISCORD_WEBHOOK_URL) {
    promises.push(alertDiscord(env, summary, severity, details));
  }
  if (env.SLACK_WEBHOOK_URL) {
    promises.push(alertSlack(env, summary, severity, details));
  }
  if (env.CUSTOM_WEBHOOK_URL) {
    promises.push(alertCustomWebhook(env, summary, severity, details));
  }

  if (promises.length === 0) {
    console.error("[kill-switch] WARNING: No alert destinations configured. Set at least one of: PAGERDUTY_ROUTING_KEY, DISCORD_WEBHOOK_URL, SLACK_WEBHOOK_URL, CUSTOM_WEBHOOK_URL");
  }

  await Promise.allSettled(promises);
}

async function alertPagerDuty(
  env: Env,
  summary: string,
  severity: "critical" | "error" | "warning" | "info",
  details: Record<string, unknown>,
  dedupSuffix = ""
): Promise<void> {
  const dedup = `cf-billing-${new Date().toISOString().split("T")[0]}${dedupSuffix ? `-${dedupSuffix}` : ""}`;

  const res = await fetch("https://events.pagerduty.com/v2/enqueue", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      routing_key: env.PAGERDUTY_ROUTING_KEY,
      event_action: "trigger",
      dedup_key: dedup,
      payload: {
        summary,
        source: "cloudflare-billing-kill-switch",
        severity,
        component: "cloudflare-workers",
        group: env.ENVIRONMENT || "production",
        class: "billing",
        custom_details: details,
      },
      client: "Cloudflare Billing Kill Switch",
      client_url: "https://dash.cloudflare.com",
    }),
  });

  if (!res.ok) {
    console.error(`[kill-switch] PagerDuty error: ${res.status} ${await res.text()}`);
  }
}

async function alertDiscord(
  env: Env,
  summary: string,
  severity: "critical" | "error" | "warning" | "info",
  details: Record<string, unknown>
): Promise<void> {
  const colorMap = { critical: 0xFF0000, error: 0xFF6600, warning: 0xFFCC00, info: 0x0099FF };

  const res = await fetch(env.DISCORD_WEBHOOK_URL!, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      embeds: [{
        title: `Cloudflare Billing Alert [${severity.toUpperCase()}]`,
        description: summary,
        color: colorMap[severity],
        fields: Object.entries(details).slice(0, 10).map(([key, value]) => ({
          name: key,
          value: typeof value === "string" ? value : JSON.stringify(value).substring(0, 200),
          inline: false,
        })),
        timestamp: new Date().toISOString(),
      }],
    }),
  });

  if (!res.ok) {
    console.error(`[kill-switch] Discord error: ${res.status} ${await res.text()}`);
  }
}

async function alertSlack(
  env: Env,
  summary: string,
  severity: "critical" | "error" | "warning" | "info",
  details: Record<string, unknown>
): Promise<void> {
  const emojiMap = { critical: ":rotating_light:", error: ":warning:", warning: ":large_yellow_circle:", info: ":information_source:" };

  const res = await fetch(env.SLACK_WEBHOOK_URL!, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      text: `${emojiMap[severity]} *Cloudflare Billing Alert [${severity.toUpperCase()}]*\n${summary}`,
      blocks: [
        {
          type: "section",
          text: { type: "mrkdwn", text: `${emojiMap[severity]} *Cloudflare Billing Alert [${severity.toUpperCase()}]*\n${summary}` },
        },
        {
          type: "section",
          text: { type: "mrkdwn", text: "```" + JSON.stringify(details, null, 2).substring(0, 2500) + "```" },
        },
      ],
    }),
  });

  if (!res.ok) {
    console.error(`[kill-switch] Slack error: ${res.status} ${await res.text()}`);
  }
}

async function alertCustomWebhook(
  env: Env,
  summary: string,
  severity: "critical" | "error" | "warning" | "info",
  details: Record<string, unknown>
): Promise<void> {
  const res = await fetch(env.CUSTOM_WEBHOOK_URL!, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ summary, severity, details, timestamp: new Date().toISOString(), source: "cloudflare-billing-kill-switch" }),
  });

  if (!res.ok) {
    console.error(`[kill-switch] Custom webhook error: ${res.status}`);
  }
}

// ─── Main Check ─────────────────────────────────────────────────────────────

async function checkUsage(env: Env): Promise<CheckResult> {
  const doReqThreshold = parseInt(env.DO_REQUEST_THRESHOLD || "1000000");
  const doWallThreshold = parseFloat(env.DO_WALLTIME_HOURS_THRESHOLD || "100");
  const workerReqThreshold = parseInt(env.WORKER_REQUEST_THRESHOLD || "10000000");
  const autoDisconnect = env.AUTO_DISCONNECT === "true";
  const autoDelete = env.AUTO_DELETE === "true";
  const protectedWorkers = (env.PROTECTED_WORKERS || "").split(",").map(s => s.trim()).filter(Boolean);

  const violations: string[] = [];
  const actions: string[] = [];

  // Check DO usage
  console.error("[kill-switch] Checking Durable Object usage...");
  const doUsage = await queryDOUsage(env);

  for (const usage of doUsage) {
    const reqExceeded = usage.requests > doReqThreshold;
    const wallExceeded = usage.wallTimeHours > doWallThreshold;

    if (reqExceeded || wallExceeded) {
      const msg = `DO THRESHOLD EXCEEDED: ${usage.scriptName} - ${usage.requests.toLocaleString()} reqs, ${usage.wallTimeHours.toFixed(0)}h wall-time`;
      violations.push(msg);
      console.error(`[kill-switch] ${msg}`);

      if (protectedWorkers.includes(usage.scriptName)) {
        actions.push(`PROTECTED: ${usage.scriptName} exceeded threshold but is protected`);
        continue;
      }

      if (autoDelete) {
        const result = await deleteWorker(env, usage.scriptName);
        actions.push(result);
      } else if (autoDisconnect) {
        const results = await disconnectWorker(env, usage.scriptName);
        actions.push(...results);
      }
    } else {
      console.error(`[kill-switch] ${usage.scriptName}: ${usage.requests.toLocaleString()} reqs - ok`);
    }
  }

  // Check Worker request volume (catch feedback loops)
  console.error("[kill-switch] Checking Worker request volumes...");
  const workerUsage = await queryWorkerUsage(env);

  for (const usage of workerUsage) {
    if (usage.requests > workerReqThreshold) {
      const msg = `WORKER REQUEST SPIKE: ${usage.scriptName} - ${usage.requests.toLocaleString()} reqs today`;
      violations.push(msg);
      console.error(`[kill-switch] ${msg}`);

      if (protectedWorkers.includes(usage.scriptName)) {
        actions.push(`PROTECTED: ${usage.scriptName} request spike but is protected`);
        continue;
      }

      if (autoDisconnect) {
        const results = await disconnectWorker(env, usage.scriptName);
        actions.push(...results);
      }
    }
  }

  // Send alerts if any violations
  if (violations.length > 0) {
    await sendAlerts(
      env,
      `Cloudflare cost alert: ${violations.length} worker(s) exceeded thresholds`,
      "critical",
      {
        violations,
        actionsTaken: actions,
        autoDisconnect,
        autoDelete,
        thresholds: { doReqThreshold, doWallThreshold, workerReqThreshold },
        checkedAt: new Date().toISOString(),
      }
    );
  } else {
    console.error("[kill-switch] All usage within thresholds.");
  }

  return { violations, actions, doUsage, workerUsage };
}

// ─── Worker Entry Points ────────────────────────────────────────────────────

export default {
  async scheduled(_event: ScheduledEvent, env: Env, _ctx: ExecutionContext): Promise<void> {
    await checkUsage(env);
  },

  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // Auth: require ADMIN_SECRET for all non-health endpoints
    const adminSecret = (env as any).ADMIN_SECRET;
    if (adminSecret && url.pathname !== "/") {
      const authHeader = request.headers.get("Authorization");
      if (authHeader !== `Bearer ${adminSecret}`) {
        return Response.json({ error: "Unauthorized" }, { status: 401 });
      }
    }

    // Manual check trigger
    if (url.pathname === "/check") {
      const result = await checkUsage(env);
      return Response.json({ status: "checked", ...result, timestamp: new Date().toISOString() });
    }

    // Test alert integrations
    if (url.pathname === "/test-alert") {
      await sendAlerts(env, "Test alert from Cloudflare Billing Kill Switch", "info", {
        test: true,
        timestamp: new Date().toISOString(),
        message: "If you received this, your alert integration is working correctly.",
      }, "test");
      return Response.json({ status: "test alert sent" });
    }

    // Usage report (no alerts, just data)
    if (url.pathname === "/usage") {
      const doUsage = await queryDOUsage(env);
      const workerUsage = await queryWorkerUsage(env);
      return Response.json({
        doUsage,
        workerUsage: workerUsage.slice(0, 20), // top 20 by requests
        thresholds: {
          doRequests: parseInt(env.DO_REQUEST_THRESHOLD || "1000000"),
          doWalltimeHours: parseFloat(env.DO_WALLTIME_HOURS_THRESHOLD || "100"),
          workerRequests: parseInt(env.WORKER_REQUEST_THRESHOLD || "10000000"),
        },
        timestamp: new Date().toISOString(),
      });
    }

    // Health check
    return Response.json({
      service: "cloudflare-billing-kill-switch",
      status: "healthy",
      schedule: "every 6 hours",
      thresholds: {
        doRequests: parseInt(env.DO_REQUEST_THRESHOLD || "1000000"),
        doWalltimeHours: parseFloat(env.DO_WALLTIME_HOURS_THRESHOLD || "100"),
        workerRequests: parseInt(env.WORKER_REQUEST_THRESHOLD || "10000000"),
      },
      autoDisconnect: env.AUTO_DISCONNECT === "true",
      autoDelete: env.AUTO_DELETE === "true",
      protectedWorkers: (env.PROTECTED_WORKERS || "").split(",").filter(Boolean),
      alertDestinations: {
        pagerduty: !!env.PAGERDUTY_ROUTING_KEY,
        discord: !!env.DISCORD_WEBHOOK_URL,
        slack: !!env.SLACK_WEBHOOK_URL,
        customWebhook: !!env.CUSTOM_WEBHOOK_URL,
      },
      endpoints: {
        "/": "Health check (this page)",
        "/check": "Run usage check now (triggers alerts if thresholds exceeded)",
        "/usage": "View current usage data (no alerts)",
        "/test-alert": "Send a test alert to all configured destinations",
      },
    });
  },
};
