/**
 * Cloudflare Provider
 *
 * Monitors Cloudflare Workers, Durable Objects, and related services.
 * Extracted from the open-source billing-monitor kill switch.
 */

import type {
  CloudProvider,
  DecryptedCredential,
  ThresholdConfig,
  UsageResult,
  ActionResult,
  ValidationResult,
  ServiceUsage,
  Violation,
  MetricCategory,
} from "../types.js";

const CF_API = "https://api.cloudflare.com/client/v4";

// `cost` violations auto-disconnect; other categories alert-only by default.
const CLOUDFLARE_METRIC_CATEGORIES: Record<string, MetricCategory> = {
  doRequestsPerDay: "load",
  doWalltimeHoursPerDay: "load",
  workerRequestsPerDay: "load",
  r2OpsPerDay: "load",
  d1RowsReadPerDay: "load",
  d1RowsWrittenPerDay: "load",
  queueOpsPerDay: "load",
  streamMinutesPerDay: "load",
  argoGBPerDay: "load",
  r2StorageGB: "storage",
  // LLM/AI spend. Categorized "load" (not "cost") on purpose: it's genuinely a
  // cost runaway, but there's NO Cloudflare API to throttle Workers AI per-model
  // or to cap AI Gateway's upstream provider spend — so these are alert-only and
  // must not be in the default auto-kill set. Mitigation is in-app.
  aiNeuronsPerDay: "load",
  aiGatewayCostUSD: "load",
};
const CF_GRAPHQL = `${CF_API}/graphql`;

async function cfFetch(path: string, token: string, options: RequestInit = {}): Promise<Response> {
  return fetch(`${CF_API}${path}`, {
    ...options,
    headers: {
      "Authorization": `Bearer ${token}`,
      "Content-Type": "application/json",
      ...options.headers,
    },
  });
}

/**
 * Classified Cloudflare GraphQL error. `kind === "auth"` is the dangerous one:
 * a token missing `Account Analytics: Read` returns a 10000 "Authentication
 * error", and if that were swallowed the whole CF half would read EMPTY while
 * the operator believes they're protected (the silent-blindness bug, #9). Auth
 * errors must propagate so the account is flagged, never masked as "all clear".
 */
export class CfGraphQLError extends Error {
  constructor(message: string, public kind: "auth" | "rate-limit" | "graphql" | "parse" | "http") {
    super(message);
    this.name = "CfGraphQLError";
  }
}

async function cfGraphQL(token: string, accountId: string, query: string): Promise<any> {
  const res = await fetch(CF_GRAPHQL, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query }),
  });

  const text = await res.text();
  let data: any;
  try {
    data = JSON.parse(text);
  } catch {
    throw new CfGraphQLError(`CF GraphQL parse error: ${text.substring(0, 200)}`, "parse");
  }

  if (data.errors && data.errors.length) {
    const blob = JSON.stringify(data.errors);
    if (/\b10000\b|9106|9109|authentication error|not authorized|account analytics/i.test(blob)) {
      throw new CfGraphQLError(
        `Cloudflare analytics auth FAILING — the API token is missing 'Account Analytics: Read'. Monitoring is BLIND until fixed. ${blob.substring(0, 200)}`,
        "auth",
      );
    }
    if (/\b10429\b|rate.?limit|too many request/i.test(blob)) {
      throw new CfGraphQLError(`Cloudflare GraphQL rate-limited (10429): ${blob.substring(0, 200)}`, "rate-limit");
    }
    throw new CfGraphQLError(`CF GraphQL error: ${blob.substring(0, 300)}`, "graphql");
  }

  if (!res.ok) {
    throw new CfGraphQLError(`CF GraphQL HTTP ${res.status}: ${text.substring(0, 150)}`, "http");
  }
  return data;
}

