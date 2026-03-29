/**
 * Redis Provider
 *
 * Monitors Redis instances across three sub-types:
 * - Redis Cloud (Redis Labs) — REST API
 * - AWS ElastiCache — AWS SDK
 * - Self-hosted — direct connection via ioredis
 *
 * Kill actions: kill-connections, isolate, scale-down, flush-redis, pause-cluster.
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
  RedisSubType,
} from "../types.js";

// ─── SSRF Protection ──────────────────────────────────────────────────────

function validateConnectionUrl(uri: string, protocol: string): void {
  let parsed: URL;
  try {
    parsed = new URL(uri);
  } catch {
    throw new Error(`Invalid ${protocol} URL format`);
  }
  const host = parsed.hostname.toLowerCase();
  // Block private/internal IPs and metadata endpoints
  if (
    host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "0.0.0.0" ||
    host.startsWith("10.") || host.startsWith("192.168.") ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
    host.startsWith("169.254.") || // Link-local / cloud metadata
    host.startsWith("fe80:") ||
    host === "metadata.google.internal" ||
    host.endsWith(".internal")
  ) {
    throw new Error("Connections to private/internal network addresses are not allowed");
  }
}

// ─── Credential Helpers ───────────────────────────────────────────────────

interface RedisCreds {
  subType: RedisSubType;
  // Redis Cloud
  accountKey?: string;
  secretKey?: string;
  subscriptionId?: string;
  // ElastiCache
  awsAccessKeyId?: string;
  awsSecretAccessKey?: string;
  awsRegion?: string;
  clusterId?: string;
  // Self-hosted
  redisUrl?: string;
  tlsEnabled?: boolean;
}

function getRedisCredentials(credential: DecryptedCredential): RedisCreds {
  const subType = credential.redisSubType || "self-hosted";
  return {
    subType,
    accountKey: credential.redisCloudAccountKey,
    secretKey: credential.redisCloudSecretKey,
    subscriptionId: credential.redisCloudSubscriptionId,
    awsAccessKeyId: credential.awsAccessKeyId,
    awsSecretAccessKey: credential.awsSecretAccessKey,
    awsRegion: credential.awsRegion,
    clusterId: credential.elasticacheClusterId,
    redisUrl: credential.redisUrl,
    tlsEnabled: credential.redisTlsEnabled,
  };
}

// ─── Redis Cloud API ──────────────────────────────────────────────────────

const REDIS_CLOUD_BASE = "https://api.redislabs.com/v1";

async function redisCloudRequest(creds: RedisCreds, method: string, path: string, body?: any): Promise<any> {
  const resp = await fetch(`${REDIS_CLOUD_BASE}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      "x-api-key": creds.accountKey!,
      "x-api-secret-key": creds.secretKey!,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!resp.ok) {
    const text = await resp.text();
    console.error(`[guardian] Redis Cloud API error: ${resp.status}`, text.substring(0, 500));
    throw new Error(`Redis Cloud API error: ${resp.status}`);
  }
  return resp.json();
}

async function checkRedisCloud(creds: RedisCreds): Promise<ServiceUsage[]> {
  const services: ServiceUsage[] = [];

  // Get subscription info for cost
  const subscription = await redisCloudRequest(creds, "GET", `/subscriptions/${creds.subscriptionId}`);
  const monthlyCost = Number(subscription.price) || 0;
  const dailyCost = isFinite(monthlyCost) ? monthlyCost / 30 : 0;

  // Get databases under the subscription
  const dbs = await redisCloudRequest(creds, "GET", `/subscriptions/${creds.subscriptionId}/databases`);
  const databases = dbs.subscription?.[0]?.databases || dbs.databases || [];

  for (const db of databases) {
    const memoryMB = (db.memoryUsedInMb || db.memoryLimitInMb || 0);
    const maxMemoryMB = db.memoryLimitInMb || 0;

    services.push({
      serviceName: `db:${db.databaseId}:${db.name || "default"}`,
      metrics: [
        { name: "Memory Usage", value: memoryMB, unit: "MB", thresholdKey: "redisMemoryUsageMB" },
        { name: "Max Memory", value: maxMemoryMB, unit: "MB", thresholdKey: "redisMemoryUsageMB" },
        { name: "Throughput", value: db.throughputInOps || 0, unit: "ops/sec", thresholdKey: "redisCommandsPerSec" },
      ],
      estimatedDailyCostUSD: dailyCost / Math.max(databases.length, 1),
    });
  }

  return services;
}

// ─── ElastiCache ──────────────────────────────────────────────────────────

async function checkElastiCache(creds: RedisCreds): Promise<ServiceUsage[]> {
  const { ElastiCacheClient, DescribeCacheClustersCommand } = await import("@aws-sdk/client-elasticache");
  const { CloudWatchClient, GetMetricDataCommand } = await import("@aws-sdk/client-cloudwatch");
  const { CostExplorerClient, GetCostAndUsageCommand } = await import("@aws-sdk/client-cost-explorer");

  const config = {
    region: creds.awsRegion || "us-east-1",
    credentials: { accessKeyId: creds.awsAccessKeyId!, secretAccessKey: creds.awsSecretAccessKey! },
  };

  const ec = new ElastiCacheClient(config);
  const cw = new CloudWatchClient(config);

  // Describe cluster
  const clusters = await ec.send(new DescribeCacheClustersCommand({
    CacheClusterId: creds.clusterId,
    ShowCacheNodeInfo: true,
  }));

  const services: ServiceUsage[] = [];
  const now = new Date();
  const oneHourAgo = new Date(now.getTime() - 3600000);

  for (const cluster of clusters.CacheClusters || []) {
    const nodeType = cluster.CacheNodeType || "unknown";
    const nodeCount = cluster.NumCacheNodes || 0;

    // Get CloudWatch metrics
    let memoryBytes = 0;
    let connections = 0;
    let opsPerSec = 0;

    try {
      const metrics = await cw.send(new GetMetricDataCommand({
        StartTime: oneHourAgo,
        EndTime: now,
        MetricDataQueries: [
          {
            Id: "memory", MetricStat: {
              Metric: { Namespace: "AWS/ElastiCache", MetricName: "BytesUsedForCache", Dimensions: [{ Name: "CacheClusterId", Value: cluster.CacheClusterId! }] },
              Period: 300, Stat: "Average",
            },
          },
          {
            Id: "connections", MetricStat: {
              Metric: { Namespace: "AWS/ElastiCache", MetricName: "CurrConnections", Dimensions: [{ Name: "CacheClusterId", Value: cluster.CacheClusterId! }] },
              Period: 300, Stat: "Average",
            },
          },
          {
            Id: "commands", MetricStat: {
              Metric: { Namespace: "AWS/ElastiCache", MetricName: "GetTypeCmds", Dimensions: [{ Name: "CacheClusterId", Value: cluster.CacheClusterId! }] },
              Period: 300, Stat: "Sum",
            },
          },
        ],
      }));

      for (const result of metrics.MetricDataResults || []) {
        const val = result.Values?.[0] || 0;
        if (result.Id === "memory") memoryBytes = val;
        if (result.Id === "connections") connections = val;
        if (result.Id === "commands") opsPerSec = val / 300;
      }
    } catch {
      // CloudWatch metrics may not be available yet
    }

    // Estimate cost via Cost Explorer
    let dailyCost = 0;
    try {
      const ce = new CostExplorerClient(config);
      const today = now.toISOString().split("T")[0];
      const yesterday = new Date(now.getTime() - 86400000).toISOString().split("T")[0];
      const costData = await ce.send(new GetCostAndUsageCommand({
        TimePeriod: { Start: yesterday, End: today },
        Granularity: "DAILY",
        Metrics: ["UnblendedCost"],
        Filter: { Dimensions: { Key: "SERVICE", Values: ["Amazon ElastiCache"] } },
      }));
      dailyCost = parseFloat(costData.ResultsByTime?.[0]?.Total?.UnblendedCost?.Amount || "0");
    } catch {
      // Cost Explorer may not be enabled
    }

    services.push({
      serviceName: `cluster:${cluster.CacheClusterId}`,
      metrics: [
        { name: "Memory Usage", value: Math.round(memoryBytes / (1024 * 1024)), unit: "MB", thresholdKey: "redisMemoryUsageMB" },
        { name: "Connected Clients", value: Math.round(connections), unit: "clients", thresholdKey: "redisConnectedClients" },
        { name: "Commands/sec", value: Math.round(opsPerSec), unit: "ops/sec", thresholdKey: "redisCommandsPerSec" },
        { name: "Node Type", value: 0, unit: `${nodeType} x${nodeCount}`, thresholdKey: "" },
      ],
      estimatedDailyCostUSD: dailyCost,
    });
  }

  return services;
}

// ─── Self-Hosted Redis ────────────────────────────────────────────────────

async function checkSelfHostedRedis(creds: RedisCreds): Promise<ServiceUsage[]> {
  validateConnectionUrl(creds.redisUrl!, "Redis");
  const ioredis = await import("ioredis");
  const Redis = ioredis.default || ioredis;
  const client = new (Redis as any)(creds.redisUrl!, {
    tls: creds.tlsEnabled ? {} : undefined,
    connectTimeout: 10000,
    lazyConnect: true,
  });

  try {
    await client.connect();
    const info = await client.info();

    // Parse INFO response
    const parse = (key: string): number => {
      const match = info.match(new RegExp(`${key}:(\\d+(?:\\.\\d+)?)`));
      return match ? parseFloat(match[1]) : 0;
    };

    const memoryMB = Math.round(parse("used_memory") / (1024 * 1024));
    const clients = parse("connected_clients");
    const opsPerSec = parse("instantaneous_ops_per_sec");
    const evictedKeys = parse("evicted_keys");
    const maxMemory = parse("maxmemory");
    const dbCount = (info.match(/^db\d+:/gm) || []).length;

    return [{
      serviceName: `redis:${creds.redisUrl?.replace(/\/\/.*@/, "//***@").split("/")[2] || "localhost"}`,
      metrics: [
        { name: "Memory Usage", value: memoryMB, unit: "MB", thresholdKey: "redisMemoryUsageMB" },
        { name: "Max Memory", value: maxMemory > 0 ? Math.round(maxMemory / (1024 * 1024)) : 0, unit: "MB", thresholdKey: "" },
        { name: "Connected Clients", value: clients, unit: "clients", thresholdKey: "redisConnectedClients" },
        { name: "Commands/sec", value: opsPerSec, unit: "ops/sec", thresholdKey: "redisCommandsPerSec" },
        { name: "Evicted Keys", value: evictedKeys, unit: "keys", thresholdKey: "redisEvictedKeysPerDay" },
        { name: "Databases", value: dbCount, unit: "dbs", thresholdKey: "" },
      ],
      estimatedDailyCostUSD: 0, // Self-hosted has no direct cost tracking
    }];
  } finally {
    await client.quit().catch(() => {});
  }
}

// ─── Kill Actions ─────────────────────────────────────────────────────────

async function killConnectionsSelfHosted(creds: RedisCreds): Promise<ActionResult> {
  const ioredis = await import("ioredis");
  const Redis = ioredis.default || ioredis;
  const client = new (Redis as any)(creds.redisUrl!, { tls: creds.tlsEnabled ? {} : undefined, connectTimeout: 10000, lazyConnect: true });
  try {
    await client.connect();
    // Kill all client connections except our own
    const clientList = await client.client("LIST") as string;
    const clientIds = clientList.split("\n").filter(l => l.includes("cmd=")).map(l => {
      const match = l.match(/id=(\d+)/);
      return match ? match[1] : null;
    }).filter(Boolean);

    let killed = 0;
    const myId = await client.client("GETNAME");
    for (const id of clientIds) {
      try { await client.client("KILL", "ID", id!); killed++; } catch { /* skip self */ }
    }
    return { success: true, action: "kill-connections", serviceName: "redis", details: `Killed ${killed} client connections` };
  } finally {
    await client.quit().catch(() => {});
  }
}

