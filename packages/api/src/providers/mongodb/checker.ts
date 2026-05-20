/**
 * MongoDB Provider
 *
 * Monitors MongoDB instances across two sub-types:
 * - MongoDB Atlas — REST API management
 * - Self-hosted — direct mongodb:// connection
 *
 * Kill actions: kill-connections, isolate, scale-down, pause-cluster, delete.
 */

import { createHash, randomBytes } from "node:crypto";
import type {
  CloudProvider,
  DecryptedCredential,
  ThresholdConfig,
  UsageResult,
  ActionResult,
  ValidationResult,
  ServiceUsage,
  Violation,
  MongoDBSubType,
} from "../types.js";

// ─── SSRF Protection ──────────────────────────────────────────────────────

function validateConnectionUrl(uri: string, protocol: string): void {
  let parsed: URL;
  try {
    // mongodb+srv:// doesn't parse as URL natively, extract host
    const hostMatch = uri.match(/:\/\/(?:[^@]+@)?([^/:?]+)/);
    if (!hostMatch) throw new Error("Cannot parse host");
    const host = hostMatch[1].toLowerCase();
    if (
      host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "0.0.0.0" ||
      host.startsWith("10.") || host.startsWith("192.168.") ||
      /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
      host.startsWith("169.254.") ||
      host === "metadata.google.internal" ||
      host.endsWith(".internal")
    ) {
      throw new Error("Connections to private/internal network addresses are not allowed");
    }
  } catch (e: any) {
    if (e.message.includes("private") || e.message.includes("internal")) throw e;
    throw new Error(`Invalid ${protocol} connection URI format`);
  }
}

// ─── Credential Helpers ───────────────────────────────────────────────────

interface MongoDBCreds {
  subType: MongoDBSubType;
  // Atlas
  atlasPublicKey?: string;
  atlasPrivateKey?: string;
  atlasProjectId?: string;
  clusterName?: string;
  // Self-hosted
  mongodbUri?: string;
  databaseName?: string;
}

function getMongoDBCredentials(credential: DecryptedCredential): MongoDBCreds {
  const subType = credential.mongodbSubType || "self-hosted";
  return {
    subType,
    atlasPublicKey: credential.atlasPublicKey,
    atlasPrivateKey: credential.atlasPrivateKey,
    atlasProjectId: credential.atlasProjectId,
    clusterName: credential.atlasClusterName,
    mongodbUri: credential.mongodbUri,
    databaseName: credential.mongodbDatabaseName,
  };
}

// ─── Atlas API ────────────────────────────────────────────────────────────

const ATLAS_BASE = "https://cloud.mongodb.com/api/atlas/v2";

// MongoDB Atlas REST API requires HTTP Digest auth, not Basic.
// Basic returns 401 "You are not authorized for this resource."
// We hand-roll the digest handshake here so we don't take an extra
// dependency. RFC 7616 §3.4; Atlas uses qop=auth with MD5.
function parseDigestChallenge(headerValue: string): Record<string, string> {
  const out: Record<string, string> = {};
  // header looks like: Digest realm="MMS Public API", nonce="abc", qop="auth", algorithm=MD5, opaque="xyz"
  const stripped = headerValue.replace(/^Digest\s+/i, "");
  for (const part of stripped.split(/,\s*(?=[A-Za-z][A-Za-z0-9_-]*=)/)) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    const k = part.slice(0, eq).trim();
    let v = part.slice(eq + 1).trim();
    if (v.startsWith("\"") && v.endsWith("\"")) v = v.slice(1, -1);
    out[k.toLowerCase()] = v;
  }
  return out;
}

function md5(s: string): string {
  return createHash("md5").update(s).digest("hex");
}

function buildDigestAuthorization(
  username: string,
  password: string,
  method: string,
  uri: string,
  challenge: Record<string, string>,
): string {
  const realm = challenge.realm || "";
  const nonce = challenge.nonce || "";
  const qop = challenge.qop || "auth";
  const opaque = challenge.opaque;
  const algorithm = (challenge.algorithm || "MD5").toUpperCase();
  if (!algorithm.startsWith("MD5")) {
    throw new Error(`Atlas Digest algorithm not supported: ${algorithm}`);
  }
  const nc = "00000001";
  const cnonce = randomBytes(8).toString("hex");
  const ha1 = md5(`${username}:${realm}:${password}`);
  const ha2 = md5(`${method}:${uri}`);
  const response = md5(`${ha1}:${nonce}:${nc}:${cnonce}:${qop}:${ha2}`);

  const parts = [
    `username="${username}"`,
    `realm="${realm}"`,
    `nonce="${nonce}"`,
    `uri="${uri}"`,
    `qop=${qop}`,
    `nc=${nc}`,
    `cnonce="${cnonce}"`,
    `response="${response}"`,
    `algorithm=${algorithm}`,
  ];
  if (opaque) parts.push(`opaque="${opaque}"`);
  return `Digest ${parts.join(", ")}`;
}

