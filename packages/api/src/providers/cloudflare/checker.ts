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
} from "../types.js";

const CF_API = "https://api.cloudflare.com/client/v4";
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
    throw new Error(`CF GraphQL parse error: ${text.substring(0, 200)}`);
  }

  if (data.errors) {
    throw new Error(`CF GraphQL error: ${JSON.stringify(data.errors)}`);
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

// ─── Provider Implementation ────────────────────────────────────────────────

export const cloudflareProvider: CloudProvider = {
  id: "cloudflare",
  name: "Cloudflare",

  async checkUsage(credential, thresholds): Promise<UsageResult> {
    const { apiToken, accountId } = credential;
    if (!apiToken || !accountId) {
      throw new Error("Missing Cloudflare API token or account ID");
    }

    const doServices = await queryDOUsage(apiToken, accountId);
    const workerServices = await queryWorkerUsage(apiToken, accountId);

    // Merge — a worker can appear in both DO and Worker metrics
    const serviceMap = new Map<string, ServiceUsage>();
    for (const s of [...doServices, ...workerServices]) {
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

    if (action === "delete") {
      return deleteWorker(apiToken, accountId, serviceName);
    }
    return disconnectWorker(apiToken, accountId, serviceName);
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

  getDefaultThresholds(): ThresholdConfig {
    return {
      doRequestsPerDay: 1_000_000,
      doWalltimeHoursPerDay: 100,
      workerRequestsPerDay: 10_000_000,
    };
  },
};