async function flushSelfHosted(creds: RedisCreds): Promise<ActionResult> {
  const ioredis = await import("ioredis");
  const Redis = ioredis.default || ioredis;
  const client = new (Redis as any)(creds.redisUrl!, { tls: creds.tlsEnabled ? {} : undefined, connectTimeout: 10000, lazyConnect: true });
  try {
    await client.connect();
    await client.flushall();
    return { success: true, action: "flush-redis", serviceName: "redis", details: "Executed FLUSHALL — all data cleared" };
  } finally {
    await client.quit().catch(() => {});
  }
}

async function scaleDownSelfHosted(creds: RedisCreds): Promise<ActionResult> {
  const ioredis = await import("ioredis");
  const Redis = ioredis.default || ioredis;
  const client = new (Redis as any)(creds.redisUrl!, { tls: creds.tlsEnabled ? {} : undefined, connectTimeout: 10000, lazyConnect: true });
  try {
    await client.connect();
    // Set maxmemory to 1MB to force evictions and prevent new writes
    await client.config("SET", "maxmemory", "1048576");
    await client.config("SET", "maxmemory-policy", "allkeys-lru");
    return { success: true, action: "scale-down", serviceName: "redis", details: "Set maxmemory to 1MB with allkeys-lru eviction" };
  } finally {
    await client.quit().catch(() => {});
  }
}