async function atlasRequest(creds: MongoDBCreds, method: string, path: string, body?: any): Promise<any> {
  const url = `${ATLAS_BASE}/groups/${creds.atlasProjectId}${path}`;
  const uriPath = new URL(url).pathname + new URL(url).search;
  const accept = "application/vnd.atlas.2023-11-15+json";
  const bodyStr = body ? JSON.stringify(body) : undefined;
  const baseHeaders: Record<string, string> = {
    "Content-Type": "application/json",
    "Accept": accept,
  };

  // Round 1: unauthenticated request to extract the WWW-Authenticate challenge.
  const challengeResp = await fetch(url, { method, headers: baseHeaders, body: bodyStr });
  if (challengeResp.ok) {
    // Some endpoints don't require auth — return immediately if 200.
    return challengeResp.json();
  }
  if (challengeResp.status !== 401) {
    const text = await challengeResp.text();
    console.error(`[guardian] Atlas API error: ${challengeResp.status}`, text.substring(0, 500));
    throw new Error(`Atlas API error: ${challengeResp.status}`);
  }
  const wwwAuth = challengeResp.headers.get("www-authenticate");
  if (!wwwAuth) {
    throw new Error("Atlas API returned 401 without WWW-Authenticate header");
  }
  const challenge = parseDigestChallenge(wwwAuth);

  // Round 2: retry with computed Digest response.
  const authHeader = buildDigestAuthorization(
    creds.atlasPublicKey!, creds.atlasPrivateKey!, method, uriPath, challenge,
  );
  const resp = await fetch(url, {
    method,
    headers: { ...baseHeaders, "Authorization": authHeader },
    body: bodyStr,
  });

  if (!resp.ok) {
    const text = await resp.text();
    console.error(`[guardian] Atlas API error: ${resp.status}`, text.substring(0, 500));
    throw new Error(`Atlas API error: ${resp.status}`);
  }

  return resp.json();
}

// ─── Atlas Monitoring ─────────────────────────────────────────────────────

async function checkAtlas(creds: MongoDBCreds): Promise<ServiceUsage[]> {
  // Get cluster info
  const cluster = await atlasRequest(creds, "GET", `/clusters/${creds.clusterName}`);

  const tier = cluster.providerSettings?.instanceSizeName || cluster.clusterType || "unknown";
  const paused = cluster.paused || false;
  const storageGB = (cluster.diskSizeGB || 0);

  // Get process metrics (connections, ops)
  let connections = 0;
  let opsPerSec = 0;
  try {
    const processes = await atlasRequest(creds, "GET", `/processes`);
    const primaryProcess = processes.results?.find((p: any) => p.typeName === "REPLICA_PRIMARY") || processes.results?.[0];

    if (primaryProcess) {
      const hostId = `${primaryProcess.hostname}:${primaryProcess.port}`;
      const now = new Date();
      const fiveMinAgo = new Date(now.getTime() - 300000);

      // Get connection metrics
      try {
        const connMetrics = await atlasRequest(creds, "GET",
          `/processes/${hostId}/measurements?granularity=PT1M&period=PT5M&m=CONNECTIONS`
        );
        const connData = connMetrics.measurements?.[0]?.dataPoints;
        if (connData?.length) {
          connections = connData[connData.length - 1]?.value || 0;
        }
      } catch { /* metrics may not be available */ }

      // Get opcounter metrics
      try {
        const opsMetrics = await atlasRequest(creds, "GET",
          `/processes/${hostId}/measurements?granularity=PT1M&period=PT5M&m=OPCOUNTER_CMD&m=OPCOUNTER_QUERY&m=OPCOUNTER_UPDATE&m=OPCOUNTER_DELETE&m=OPCOUNTER_INSERT`
        );
        for (const m of opsMetrics.measurements || []) {
          const lastPoint = m.dataPoints?.[m.dataPoints.length - 1];
          if (lastPoint?.value) opsPerSec += lastPoint.value;
        }
      } catch { /* metrics may not be available */ }
    }
  } catch {
    // Process metrics require M10+ tier
  }

  // Get cost from pending invoice
  let dailyCost = 0;
  try {
    const invoices = await atlasRequest(creds, "GET", `/invoices/pending`);
    const totalCents = invoices.amountBilledCents || 0;
    const daysInMonth = 30;
    dailyCost = (totalCents / 100) / daysInMonth;
  } catch {
    // Billing API may not be available
  }

  return [{
    serviceName: `cluster:${creds.clusterName}`,
    metrics: [
      { name: "Storage", value: storageGB, unit: "GB", thresholdKey: "mongodbStorageSizeGB" },
      { name: "Active Connections", value: connections, unit: "connections", thresholdKey: "mongodbActiveConnections" },
      { name: "Operations/sec", value: Math.round(opsPerSec), unit: "ops/sec", thresholdKey: "mongodbOpsPerSec" },
      { name: "Tier", value: 0, unit: `${tier}${paused ? " (PAUSED)" : ""}`, thresholdKey: "" },
    ],
    estimatedDailyCostUSD: paused ? 0 : dailyCost,
    paused,
  }];
}

