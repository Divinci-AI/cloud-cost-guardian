/**
 * Neo4j Aura Provider
 *
 * Monitors Neo4j Aura database instances: memory, storage, instance count.
 * Supports AuraDB Free, Professional, and Enterprise tiers.
 *
 * Auth: OAuth2 client credentials (client_id + client_secret) → bearer token.
 * API: https://api.neo4j.io/v1
 *
 * Kill actions: pause-cluster (pause instance), scale-down (resize to min),
 *               delete (destroy instance).
 */

import type {
  CloudProvider,
  DecryptedCredential,
  ServiceUsage,
} from "../types.js";
import { evaluateViolations } from "../shared.js";

const TOKEN_URL = "https://api.neo4j.io/oauth/token";
const API_BASE = "https://api.neo4j.io/v1";

// ─── OAuth2 Token Exchange ───────────────────────────────────────────────

async function getAuraToken(clientId: string, clientSecret: string): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const basicAuth = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
    const resp = await fetch(TOKEN_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: `Basic ${basicAuth}`,
      },
      body: "grant_type=client_credentials",
      signal: controller.signal,
    });
    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      throw new Error(`Neo4j OAuth error ${resp.status}: ${text.slice(0, 200)}`);
    }
    const data = await resp.json() as { access_token: string };
    return data.access_token;
  } catch (err: any) {
    if (err.name === "AbortError") throw new Error("Neo4j OAuth timeout");
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

// ─── Aura API Helper ────────────────────────────────────────────────────

async function auraFetch(
  token: string,
  path: string,
  method = "GET",
  body?: any,
  timeoutMs = 15_000
): Promise<any> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(`${API_BASE}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      console.error(`[guardian] Neo4j Aura API error: ${resp.status}`, text.substring(0, 500));
      throw new Error(`Neo4j Aura API ${resp.status}: ${text.slice(0, 200)}`);
    }
    // Handle empty responses (202 Accepted, 204 No Content)
    const text = await resp.text();
    if (!text) return {};
    return JSON.parse(text);
  } catch (err: any) {
    if (err.name === "AbortError") throw new Error(`Neo4j Aura API timeout after ${timeoutMs}ms`);
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────

function getCredentials(credential: DecryptedCredential) {
  return {
    clientId: credential.neo4jClientId!,
    clientSecret: credential.neo4jClientSecret!,
    instanceId: credential.neo4jInstanceId,
  };
}

// Aura pricing estimates (USD/hour) by instance type
const AURA_HOURLY_PRICING: Record<string, number> = {
  "professional-db-1": 0.22,   // 1 CPU, 2 GB
  "professional-db-2": 0.44,   // 2 CPU, 4 GB
  "professional-db-4": 0.88,   // 4 CPU, 8 GB
  "professional-db-8": 1.76,   // 8 CPU, 16 GB
  "professional-db-16": 3.52,  // 16 CPU, 32 GB
  "enterprise-db-1": 0.35,
  "enterprise-db-2": 0.70,
  "enterprise-db-4": 1.40,
  "enterprise-db-8": 2.80,
  "enterprise-db-16": 5.60,
};

function estimateDailyCost(instance: any): number {
  // Try matching by type name
  const type = (instance.type || "").toLowerCase();
  const memory = instance.memory || "";

  // Check explicit pricing table
  for (const [key, rate] of Object.entries(AURA_HOURLY_PRICING)) {
    if (type.includes(key)) return rate * 24;
  }

  // Fallback: estimate by memory size
  const memGB = parseFloat(memory) || 0;
  if (memGB <= 0) return 0;  // Free tier
  return memGB * 0.11 * 24;  // ~$0.11/GB/hr for Professional
}

// ─── Provider Export ─────────────────────────────────────────────────────

export const neo4jProvider: CloudProvider = {
  id: "neo4j",
  name: "Neo4j Aura",

  async checkUsage(credential, thresholds) {
    const creds = getCredentials(credential);
    const token = await getAuraToken(creds.clientId, creds.clientSecret);

    // Fetch instances (scoped or all)
    let instances: any[];
    if (creds.instanceId) {
      const data = await auraFetch(token, `/instances/${creds.instanceId}`);
      instances = [data.data];
    } else {
      const data = await auraFetch(token, "/instances");
      instances = data.data || [];
    }

    const services: ServiceUsage[] = [];
    let totalDailyCost = 0;
    let runningCount = 0;

    for (const inst of instances) {
      const status = inst.status || "unknown";
      if (status === "running") runningCount++;

      const memoryGB = parseFloat(inst.memory || "0") || 0;
      const storageGB = parseFloat(inst.storage || "0") || 0;
      const dailyCost = status === "running" ? estimateDailyCost(inst) : 0;
      totalDailyCost += dailyCost;

      services.push({
        serviceName: `neo4j:${inst.id}`,
        metrics: [
          { name: "Memory", value: memoryGB, unit: "GB", thresholdKey: "neo4jMemoryGB" },
          { name: "Storage", value: storageGB, unit: "GB", thresholdKey: "neo4jStorageGB" },
          { name: "Status", value: status === "running" ? 1 : 0, unit: status, thresholdKey: "" },
          { name: "Type", value: 0, unit: `${inst.type || "unknown"} (${inst.cloud_provider || ""} ${inst.region || ""})`, thresholdKey: "" },
        ],
        estimatedDailyCostUSD: dailyCost,
      });
    }

    // Add instance count metric as a synthetic service
    if (instances.length > 1 || !creds.instanceId) {
      services.unshift({
        serviceName: "neo4j:summary",
        metrics: [
          { name: "Running Instances", value: runningCount, unit: "instances", thresholdKey: "neo4jInstanceCount" },
          { name: "Total Instances", value: instances.length, unit: "instances", thresholdKey: "" },
        ],
        estimatedDailyCostUSD: 0,
      });
    }

    const violations = evaluateViolations(services, thresholds, totalDailyCost, "neo4jDailyCostUSD", "neo4j-billing");

    return {
      provider: "neo4j",
      accountId: creds.instanceId || "neo4j-aura",
      checkedAt: Date.now(),
      services,
      totalEstimatedDailyCostUSD: totalDailyCost,
      violations,
      securityEvents: [],
    };
  },

  async executeKillSwitch(credential, serviceName, action) {
    const creds = getCredentials(credential);
    const token = await getAuraToken(creds.clientId, creds.clientSecret);
    const instanceId = serviceName.startsWith("neo4j:") ? serviceName.slice(6) : serviceName;

    if (instanceId === "summary") {
      return { success: false, action, serviceName, details: "Cannot execute action on summary — target a specific instance" };
    }

    switch (action) {
      case "pause-cluster": {
        try {
          await auraFetch(token, `/instances/${instanceId}/pause`, "POST");
          return { success: true, action, serviceName, details: `Neo4j Aura instance ${instanceId} paused` };
        } catch (err: any) {
          return { success: false, action, serviceName, details: err.message };
        }
      }

      case "scale-down": {
        try {
          // Resize to smallest Professional tier (2 GB memory — the AuraDB Professional minimum)
          await auraFetch(token, `/instances/${instanceId}`, "PATCH", { memory: "2GB" });
          return { success: true, action, serviceName, details: `Neo4j Aura instance ${instanceId} scaled down to 2GB memory (Professional minimum)` };
        } catch (err: any) {
          return { success: false, action, serviceName, details: err.message };
        }
      }

      case "delete": {
        try {
          await auraFetch(token, `/instances/${instanceId}`, "DELETE");
          return { success: true, action, serviceName, details: `Neo4j Aura instance ${instanceId} destroyed` };
        } catch (err: any) {
          return { success: false, action, serviceName, details: err.message };
        }
      }

      default:
        return { success: false, action, serviceName, details: `Action ${action} not supported for Neo4j Aura. Use: pause-cluster, scale-down, delete` };
    }
  },

  async validateCredential(credential) {
    if (!credential.neo4jClientId || !credential.neo4jClientSecret) {
      return { valid: false, error: "Missing Neo4j Aura API credentials (client ID + client secret)" };
    }

    try {
      const token = await getAuraToken(credential.neo4jClientId, credential.neo4jClientSecret);

      if (credential.neo4jInstanceId) {
        const data = await auraFetch(token, `/instances/${credential.neo4jInstanceId}`);
        const inst = data.data;
        return {
          valid: true,
          accountId: inst.id,
          accountName: `Neo4j Aura — ${inst.name || inst.id} (${inst.type || "unknown"}, ${inst.memory || "?"})`,
        };
      }

      const data = await auraFetch(token, "/instances");
      const count = (data.data || []).length;
      return {
        valid: true,
        accountId: "neo4j-aura",
        accountName: `Neo4j Aura (${count} instance${count !== 1 ? "s" : ""})`,
      };
    } catch (err: any) {
      return { valid: false, error: err.message };
    }
  },

  getDefaultThresholds() {
    return {
      neo4jInstanceCount: 3,        // Alert if more than 3 running instances
      neo4jMemoryGB: 8,             // Alert if any instance exceeds 8 GB
      neo4jStorageGB: 16,           // Alert if storage exceeds 16 GB
      neo4jDailyCostUSD: 20,        // Max daily spend
      monthlySpendLimitUSD: 600,
    };
  },
};