// ─── Provider Export ──────────────────────────────────────────────────────

export const redisProvider: CloudProvider = {
  id: "redis",
  name: "Redis",

  async checkUsage(credential: DecryptedCredential, thresholds: ThresholdConfig): Promise<UsageResult> {
    const creds = getRedisCredentials(credential);
    let services: ServiceUsage[];

    switch (creds.subType) {
      case "redis-cloud":
        services = await checkRedisCloud(creds);
        break;
      case "elasticache":
        services = await checkElastiCache(creds);
        break;
      case "self-hosted":
        services = await checkSelfHostedRedis(creds);
        break;
      default:
        throw new Error(`Unknown Redis sub-type: ${creds.subType}`);
    }

    // Evaluate violations
    const violations: Violation[] = [];
    let totalDailyCost = 0;

    for (const service of services) {
      totalDailyCost += service.estimatedDailyCostUSD;
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
    if (thresholds.redisDailyCostUSD && totalDailyCost > thresholds.redisDailyCostUSD) {
      violations.push({
        serviceName: "redis-billing",
        metricName: "Daily Cost",
        currentValue: totalDailyCost,
        threshold: thresholds.redisDailyCostUSD,
        unit: "USD",
        severity: totalDailyCost > thresholds.redisDailyCostUSD * 2 ? "critical" : "warning",
      });
    }

    return {
      provider: "redis",
      accountId: creds.subscriptionId || creds.clusterId || creds.redisUrl?.split("@")[1]?.split("/")[0] || "redis",
      checkedAt: Date.now(),
      services,
      totalEstimatedDailyCostUSD: totalDailyCost,
      violations,
      securityEvents: [],
    };
  },

  async executeKillSwitch(credential: DecryptedCredential, serviceName: string, action): Promise<ActionResult> {
    const creds = getRedisCredentials(credential);

    switch (action) {
      case "kill-connections": {
        if (creds.subType === "self-hosted") return killConnectionsSelfHosted(creds);
        if (creds.subType === "redis-cloud") {
          // Redis Cloud doesn't have a direct connection kill API — use scaling
          return { success: false, action, serviceName, details: "Redis Cloud does not support direct connection killing. Use isolate or scale-down instead." };
        }
        return { success: false, action, serviceName, details: `kill-connections not supported for ${creds.subType}` };
      }
      case "flush-redis": {
        if (creds.subType === "self-hosted") return flushSelfHosted(creds);
        return { success: false, action, serviceName, details: `flush-redis requires direct connection (self-hosted only)` };
      }
      case "scale-down": {
        if (creds.subType === "self-hosted") return scaleDownSelfHosted(creds);
        if (creds.subType === "redis-cloud") {
          // Scale down Redis Cloud database
          const dbId = serviceName.split(":")[1];
          await redisCloudRequest(creds, "PUT", `/subscriptions/${creds.subscriptionId}/databases/${dbId}`, {
            memoryLimitInMb: 25, // Minimum
          });
          return { success: true, action, serviceName, details: "Scaled Redis Cloud database to minimum 25MB" };
        }
        return { success: false, action, serviceName, details: `scale-down not implemented for ${creds.subType}` };
      }
      case "pause-cluster": {
        if (creds.subType === "redis-cloud") {
          await redisCloudRequest(creds, "DELETE", `/subscriptions/${creds.subscriptionId}`);
          return { success: true, action, serviceName, details: "Redis Cloud subscription deactivated" };
        }
        if (creds.subType === "elasticache") {
          const { ElastiCacheClient, DeleteCacheClusterCommand, CreateSnapshotCommand } = await import("@aws-sdk/client-elasticache");
          const ec = new ElastiCacheClient({
            region: creds.awsRegion!, credentials: { accessKeyId: creds.awsAccessKeyId!, secretAccessKey: creds.awsSecretAccessKey! },
          });
          // Snapshot before deleting
          const snapName = `kill-switch-${creds.clusterId}-${Date.now()}`;
          await ec.send(new CreateSnapshotCommand({ CacheClusterId: creds.clusterId!, SnapshotName: snapName }));
          await ec.send(new DeleteCacheClusterCommand({ CacheClusterId: creds.clusterId!, FinalSnapshotIdentifier: `${snapName}-final` }));
          return { success: true, action, serviceName, details: `ElastiCache cluster deleted with snapshot ${snapName}` };
        }
        return { success: false, action, serviceName, details: "pause-cluster not available for self-hosted Redis" };
      }
      case "isolate": {
        if (creds.subType === "self-hosted") {
          return scaleDownSelfHosted(creds); // Best we can do for self-hosted
        }
        return { success: false, action, serviceName, details: `isolate not implemented for ${creds.subType}` };
      }
      default:
        return { success: false, action, serviceName, details: `Unknown action: ${action}` };
    }
  },

  async validateCredential(credential: DecryptedCredential): Promise<ValidationResult> {
    const creds = getRedisCredentials(credential);

    try {
      switch (creds.subType) {
        case "redis-cloud": {
          if (!creds.accountKey || !creds.secretKey) {
            return { valid: false, error: "Missing Redis Cloud API keys" };
          }
          const account = await redisCloudRequest(creds, "GET", "/");
          return {
            valid: true,
            accountId: creds.subscriptionId || "redis-cloud",
            accountName: account.account?.name || "Redis Cloud",
          };
        }
        case "elasticache": {
          if (!creds.awsAccessKeyId || !creds.awsSecretAccessKey || !creds.clusterId) {
            return { valid: false, error: "Missing AWS credentials or cluster ID" };
          }
          const { ElastiCacheClient, DescribeCacheClustersCommand } = await import("@aws-sdk/client-elasticache");
          const ec = new ElastiCacheClient({
            region: creds.awsRegion || "us-east-1",
            credentials: { accessKeyId: creds.awsAccessKeyId, secretAccessKey: creds.awsSecretAccessKey },
          });
          const result = await ec.send(new DescribeCacheClustersCommand({ CacheClusterId: creds.clusterId }));
          const cluster = result.CacheClusters?.[0];
          return {
            valid: true,
            accountId: creds.clusterId,
            accountName: `ElastiCache ${cluster?.CacheNodeType || ""} (${cluster?.Engine || "redis"})`,
          };
        }
        case "self-hosted": {
          if (!creds.redisUrl) {
            return { valid: false, error: "Missing Redis URL" };
          }
          validateConnectionUrl(creds.redisUrl, "Redis");
          const ioredisValidate = await import("ioredis");
          const RedisValidate = ioredisValidate.default || ioredisValidate;
          const client = new (RedisValidate as any)(creds.redisUrl, {
            tls: creds.tlsEnabled ? {} : undefined,
            connectTimeout: 10000,
            lazyConnect: true,
          });
          try {
            await client.connect();
            const pong = await client.ping();
            const info = await client.info("server");
            const versionMatch = info.match(/redis_version:(\S+)/);
            return {
              valid: pong === "PONG",
              accountId: creds.redisUrl.replace(/\/\/.*@/, "//***@").split("/")[2] || "localhost",
              accountName: `Redis ${versionMatch?.[1] || ""}`,
            };
          } finally {
            await client.quit().catch(() => {});
          }
        }
        default:
          return { valid: false, error: `Unknown Redis sub-type: ${creds.subType}` };
      }
    } catch (err: any) {
      return { valid: false, error: err.message };
    }
  },

  getDefaultThresholds(): ThresholdConfig {
    return {
      redisMemoryUsageMB: 512,
      redisConnectedClients: 100,
      redisCommandsPerSec: 10000,
      redisEvictedKeysPerDay: 1000,
      redisDailyCostUSD: 25,
      monthlySpendLimitUSD: 750,
    };
  },
};