// ─── Self-Hosted Monitoring ───────────────────────────────────────────────

async function checkSelfHostedMongo(creds: MongoDBCreds): Promise<ServiceUsage[]> {
  validateConnectionUrl(creds.mongodbUri!, "MongoDB");
  const { MongoClient } = await import("mongodb");
  const client = new MongoClient(creds.mongodbUri!, {
    serverSelectionTimeoutMS: 10000,
    connectTimeoutMS: 10000,
  });

  try {
    await client.connect();
    const db = client.db(creds.databaseName || "admin");
    const admin = db.admin();

    // Server status
    const status = await admin.serverStatus();
    const connections = status.connections?.current || 0;
    const opcounters = status.opcounters || {};
    const totalOps = (opcounters.insert || 0) + (opcounters.query || 0) + (opcounters.update || 0) + (opcounters.delete || 0) + (opcounters.command || 0);
    const uptimeSeconds = status.uptime || 1;
    const opsPerSec = Math.round(totalOps / uptimeSeconds);
    const memoryMB = status.mem?.resident || 0;

    // Database stats
    const dbStats = await db.stats();
    const dataSizeGB = ((dbStats.dataSize || 0) + (dbStats.indexSize || 0)) / (1024 * 1024 * 1024);
    const collections = dbStats.collections || 0;

    // Count all databases
    const dbList = await admin.listDatabases();
    const totalDatabases = dbList.databases?.length || 0;

    const host = creds.mongodbUri?.replace(/\/\/.*@/, "//***@").split("/")[2]?.split("?")[0] || "localhost";

    return [{
      serviceName: `mongodb:${host}`,
      metrics: [
        { name: "Storage", value: parseFloat(dataSizeGB.toFixed(2)), unit: "GB", thresholdKey: "mongodbStorageSizeGB" },
        { name: "Active Connections", value: connections, unit: "connections", thresholdKey: "mongodbActiveConnections" },
        { name: "Operations/sec", value: opsPerSec, unit: "ops/sec", thresholdKey: "mongodbOpsPerSec" },
        { name: "Collections", value: collections, unit: "collections", thresholdKey: "mongodbCollectionCount" },
        { name: "Databases", value: totalDatabases, unit: "dbs", thresholdKey: "" },
        { name: "Memory (RSS)", value: memoryMB, unit: "MB", thresholdKey: "" },
      ],
      estimatedDailyCostUSD: 0,
    }];
  } finally {
    await client.close().catch(() => {});
  }
}

// ─── Kill Actions ─────────────────────────────────────────────────────────

async function killConnectionsSelfHosted(creds: MongoDBCreds): Promise<ActionResult> {
  const { MongoClient } = await import("mongodb");
  const client = new MongoClient(creds.mongodbUri!, { serverSelectionTimeoutMS: 10000 });
  try {
    await client.connect();
    const admin = client.db("admin").admin();
    // Kill all sessions
    try {
      await admin.command({ killAllSessions: [] });
    } catch {
      // May not have permissions — try killOp on active ops
      const ops = await admin.command({ currentOp: 1, active: true });
      let killed = 0;
      for (const op of ops.inprog || []) {
        if (op.opid) {
          try { await admin.command({ killOp: 1, op: op.opid }); killed++; } catch { /* skip */ }
        }
      }
      return { success: true, action: "kill-connections", serviceName: "mongodb", details: `Killed ${killed} active operations` };
    }
    return { success: true, action: "kill-connections", serviceName: "mongodb", details: "Killed all sessions" };
  } finally {
    await client.close().catch(() => {});
  }
}