async function queryDOUsage(token: string, accountId: string): Promise<ServiceUsage[]> {
  const today = new Date().toISOString().split("T")[0];
  const query = `{
    viewer {
      accounts(filter: {accountTag: "${accountId.replace(/[^a-zA-Z0-9-]/g, "")}"}) {
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

  const data = await cfGraphQL(token, accountId, query);
  const groups = data?.data?.viewer?.accounts?.[0]?.durableObjectsInvocationsAdaptiveGroups ?? [];

  return groups.map((g: any) => {
    const requests = g.sum.requests;
    const wallTimeHours = g.sum.wallTime / 1e6 / 3600;
    // DO pricing: $0.15/million requests + $12.50/million GB-seconds
    const requestCost = Math.max(0, (requests - 1_000_000)) * 0.15 / 1_000_000;

    return {
      serviceName: g.dimensions.scriptName,
      metrics: [
        { name: "DO Requests", value: requests, unit: "requests", thresholdKey: "doRequestsPerDay" },
        { name: "DO Wall Time", value: wallTimeHours, unit: "hours", thresholdKey: "doWalltimeHoursPerDay" },
      ],
      estimatedDailyCostUSD: requestCost,
    };
  });
}

async function queryWorkerUsage(token: string, accountId: string): Promise<ServiceUsage[]> {
  const today = new Date().toISOString().split("T")[0];
  const query = `{
    viewer {
      accounts(filter: {accountTag: "${accountId.replace(/[^a-zA-Z0-9-]/g, "")}"}) {
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

  const data = await cfGraphQL(token, accountId, query);
  const groups = data?.data?.viewer?.accounts?.[0]?.workersInvocationsAdaptive ?? [];

  return groups.map((g: any) => {
    const requests = g.sum.requests;
    const requestCost = Math.max(0, (requests - 10_000_000)) * 0.30 / 1_000_000;

    return {
      serviceName: g.dimensions.scriptName,
      metrics: [
        { name: "Worker Requests", value: requests, unit: "requests", thresholdKey: "workerRequestsPerDay" },
      ],
      estimatedDailyCostUSD: requestCost,
    };
  });
}

// ─── LLM / AI Usage Queries (#1 Workers AI, #2 AI Gateway) ──────────────────
// Today's scariest cost runaways — invisible to the CF Workers bill, and the
// biggest coverage gap in the product. Detect-and-alert only (no CF throttle API).

async function queryAIUsage(token: string, accountId: string): Promise<ServiceUsage[]> {
  const today = new Date().toISOString().split("T")[0];
  const query = `{
    viewer {
      accounts(filter: {accountTag: "${accountId.replace(/[^a-zA-Z0-9-]/g, "")}"}) {
        aiInferenceAdaptiveGroups(
          limit: 100,
          filter: {date_geq: "${today}"},
          orderBy: [sum_totalNeurons_DESC]
        ) {
          count
          dimensions { modelId }
          sum { totalNeurons totalInputTokens totalOutputTokens }
        }
      }
    }
  }`;

  try {
    const data = await cfGraphQL(token, accountId, query);
    const groups = data?.data?.viewer?.accounts?.[0]?.aiInferenceAdaptiveGroups ?? [];
    return groups.map((g: any) => {
      const neurons = g.sum.totalNeurons || 0;
      // Workers AI pricing: $0.011 per 1,000 Neurons
      const cost = (neurons / 1000) * 0.011;
      return {
        serviceName: `ai:${g.dimensions.modelId}`,
        metrics: [
          { name: "Workers AI Neurons", value: neurons, unit: "neurons", thresholdKey: "aiNeuronsPerDay" },
        ],
        estimatedDailyCostUSD: cost,
      };
    });
  } catch (e) {
    if (e instanceof CfGraphQLError && e.kind === "auth") throw e;
    return [];
  }
}

async function queryAIGatewayUsage(token: string, accountId: string): Promise<ServiceUsage[]> {
  const today = new Date().toISOString().split("T")[0];
  const query = `{
    viewer {
      accounts(filter: {accountTag: "${accountId.replace(/[^a-zA-Z0-9-]/g, "")}"}) {
        aiGatewayRequestsAdaptiveGroups(
          limit: 100,
          filter: {date_geq: "${today}"},
          orderBy: [sum_cost_DESC]
        ) {
          dimensions { gateway provider model }
          sum { cost erroredRequests cachedRequests }
        }
      }
    }
  }`;

  try {
    const data = await cfGraphQL(token, accountId, query);
    const groups = data?.data?.viewer?.accounts?.[0]?.aiGatewayRequestsAdaptiveGroups ?? [];
    return groups
      // sum.cost is $0 for the workers-ai provider (Neurons bill that separately,
      // counted in queryAIUsage) — skip to avoid double-counting / false zeros.
      .filter((g: any) => g.dimensions.provider !== "workers-ai")
      .map((g: any) => {
        const cost = g.sum.cost || 0;
        return {
          serviceName: `aigw:${g.dimensions.gateway}/${g.dimensions.provider}/${g.dimensions.model}`,
          metrics: [
            { name: "AI Gateway Upstream Cost", value: cost, unit: "USD", thresholdKey: "aiGatewayCostUSD" },
          ],
          estimatedDailyCostUSD: cost,
        };
      });
  } catch (e) {
    if (e instanceof CfGraphQLError && e.kind === "auth") throw e;
    return [];
  }
}

// ─── R2, D1, Queues, Stream Usage Queries ───────────────────────────────────

async function queryR2Usage(token: string, accountId: string): Promise<ServiceUsage[]> {
  // List R2 buckets
  const res = await cfFetch(`/accounts/${accountId}/r2/buckets`, token);
  if (!res.ok) return [];
  const text = await res.text();
  const data = JSON.parse(text);
  const buckets = data.result?.buckets ?? [];

  // Query R2 analytics via GraphQL
  const today = new Date().toISOString().split("T")[0];
  const query = `{
    viewer {
      accounts(filter: {accountTag: "${accountId.replace(/[^a-zA-Z0-9-]/g, "")}"}) {
        r2StorageAdaptiveGroups(
          limit: 50,
          filter: {date_geq: "${today}"}
        ) {
          dimensions { bucketName }
          sum { objectCount payloadSize uploadCount downloadCount }
        }
      }
    }
  }`;

  try {
    const gqlData = await cfGraphQL(token, accountId, query);
    const groups = gqlData?.data?.viewer?.accounts?.[0]?.r2StorageAdaptiveGroups ?? [];

    return groups.map((g: any) => {
      const ops = (g.sum.uploadCount || 0) + (g.sum.downloadCount || 0);
      const storageGB = (g.sum.payloadSize || 0) / (1024 * 1024 * 1024);
      // R2 pricing: $0.015/GB/month storage, $4.50/M Class A ops, $0.36/M Class B ops
      const storageCost = storageGB * 0.015 / 30;
      const opsCost = ops * 4.50 / 1_000_000;

      return {
        serviceName: `r2:${g.dimensions.bucketName}`,
        metrics: [
          { name: "R2 Operations", value: ops, unit: "ops", thresholdKey: "r2OpsPerDay" },
          { name: "R2 Storage", value: storageGB, unit: "GB", thresholdKey: "r2StorageGB" },
        ],
        estimatedDailyCostUSD: storageCost + opsCost,
      };
    });
  } catch (e) {
    // Never mask analytics auth failure — that's the silent-blindness bug (#9).
    if (e instanceof CfGraphQLError && e.kind === "auth") throw e;
    // Otherwise degrade: return bucket list without detailed metrics
    return buckets.map((b: any) => ({
      serviceName: `r2:${b.name}`,
      metrics: [],
      estimatedDailyCostUSD: 0,
    }));
  }
}

async function queryD1Usage(token: string, accountId: string): Promise<ServiceUsage[]> {
  const res = await cfFetch(`/accounts/${accountId}/d1/database`, token);
  if (!res.ok) return [];
  const text = await res.text();
  const data = JSON.parse(text);
  const databases = data.result ?? [];

  const today = new Date().toISOString().split("T")[0];
  const query = `{
    viewer {
      accounts(filter: {accountTag: "${accountId.replace(/[^a-zA-Z0-9-]/g, "")}"}) {
        d1AnalyticsAdaptiveGroups(
          limit: 50,
          filter: {date_geq: "${today}"},
          orderBy: [sum_readQueries_DESC]
        ) {
          dimensions { databaseId }
          sum { readQueries writeQueries rowsRead rowsWritten }
        }
      }
    }
  }`;

  try {
    const gqlData = await cfGraphQL(token, accountId, query);
    const groups = gqlData?.data?.viewer?.accounts?.[0]?.d1AnalyticsAdaptiveGroups ?? [];

    // Build a map of databaseId -> name from the REST API
    const dbNames = new Map(databases.map((db: any) => [db.uuid, db.name]));

    return groups.map((g: any) => {
      const rowsRead = g.sum.rowsRead || 0;
      const rowsWritten = g.sum.rowsWritten || 0;
      const dbName = dbNames.get(g.dimensions.databaseId) || g.dimensions.databaseId;
      // D1 pricing: $0.001/million rows read, $1.00/million rows written
      const cost = (rowsRead * 0.001 / 1_000_000) + (rowsWritten * 1.00 / 1_000_000);

      return {
        serviceName: `d1:${dbName}`,
        metrics: [
          { name: "D1 Rows Read", value: rowsRead, unit: "rows", thresholdKey: "d1RowsReadPerDay" },
          { name: "D1 Rows Written", value: rowsWritten, unit: "rows", thresholdKey: "d1RowsWrittenPerDay" },
        ],
        estimatedDailyCostUSD: cost,
      };
    });
  } catch (e) {
    if (e instanceof CfGraphQLError && e.kind === "auth") throw e;
    return [];
  }
}

async function queryQueuesUsage(token: string, accountId: string): Promise<ServiceUsage[]> {
  const res = await cfFetch(`/accounts/${accountId}/queues`, token);
  if (!res.ok) return [];
  const text = await res.text();
  const data = JSON.parse(text);
  const queues = data.result ?? [];

  // Queues don't have a GraphQL analytics endpoint yet — report queue existence
  // and let users set thresholds based on their expected usage
  return queues.map((q: any) => ({
    serviceName: `queue:${q.queue_name}`,
    metrics: [
      { name: "Queue Messages", value: q.messages || 0, unit: "messages", thresholdKey: "queueOpsPerDay" },
    ],
    estimatedDailyCostUSD: 0,
  }));
}

async function queryStreamUsage(token: string, accountId: string): Promise<ServiceUsage[]> {
  const services: ServiceUsage[] = [];

  // List live inputs
  const liveRes = await cfFetch(`/accounts/${accountId}/stream/live_inputs`, token);
  if (liveRes.ok) {
    const text = await liveRes.text();
    const data = JSON.parse(text);
    for (const input of data.result ?? []) {
      services.push({
        serviceName: `stream:${input.uid}`,
        metrics: [
          { name: "Live Input Status", value: input.status?.current?.state === "connected" ? 1 : 0, unit: "active", thresholdKey: "streamMinutesPerDay" },
        ],
        estimatedDailyCostUSD: 0,
      });
    }
  }

  // List stored videos for total minutes
  const videoRes = await cfFetch(`/accounts/${accountId}/stream?per_page=50`, token);
  if (videoRes.ok) {
    const text = await videoRes.text();
    const data = JSON.parse(text);
    const videos = data.result ?? [];
    const totalMinutes = videos.reduce((sum: number, v: any) => sum + (v.duration || 0) / 60, 0);
    // Stream pricing: $5.00/1000 minutes stored, $1.00/1000 minutes delivered
    if (totalMinutes > 0) {
      services.push({
        serviceName: `stream:stored-videos`,
        metrics: [
          { name: "Stream Minutes Stored", value: totalMinutes, unit: "minutes", thresholdKey: "streamMinutesPerDay" },
        ],
        estimatedDailyCostUSD: totalMinutes * 5.00 / 1000 / 30,
      });
    }
  }

  return services;
}

// ─── Kill Switch Actions ────────────────────────────────────────────────────

async function disconnectWorker(token: string, accountId: string, scriptName: string): Promise<ActionResult> {
  const actions: string[] = [];

  // Disable workers.dev subdomain
  try {
    const res = await cfFetch(
      `/accounts/${accountId}/workers/scripts/${scriptName}/subdomain`,
      token,
      { method: "POST", body: JSON.stringify({ enabled: false }) }
    );
    actions.push(res.ok ? `Disabled workers.dev for ${scriptName}` : `Failed to disable subdomain`);
  } catch (e) {
    actions.push(`Error: ${e}`);
  }

  // Remove custom domains
  try {
    const res = await cfFetch(`/accounts/${accountId}/workers/domains?service=${scriptName}`, token);
    if (res.ok) {
      const text = await res.text();
      const data = JSON.parse(text);
      for (const domain of data.result || []) {
        const delRes = await cfFetch(`/accounts/${accountId}/workers/domains/${domain.id}`, token, { method: "DELETE" });
        if (delRes.ok) {
          actions.push(`Removed domain ${domain.hostname}`);
        }
      }
    }
  } catch (e) {
    actions.push(`Error removing domains: ${e}`);
  }

  return {
    success: true,
    action: "disconnect",
    serviceName: scriptName,
    details: actions.join("; "),
  };
}

async function deleteWorker(token: string, accountId: string, scriptName: string): Promise<ActionResult> {
  const res = await cfFetch(
    `/accounts/${accountId}/workers/scripts/${scriptName}?force=true`,
    token,
    { method: "DELETE" }
  );

  return {
    success: res.ok,
    action: "delete",
    serviceName: scriptName,
    details: res.ok ? `Deleted ${scriptName}` : `Failed to delete: ${res.status}`,
  };
}

// ─── Extended Kill Switch Actions (R2, D1, Queues, Stream, Zones) ───────────

async function deleteR2Bucket(token: string, accountId: string, bucketName: string): Promise<ActionResult> {
  const res = await cfFetch(`/accounts/${accountId}/r2/buckets/${bucketName}`, token, { method: "DELETE" });
  return {
    success: res.ok,
    action: "delete",
    serviceName: `r2:${bucketName}`,
    details: res.ok ? `Deleted R2 bucket ${bucketName}` : `Failed to delete R2 bucket: ${res.status}`,
  };
}

async function deleteD1Database(token: string, accountId: string, dbId: string): Promise<ActionResult> {
  const res = await cfFetch(`/accounts/${accountId}/d1/database/${dbId}`, token, { method: "DELETE" });
  return {
    success: res.ok,
    action: "delete",
    serviceName: `d1:${dbId}`,
    details: res.ok ? `Deleted D1 database ${dbId}` : `Failed to delete D1 database: ${res.status}`,
  };
}

async function deleteQueue(token: string, accountId: string, queueName: string): Promise<ActionResult> {
  const res = await cfFetch(`/accounts/${accountId}/queues/${queueName}`, token, { method: "DELETE" });
  return {
    success: res.ok,
    action: "delete",
    serviceName: `queue:${queueName}`,
    details: res.ok ? `Deleted queue ${queueName}` : `Failed to delete queue: ${res.status}`,
  };
}

async function disableLiveInput(token: string, accountId: string, inputId: string): Promise<ActionResult> {
  const res = await cfFetch(
    `/accounts/${accountId}/stream/live_inputs/${inputId}`,
    token,
    { method: "PUT", body: JSON.stringify({ enabled: false }) }
  );
  return {
    success: res.ok,
    action: "disconnect",
    serviceName: `stream:${inputId}`,
    details: res.ok ? `Disabled live input ${inputId}` : `Failed to disable live input: ${res.status}`,
  };
}

async function pauseZone(token: string, zoneId: string): Promise<ActionResult> {
  const res = await cfFetch(`/zones/${zoneId}`, token, {
    method: "PATCH",
    body: JSON.stringify({ paused: true }),
  });
  return {
    success: res.ok,
    action: "pause-zone",
    serviceName: `zone:${zoneId}`,
    details: res.ok ? `Paused zone ${zoneId} — all proxy traffic stopped` : `Failed to pause zone: ${res.status}`,
  };
}

async function disableArgo(token: string, zoneId: string): Promise<ActionResult> {
  const res = await cfFetch(`/zones/${zoneId}/argo/smart_routing`, token, {
    method: "PATCH",
    body: JSON.stringify({ value: "off" }),
  });
  return {
    success: res.ok,
    action: "disconnect",
    serviceName: `zone:${zoneId}`,
    details: res.ok ? `Disabled Argo Smart Routing on zone ${zoneId}` : `Failed to disable Argo: ${res.status}`,
  };
}

// ─── Provider Implementation ────────────────────────────────────────────────

export const cloudflareProvider: CloudProvider = {
  id: "cloudflare",
  name: "Cloudflare",

  async checkUsage(credential, thresholds): Promise<UsageResult> {
    const { apiToken, accountId } = credential;
    if (!apiToken || !accountId) {
      throw new Error("Missing Cloudflare API token or account ID");
    }

    const [doServices, workerServices, r2Services, d1Services, queueServices, streamServices, aiServices, aiGatewayServices] = await Promise.all([
      queryDOUsage(apiToken, accountId),
      queryWorkerUsage(apiToken, accountId),
      queryR2Usage(apiToken, accountId),
      queryD1Usage(apiToken, accountId),
      queryQueuesUsage(apiToken, accountId),
      queryStreamUsage(apiToken, accountId),
      queryAIUsage(apiToken, accountId),
      queryAIGatewayUsage(apiToken, accountId),
    ]);

    // Merge — a worker can appear in both DO and Worker metrics
    const serviceMap = new Map<string, ServiceUsage>();
    for (const s of [...doServices, ...workerServices, ...r2Services, ...d1Services, ...queueServices, ...streamServices, ...aiServices, ...aiGatewayServices]) {
      const existing = serviceMap.get(s.serviceName);
      if (existing) {
        existing.metrics.push(...s.metrics);
        existing.estimatedDailyCostUSD += s.estimatedDailyCostUSD;
      } else {
        serviceMap.set(s.serviceName, { ...s });
      }
    }

    const services = Array.from(serviceMap.values());
    const violations: Violation[] = [];

    for (const service of services) {
      for (const metric of service.metrics) {
        const threshold = thresholds[metric.thresholdKey];
        if (threshold !== undefined && metric.value > threshold) {
          violations.push({
            serviceName: service.serviceName,
            metricName: metric.name,
            currentValue: metric.value,
            threshold,
            unit: metric.unit,
            severity: metric.value > threshold * 2 ? "critical" : "warning",
            category: CLOUDFLARE_METRIC_CATEGORIES[metric.thresholdKey],
          });
        }
      }
    }

    return {
      provider: "cloudflare",
      accountId,
      checkedAt: Date.now(),
      services,
      totalEstimatedDailyCostUSD: services.reduce((sum, s) => sum + s.estimatedDailyCostUSD, 0),
      violations,
      securityEvents: [],
    };
  },

  async executeKillSwitch(credential, serviceName, action): Promise<ActionResult> {
    const { apiToken, accountId } = credential;
    if (!apiToken || !accountId) {
      throw new Error("Missing Cloudflare credentials");
    }

    // Route by service type prefix
    const [serviceType, ...rest] = serviceName.split(":");
    const serviceId = rest.join(":");

    // Zone-level actions
    if (action === "pause-zone") {
      return pauseZone(apiToken, serviceId || serviceName);
    }

    // Workers AI / AI Gateway are alert-only: there's no Cloudflare API to
    // throttle per-model inference or cap upstream provider spend. Return a
    // non-success result rather than attempting a bogus worker disconnect.
    if (serviceType === "ai" || serviceType === "aigw") {
      return {
        success: false,
        action,
        serviceName,
        details: "Workers AI / AI Gateway spend cannot be throttled via the Cloudflare API — alert-only. Mitigate in-app (drop the model from the fallback chain) or set an account spend limit.",
      };
    }

    // Service-specific kill actions
    switch (serviceType) {
      case "r2":
        return deleteR2Bucket(apiToken, accountId, serviceId);
      case "d1":
        return deleteD1Database(apiToken, accountId, serviceId);
      case "queue":
        return deleteQueue(apiToken, accountId, serviceId);
      case "stream":
        return disableLiveInput(apiToken, accountId, serviceId);
      case "zone":
        if (action === "disconnect") return disableArgo(apiToken, serviceId);
        return pauseZone(apiToken, serviceId);
      default:
        // Workers & Durable Objects (original behavior)
        if (action === "delete") {
          return deleteWorker(apiToken, accountId, serviceName);
        }
        return disconnectWorker(apiToken, accountId, serviceName);
    }
  },

  async validateCredential(credential): Promise<ValidationResult> {
    const { apiToken, accountId } = credential;
    if (!apiToken || !accountId) {
      return { valid: false, error: "Missing API token or account ID" };
    }

    try {
      const res = await cfFetch(`/accounts/${accountId}`, apiToken);
      if (!res.ok) {
        const text = await res.text();
        return { valid: false, error: `API returned ${res.status}: ${text.substring(0, 100)}` };
      }

      const text = await res.text();
      const data = JSON.parse(text);
      const account = data.result;

      return {
        valid: true,
        accountId: account.id,
        accountName: account.name,
      };
    } catch (e) {
      return { valid: false, error: `Connection failed: ${e}` };
    }
  },

  async checkHealth(credential): Promise<{ healthy: boolean; reason?: string }> {
    const { apiToken } = credential;
    if (!apiToken) return { healthy: false, reason: "missing-token" };
    // /tokens/verify is the canonical Cloudflare API liveness probe. If it
    // 5xx's or times out, the API surface we'd use to fire kills is also
    // suspect — better to skip than fire blind.
    try {
      const res = await cfFetch(`/user/tokens/verify`, apiToken);
      if (!res.ok) return { healthy: false, reason: `cf-verify ${res.status}` };
      return { healthy: true };
    } catch (e: any) {
      return { healthy: false, reason: `cf-verify error: ${e.message}` };
    }
  },

  getDefaultThresholds(): ThresholdConfig {
    return {
      doRequestsPerDay: 1_000_000,
      doWalltimeHoursPerDay: 100,
      workerRequestsPerDay: 10_000_000,
      r2OpsPerDay: 10_000_000,
      r2StorageGB: 10,
      d1RowsReadPerDay: 5_000_000,
      d1RowsWrittenPerDay: 1_000_000,
      queueOpsPerDay: 1_000_000,
      streamMinutesPerDay: 10_000,
      argoGBPerDay: 100,
      aiNeuronsPerDay: 500_000,   // ~$5.50/day @ $0.011/1k Neurons
      aiGatewayCostUSD: 10,       // upstream LLM $/day routed through AI Gateway
    };
  },
};