async function isolateAtlas(creds: MongoDBCreds): Promise<ActionResult> {
  // Get current IP access list
  const accessList = await atlasRequest(creds, "GET", `/accessList`);
  const entries = accessList.results || [];

  // Delete all entries
  let removed = 0;
  for (const entry of entries) {
    const ip = entry.ipAddress || entry.cidrBlock;
    if (ip) {
      try {
        await atlasRequest(creds, "DELETE", `/accessList/${encodeURIComponent(ip)}`);
        removed++;
      } catch { /* some entries may be undeletable */ }
    }
  }

  return {
    success: true,
    action: "isolate",
    serviceName: `cluster:${creds.clusterName}`,
    details: `Removed ${removed} IP access list entries — cluster is now isolated`,
  };
}

async function pauseAtlas(creds: MongoDBCreds): Promise<ActionResult> {
  await atlasRequest(creds, "PATCH", `/clusters/${creds.clusterName}`, { paused: true });
  return {
    success: true,
    action: "pause-cluster",
    serviceName: `cluster:${creds.clusterName}`,
    details: "Atlas cluster paused",
  };
}

async function scaleDownAtlas(creds: MongoDBCreds): Promise<ActionResult> {
  await atlasRequest(creds, "PATCH", `/clusters/${creds.clusterName}`, {
    providerSettings: { instanceSizeName: "M10" },
  });
  return {
    success: true,
    action: "scale-down",
    serviceName: `cluster:${creds.clusterName}`,
    details: "Atlas cluster scaled down to M10",
  };
}

async function shutdownSelfHosted(creds: MongoDBCreds): Promise<ActionResult> {
  const { MongoClient } = await import("mongodb");
  const client = new MongoClient(creds.mongodbUri!, { serverSelectionTimeoutMS: 10000 });
  try {
    await client.connect();
    await client.db("admin").admin().command({ shutdown: 1, force: true });
    return { success: true, action: "pause-cluster", serviceName: "mongodb", details: "MongoDB server shut down" };
  } catch (err: any) {
    // shutdown command always throws because the server disconnects
    if (err.message?.includes("connection") || err.message?.includes("topology")) {
      return { success: true, action: "pause-cluster", serviceName: "mongodb", details: "MongoDB server shut down (connection closed)" };
    }
    throw err;
  } finally {
    await client.close().catch(() => {});
  }
}

// ─── Provider Export ──────────────────────────────────────────────────────

export const mongodbProvider: CloudProvider = {
  id: "mongodb",
  name: "MongoDB",

  async checkUsage(credential: DecryptedCredential, thresholds: ThresholdConfig): Promise<UsageResult> {
    const creds = getMongoDBCredentials(credential);
    let services: ServiceUsage[];

    switch (creds.subType) {
      case "atlas":
        services = await checkAtlas(creds);
        break;
      case "self-hosted":
        services = await checkSelfHostedMongo(creds);
        break;
      default:
        throw new Error(`Unknown MongoDB sub-type: ${creds.subType}`);
    }

    // Evaluate violations
    const violations: Violation[] = [];
    let totalDailyCost = 0;

    for (const service of services) {
      totalDailyCost += service.estimatedDailyCostUSD;
      // Skip per-metric threshold violations for paused services — no cost or
      // harm to mitigate and a kill action would be wasted noise. We still
      // surface the service in `services` so dashboards show its state.
      if (service.paused) continue;
      for (const metric of service.metrics) {
        if (!metric.thresholdKey) continue;
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

    // Check daily cost threshold
    if (thresholds.mongodbDailyCostUSD && totalDailyCost > thresholds.mongodbDailyCostUSD) {
      violations.push({
        serviceName: "mongodb-billing",
        metricName: "Daily Cost",
        currentValue: totalDailyCost,
        threshold: thresholds.mongodbDailyCostUSD,
        unit: "USD",
        severity: totalDailyCost > thresholds.mongodbDailyCostUSD * 2 ? "critical" : "warning",
      });
    }

    return {
      provider: "mongodb",
      accountId: creds.atlasProjectId || creds.mongodbUri?.replace(/\/\/.*@/, "//***@").split("/")[2]?.split("?")[0] || "mongodb",
      checkedAt: Date.now(),
      services,
      totalEstimatedDailyCostUSD: totalDailyCost,
      violations,
      securityEvents: [],
    };
  },

  async executeKillSwitch(credential: DecryptedCredential, serviceName: string, action): Promise<ActionResult> {
    const creds = getMongoDBCredentials(credential);

    switch (action) {
      case "kill-connections": {
        if (creds.subType === "self-hosted") return killConnectionsSelfHosted(creds);
        // Atlas managed clusters expose no direct connection-killing API.
        // The closest "stop-the-bleeding" semantic that Atlas DOES support is
        // pause-cluster — it halts all cluster activity (and reduces billing
        // to the paused rate) without removing IP allowlist entries the way
        // `isolate` would (which can break unrelated legitimate clients).
        // The returned ActionResult reports the actual action performed so
        // the kill audit log reflects what really happened.
        const paused = await pauseAtlas(creds);
        return {
          ...paused,
          details: `kill-connections unavailable on Atlas managed clusters — fell through to pause-cluster: ${paused.details}`,
        };
      }
      case "isolate": {
        if (creds.subType === "atlas") return isolateAtlas(creds);
        return { success: false, action, serviceName, details: "Isolate is only available for Atlas. For self-hosted, configure your firewall." };
      }
      case "scale-down": {
        if (creds.subType === "atlas") return scaleDownAtlas(creds);
        return { success: false, action, serviceName, details: "Scale-down is only available for Atlas managed clusters." };
      }
      case "pause-cluster": {
        if (creds.subType === "atlas") return pauseAtlas(creds);
        if (creds.subType === "self-hosted") return shutdownSelfHosted(creds);
        return { success: false, action, serviceName, details: `pause-cluster not supported for ${creds.subType}` };
      }
      case "delete": {
        if (creds.subType === "atlas") {
          await atlasRequest(creds, "DELETE", `/clusters/${creds.clusterName}`);
          return { success: true, action, serviceName, details: `Atlas cluster ${creds.clusterName} terminated` };
        }
        if (creds.subType === "self-hosted") {
          const { MongoClient } = await import("mongodb");
          const client = new MongoClient(creds.mongodbUri!, { serverSelectionTimeoutMS: 10000 });
          try {
            await client.connect();
            const db = client.db(creds.databaseName || "admin");
            await db.dropDatabase();
            return { success: true, action, serviceName, details: `Database ${creds.databaseName || "admin"} dropped` };
          } finally {
            await client.close().catch(() => {});
          }
        }
        return { success: false, action, serviceName, details: `delete not supported for ${creds.subType}` };
      }
      default:
        return { success: false, action, serviceName, details: `Unknown action: ${action}` };
    }
  },

  async validateCredential(credential: DecryptedCredential): Promise<ValidationResult> {
    const creds = getMongoDBCredentials(credential);

    try {
      switch (creds.subType) {
        case "atlas": {
          if (!creds.atlasPublicKey || !creds.atlasPrivateKey || !creds.atlasProjectId) {
            return { valid: false, error: "Missing Atlas API keys or project ID" };
          }
          const clusters = await atlasRequest(creds, "GET", `/clusters`);
          const clusterList = clusters.results || [];
          const target = creds.clusterName
            ? clusterList.find((c: any) => c.name === creds.clusterName)
            : clusterList[0];

          return {
            valid: true,
            accountId: creds.atlasProjectId,
            accountName: target
              ? `Atlas ${target.providerSettings?.instanceSizeName || ""} — ${target.name}`
              : `Atlas project (${clusterList.length} clusters)`,
          };
        }
        case "self-hosted": {
          if (!creds.mongodbUri) {
            return { valid: false, error: "Missing MongoDB connection URI" };
          }
          validateConnectionUrl(creds.mongodbUri, "MongoDB");
          const { MongoClient } = await import("mongodb");
          const client = new MongoClient(creds.mongodbUri, {
            serverSelectionTimeoutMS: 10000,
            connectTimeoutMS: 10000,
          });
          try {
            await client.connect();
            const admin = client.db("admin").admin();
            const info = await admin.serverInfo();
            return {
              valid: true,
              accountId: creds.mongodbUri.replace(/\/\/.*@/, "//***@").split("/")[2]?.split("?")[0] || "localhost",
              accountName: `MongoDB ${info.version || ""}`,
            };
          } finally {
            await client.close().catch(() => {});
          }
        }
        default:
          return { valid: false, error: `Unknown MongoDB sub-type: ${creds.subType}` };
      }
    } catch (err: any) {
      return { valid: false, error: err.message };
    }
  },

  getDefaultThresholds(): ThresholdConfig {
    // Defaults tuned for typical production clusters. The previous values
    // (10GB storage, 200 connections, 5000 ops/sec, 30 USD/day) fired
    // critical violations on every realistic Atlas tier — a 33GB Dedicated
    // M30 immediately triggered a storage kill on onboarding. New values
    // accommodate small-prod through M40 territory; users with much
    // larger workloads should still raise these explicitly.
    return {
      mongodbStorageSizeGB: 500,
      mongodbActiveConnections: 1000,
      mongodbOpsPerSec: 10000,
      mongodbCollectionCount: 1000,
      mongodbDailyCostUSD: 100,
      monthlySpendLimitUSD: 3000,
    };
  },
};
