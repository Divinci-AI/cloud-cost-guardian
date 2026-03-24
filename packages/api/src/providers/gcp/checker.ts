/**
 * GCP Provider
 *
 * Monitors GCP Cloud Run services, billing costs, and security metrics.
 * Uses Cloud Billing API for real cost data and Cloud Run API for service management.
 */

import { createSign } from "crypto";
import type {
  CloudProvider,
  DecryptedCredential,
  ThresholdConfig,
  UsageResult,
  ActionResult,
  ValidationResult,
  ServiceUsage,
  Violation,
  SecurityEvent,
  KillAction,
} from "../types.js";

// ─── JWT Authentication ─────────────────────────────────────────────────────

async function getAccessToken(serviceAccountJson: string): Promise<string> {
  const sa = JSON.parse(serviceAccountJson);

  // If a pre-generated access token is provided, use it directly
  if (sa.access_token) return sa.access_token;

  // Generate JWT from service account key
  if (sa.private_key && sa.client_email) {
    const now = Math.floor(Date.now() / 1000);
    const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");
    const payload = Buffer.from(JSON.stringify({
      iss: sa.client_email,
      scope: "https://www.googleapis.com/auth/cloud-platform",
      aud: "https://oauth2.googleapis.com/token",
      iat: now,
      exp: now + 3600,
    })).toString("base64url");

    const sign = createSign("RSA-SHA256");
    sign.update(`${header}.${payload}`);
    const signature = sign.sign(sa.private_key, "base64url");

    const jwt = `${header}.${payload}.${signature}`;

    // Exchange JWT for access token
    const res = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${jwt}`,
    });

    const text = await res.text();
    let data: any;
    try {
      data = JSON.parse(text);
    } catch {
      throw new Error(`Token exchange failed: ${text.substring(0, 200)}`);
    }

    if (data.access_token) return data.access_token;
    throw new Error(`Token exchange error: ${data.error_description || data.error || text.substring(0, 200)}`);
  }

  throw new Error("GCP credential must contain access_token or (private_key + client_email)");
}

// ─── Cloud Run Services ─────────────────────────────────────────────────────

async function listCloudRunServices(
  accessToken: string, projectId: string, region: string
): Promise<ServiceUsage[]> {
  const res = await fetch(
    `https://run.googleapis.com/v2/projects/${projectId}/locations/${region}/services`,
    { headers: { "Authorization": `Bearer ${accessToken}` } }
  );

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Cloud Run API error ${res.status}: ${text.substring(0, 200)}`);
  }

  const text = await res.text();
  const data = JSON.parse(text);
  const services = data.services || [];

  return services.map((svc: any) => {
    const name = svc.name?.split("/").pop() || "unknown";
    const minInstances = parseInt(svc.template?.scaling?.minInstanceCount || "0");
    const maxInstances = parseInt(svc.template?.scaling?.maxInstanceCount || "100");
    const cpu = svc.template?.containers?.[0]?.resources?.limits?.cpu || "1";
    const memory = svc.template?.containers?.[0]?.resources?.limits?.memory || "512Mi";

    const cpuCount = parseFloat(cpu.replace("m", "")) / (cpu.includes("m") ? 1000 : 1);
    const monthlyCost = minInstances * cpuCount * 50;
    const dailyCost = monthlyCost / 30;

    return {
      serviceName: name,
      metrics: [
        { name: "Min Instances", value: minInstances, unit: "instances", thresholdKey: "gcpMinInstances" },
        { name: "Max Instances", value: maxInstances, unit: "instances", thresholdKey: "gcpMaxInstances" },
        { name: "CPU", value: cpuCount, unit: "vCPU", thresholdKey: "gcpCPU" },
      ],
      estimatedDailyCostUSD: dailyCost,
    };
  });
}

// ─── Compute Engine ─────────────────────────────────────────────────────────

async function listComputeInstances(
  accessToken: string, projectId: string
): Promise<ServiceUsage[]> {
  const res = await fetch(
    `https://compute.googleapis.com/compute/v1/projects/${projectId}/aggregated/instances`,
    { headers: { "Authorization": `Bearer ${accessToken}` } }
  );

  if (!res.ok) return [];
  const text = await res.text();
  const data = JSON.parse(text);

  const services: ServiceUsage[] = [];
  let totalInstances = 0;
  let totalGPUs = 0;

  for (const [zone, scopeData] of Object.entries(data.items || {}) as [string, any][]) {
    for (const instance of scopeData.instances || []) {
      if (instance.status !== "RUNNING") continue;
      totalInstances++;

      const gpuCount = (instance.guestAccelerators || []).reduce(
        (sum: number, acc: any) => sum + (acc.acceleratorCount || 0), 0
      );
      totalGPUs += gpuCount;

      const machineType = instance.machineType?.split("/").pop() || "unknown";
      // Rough cost estimate: n1-standard-1 ≈ $0.0475/hr ≈ $1.14/day
      const cpuCount = parseInt(machineType.split("-").pop() || "1");
      const dailyCost = cpuCount * 1.14 + (gpuCount * 59.52); // V100 ≈ $2.48/hr ≈ $59.52/day

      services.push({
        serviceName: `compute:${instance.name}:${zone.split("/").pop()}`,
        metrics: [
          { name: "Instance Running", value: 1, unit: "instances", thresholdKey: "computeInstanceCount" },
          ...(gpuCount > 0 ? [{ name: "GPU Accelerators", value: gpuCount, unit: "GPUs", thresholdKey: "computeGPUCount" }] : []),
        ],
        estimatedDailyCostUSD: dailyCost,
      });
    }
  }

  // Add aggregate metric
  if (totalInstances > 0) {
    services.unshift({
      serviceName: "compute:all-instances",
      metrics: [
        { name: "Total Running Instances", value: totalInstances, unit: "instances", thresholdKey: "computeInstanceCount" },
        { name: "Total GPUs", value: totalGPUs, unit: "GPUs", thresholdKey: "computeGPUCount" },
      ],
      estimatedDailyCostUSD: 0, // Avoid double-counting
    });
  }

  return services;
}

// ─── GKE Clusters ───────────────────────────────────────────────────────────

async function listGKEClusters(
  accessToken: string, projectId: string
): Promise<ServiceUsage[]> {
  const res = await fetch(
    `https://container.googleapis.com/v1/projects/${projectId}/locations/-/clusters`,
    { headers: { "Authorization": `Bearer ${accessToken}` } }
  );

  if (!res.ok) return [];
  const text = await res.text();
  const data = JSON.parse(text);

  return (data.clusters || []).map((cluster: any) => {
    let totalNodes = 0;
    for (const pool of cluster.nodePools || []) {
      totalNodes += pool.initialNodeCount || 0;
      if (pool.autoscaling?.enabled) {
        totalNodes = Math.max(totalNodes, pool.autoscaling.minNodeCount || 0);
      }
    }

    // GKE management fee: $0.10/hr per cluster + node costs
    const dailyCost = 2.40 + (totalNodes * 1.14);

    return {
      serviceName: `gke:${cluster.name}`,
      metrics: [
        { name: "GKE Nodes", value: totalNodes, unit: "nodes", thresholdKey: "gkeNodeCount" },
      ],
      estimatedDailyCostUSD: dailyCost,
    };
  });
}

// ─── BigQuery ───────────────────────────────────────────────────────────────

async function queryBigQueryUsage(
  accessToken: string, projectId: string
): Promise<ServiceUsage[]> {
  const now = new Date();
  const oneDayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);

  const res = await fetch(
    `https://bigquery.googleapis.com/bigquery/v2/projects/${projectId}/jobs?` + new URLSearchParams({
      projection: "full",
      minCreationTime: oneDayAgo.getTime().toString(),
      maxResults: "100",
    }),
    { headers: { "Authorization": `Bearer ${accessToken}` } }
  );

  if (!res.ok) return [];
  const text = await res.text();
  const data = JSON.parse(text);

  let totalBytesProcessed = 0;
  for (const job of data.jobs || []) {
    totalBytesProcessed += parseInt(job.statistics?.totalBytesProcessed || "0");
  }

  if (totalBytesProcessed === 0) return [];

  // BigQuery pricing: $6.25/TB on-demand
  const tbProcessed = totalBytesProcessed / (1024 ** 4);
  const dailyCost = tbProcessed * 6.25;

  return [{
    serviceName: `bq:${projectId}`,
    metrics: [
      { name: "BigQuery Bytes Processed", value: totalBytesProcessed, unit: "bytes", thresholdKey: "bigqueryBytesPerDay" },
    ],
    estimatedDailyCostUSD: dailyCost,
  }];
}

// ─── Cloud Functions ────────────────────────────────────────────────────────

async function listCloudFunctions(
  accessToken: string, projectId: string, region: string
): Promise<ServiceUsage[]> {
  const res = await fetch(
    `https://cloudfunctions.googleapis.com/v2/projects/${projectId}/locations/${region}/functions`,
    { headers: { "Authorization": `Bearer ${accessToken}` } }
  );

  if (!res.ok) return [];
  const text = await res.text();
  const data = JSON.parse(text);

  return (data.functions || []).map((fn: any) => {
    const name = fn.name?.split("/").pop() || "unknown";
    const maxInstances = fn.serviceConfig?.maxInstanceCount || 100;

    return {
      serviceName: `gcf:${name}`,
      metrics: [
        { name: "Max Instances", value: maxInstances, unit: "instances", thresholdKey: "cloudFunctionInvocationsPerDay" },
      ],
      estimatedDailyCostUSD: 0, // Invocation-based, hard to estimate statically
    };
  });
}

// ─── Cloud Storage ──────────────────────────────────────────────────────────

async function listGCSBuckets(
  accessToken: string, projectId: string
): Promise<ServiceUsage[]> {
  const res = await fetch(
    `https://storage.googleapis.com/storage/v1/b?project=${projectId}`,
    { headers: { "Authorization": `Bearer ${accessToken}` } }
  );

  if (!res.ok) return [];
  const text = await res.text();
  const data = JSON.parse(text);

  return (data.items || []).map((bucket: any) => ({
    serviceName: `gcs:${bucket.name}`,
    metrics: [],
    estimatedDailyCostUSD: 0, // Would need monitoring API for actual egress data
  }));
}

// ─── Cloud Billing Cost Query ───────────────────────────────────────────────

async function queryBillingCosts(
  accessToken: string, projectId: string
): Promise<{ totalMonthToDate: number; dailyCosts: Record<string, number>; serviceCosts: Record<string, number> }> {
  // Use BigQuery billing export if available, otherwise estimate from Cloud Run
  // For MVP, we query the Cloud Billing API's cost breakdown
  try {
    const now = new Date();
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().split("T")[0];
    const today = now.toISOString().split("T")[0];

    // Try Cloud Billing Budgets API for current spend
    const res = await fetch(
      `https://cloudbilling.googleapis.com/v1/projects/${projectId}/billingInfo`,
      { headers: { "Authorization": `Bearer ${accessToken}` } }
    );

    if (res.ok) {
      const text = await res.text();
      const billingInfo = JSON.parse(text);

      return {
        totalMonthToDate: 0, // Will be populated from budget alerts
        dailyCosts: {},
        serviceCosts: {},
      };
    }
  } catch {
    // Billing API access may be limited
  }

  return { totalMonthToDate: 0, dailyCosts: {}, serviceCosts: {} };
}

// ─── Security Monitoring ────────────────────────────────────────────────────

async function checkSecurityMetrics(
  accessToken: string, projectId: string, region: string, thresholds: ThresholdConfig
): Promise<SecurityEvent[]> {
  const events: SecurityEvent[] = [];

  // Check Cloud Run error rates via Cloud Monitoring
  try {
    const now = new Date();
    const fiveMinAgo = new Date(now.getTime() - 5 * 60 * 1000);

    const monitoringRes = await fetch(
      `https://monitoring.googleapis.com/v3/projects/${projectId}/timeSeries?` + new URLSearchParams({
        "filter": `metric.type="run.googleapis.com/request_count" AND resource.type="cloud_run_revision"`,
        "interval.startTime": fiveMinAgo.toISOString(),
        "interval.endTime": now.toISOString(),
        "aggregation.alignmentPeriod": "300s",
        "aggregation.perSeriesAligner": "ALIGN_SUM",
      }),
      { headers: { "Authorization": `Bearer ${accessToken}` } }
    );

    if (monitoringRes.ok) {
      const text = await monitoringRes.text();
      const data = JSON.parse(text);

      for (const ts of data.timeSeries || []) {
        const serviceName = ts.resource?.labels?.service_name || "unknown";
        const responseCode = ts.metric?.labels?.response_code_class || "";
        const value = parseInt(ts.points?.[0]?.value?.int64Value || "0");

        // Detect error spikes (5xx responses)
        if (responseCode === "5xx" && value > (thresholds.errorRatePercent || 100)) {
          events.push({
            type: "error_spike",
            severity: value > 1000 ? "critical" : "warning",
            serviceName,
            description: `${value} 5xx errors in last 5 minutes`,
            metrics: { errorCount: value },
            detectedAt: Date.now(),
          });
        }

        // Detect request spikes (potential DDoS)
        if (value > (thresholds.requestsPerMinute || 50000) * 5) {
          events.push({
            type: "request_spike",
            severity: "critical",
            serviceName,
            description: `${value} requests in last 5 minutes (${Math.round(value / 5)}/min)`,
            metrics: { requestsPerMinute: Math.round(value / 5) },
            detectedAt: Date.now(),
          });
        }
      }
    }
  } catch {
    // Monitoring API access may be limited
  }

  return events;
}

// ─── Kill Switch Actions ────────────────────────────────────────────────────

async function scaleDownService(
  accessToken: string, projectId: string, region: string, serviceName: string
): Promise<ActionResult> {
  try {
    const svcUrl = `https://run.googleapis.com/v2/projects/${projectId}/locations/${region}/services/${serviceName}`;
    const getRes = await fetch(svcUrl, { headers: { "Authorization": `Bearer ${accessToken}` } });

    if (!getRes.ok) {
      return { success: false, action: "scale-down", serviceName, details: `Failed to get service: ${getRes.status}` };
    }

    const text = await getRes.text();
    const service = JSON.parse(text);

    service.template.scaling = { ...service.template.scaling, maxInstanceCount: 0 };

    const updateRes = await fetch(`${svcUrl}?updateMask=template.scaling`, {
      method: "PATCH",
      headers: { "Authorization": `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify(service),
    });

    return {
      success: updateRes.ok,
      action: "scale-down",
      serviceName,
      details: updateRes.ok ? `Scaled down ${serviceName} to 0 instances` : `Failed: ${updateRes.status}`,
    };
  } catch (e: any) {
    return { success: false, action: "scale-down", serviceName, details: `Error: ${e.message}` };
  }
}

// ─── Extended Kill Switch Actions ────────────────────────────────────────────

async function stopComputeInstance(
  accessToken: string, projectId: string, zone: string, instanceName: string
): Promise<ActionResult> {
  const res = await fetch(
    `https://compute.googleapis.com/compute/v1/projects/${projectId}/zones/${zone}/instances/${instanceName}/stop`,
    { method: "POST", headers: { "Authorization": `Bearer ${accessToken}` } }
  );
  return {
    success: res.ok,
    action: "stop-instances",
    serviceName: `compute:${instanceName}:${zone}`,
    details: res.ok ? `Stopped instance ${instanceName} in ${zone}` : `Failed to stop: ${res.status}`,
  };
}

async function scaleGKENodePool(
  accessToken: string, projectId: string, location: string, clusterName: string, nodePoolName: string
): Promise<ActionResult> {
  const res = await fetch(
    `https://container.googleapis.com/v1/projects/${projectId}/locations/${location}/clusters/${clusterName}/nodePools/${nodePoolName}`,
    {
      method: "PUT",
      headers: { "Authorization": `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        autoscaling: { enabled: true, minNodeCount: 0, maxNodeCount: 0 },
      }),
    }
  );
  return {
    success: res.ok,
    action: "scale-down",
    serviceName: `gke:${clusterName}:${nodePoolName}`,
    details: res.ok ? `Scaled GKE node pool ${nodePoolName} to 0` : `Failed: ${res.status}`,
  };
}

async function setBigQueryQuota(
  accessToken: string, projectId: string
): Promise<ActionResult> {
  // Set custom quota to 0 bytes per day — non-destructive, blocks new queries
  const res = await fetch(
    `https://serviceusage.googleapis.com/v1beta1/projects/${projectId}/services/bigquery.googleapis.com/consumerQuotaMetrics/bigquery.googleapis.com%2Fquota%2Fquery%2Fusage/limits/%2Fd%2Fproject/consumerOverrides`,
    {
      method: "POST",
      headers: { "Authorization": `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ overrideValue: "0" }),
    }
  );
  return {
    success: res.ok,
    action: "set-quota",
    serviceName: `bq:${projectId}`,
    details: res.ok ? `Set BigQuery daily query quota to 0 bytes` : `Failed to set quota: ${res.status}`,
  };
}

async function disableGCPService(
  accessToken: string, projectId: string, serviceName: string
): Promise<ActionResult> {
  const res = await fetch(
    `https://serviceusage.googleapis.com/v1/projects/${projectId}/services/${serviceName}:disable`,
    {
      method: "POST",
      headers: { "Authorization": `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ disableDependentServices: false }),
    }
  );
  return {
    success: res.ok,
    action: "disable-service",
    serviceName,
    details: res.ok ? `Disabled GCP API: ${serviceName}` : `Failed to disable: ${res.status}`,
  };
}

async function disableProjectBilling(
  accessToken: string, projectId: string
): Promise<ActionResult> {
  const res = await fetch(
    `https://cloudbilling.googleapis.com/v1/projects/${projectId}/billingInfo`,
    {
      method: "PUT",
      headers: { "Authorization": `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ billingAccountName: "" }),
    }
  );
  return {
    success: res.ok,
    action: "disable-billing",
    serviceName: `project:${projectId}`,
    details: res.ok ? `BILLING DISABLED for project ${projectId}` : `Failed to disable billing: ${res.status}`,
  };
}

async function scaleCloudFunction(
  accessToken: string, projectId: string, region: string, functionName: string
): Promise<ActionResult> {
  const fnUrl = `https://cloudfunctions.googleapis.com/v2/projects/${projectId}/locations/${region}/functions/${functionName}`;
  const getRes = await fetch(fnUrl, { headers: { "Authorization": `Bearer ${accessToken}` } });

  if (!getRes.ok) {
    return { success: false, action: "scale-down", serviceName: `gcf:${functionName}`, details: `Failed to get function: ${getRes.status}` };
  }

  const text = await getRes.text();
  const fn = JSON.parse(text);
  fn.serviceConfig = { ...fn.serviceConfig, maxInstanceCount: 0 };

  const updateRes = await fetch(`${fnUrl}?updateMask=serviceConfig.maxInstanceCount`, {
    method: "PATCH",
    headers: { "Authorization": `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify(fn),
  });

  return {
    success: updateRes.ok,
    action: "scale-down",
    serviceName: `gcf:${functionName}`,
    details: updateRes.ok ? `Scaled Cloud Function ${functionName} to 0 instances` : `Failed: ${updateRes.status}`,
  };
}

// ─── Provider Implementation ────────────────────────────────────────────────

export const gcpProvider: CloudProvider = {
  id: "gcp",
  name: "Google Cloud Platform",

  async checkUsage(credential, thresholds): Promise<UsageResult> {
    const { serviceAccountJson, projectId, region } = credential;
    if (!serviceAccountJson || !projectId) {
      throw new Error("Missing GCP service account JSON or project ID");
    }

    const accessToken = await getAccessToken(serviceAccountJson);
    const gcpRegion = region || "us-central1";

    const [cloudRunServices, computeServices, gkeServices, bqServices, gcfServices, gcsServices, billingData, securityEvents] = await Promise.all([
      listCloudRunServices(accessToken, projectId, gcpRegion),
      listComputeInstances(accessToken, projectId),
      listGKEClusters(accessToken, projectId),
      queryBigQueryUsage(accessToken, projectId),
      listCloudFunctions(accessToken, projectId, gcpRegion),
      listGCSBuckets(accessToken, projectId),
      queryBillingCosts(accessToken, projectId),
      checkSecurityMetrics(accessToken, projectId, gcpRegion, thresholds),
    ]);

    const services = [...cloudRunServices, ...computeServices, ...gkeServices, ...bqServices, ...gcfServices, ...gcsServices];

    // Check per-service threshold violations
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

    const monthlyLimit = thresholds.monthlySpendLimitUSD;
    const totalDailyCost = services.reduce((sum, s) => sum + s.estimatedDailyCostUSD, 0);

    if (monthlyLimit) {
      const projectedMonthlyCost = totalDailyCost * 30;
      if (projectedMonthlyCost > monthlyLimit) {
        violations.push({
          serviceName: "all-services",
          metricName: "Projected Monthly Cost",
          currentValue: projectedMonthlyCost,
          threshold: monthlyLimit,
          unit: "USD",
          severity: projectedMonthlyCost > monthlyLimit * 1.5 ? "critical" : "warning",
        });
      }
    }

    return {
      provider: "gcp",
      accountId: projectId,
      checkedAt: Date.now(),
      services,
      totalEstimatedDailyCostUSD: totalDailyCost,
      violations,
      securityEvents,
    };
  },

  async executeKillSwitch(credential, serviceName, action): Promise<ActionResult> {
    const { serviceAccountJson, projectId, region } = credential;
    if (!serviceAccountJson || !projectId) {
      throw new Error("Missing GCP credentials");
    }
    const accessToken = await getAccessToken(serviceAccountJson);
    const gcpRegion = region || "us-central1";

    // Route by service type prefix and action
    const [serviceType, ...rest] = serviceName.split(":");

    switch (action) {
      case "disable-billing":
        return disableProjectBilling(accessToken, projectId);

      case "disable-service":
        return disableGCPService(accessToken, projectId, serviceName);

      case "set-quota":
        return setBigQueryQuota(accessToken, projectId);

      case "stop-instances": {
        // compute:instance-name:zone
        const instanceName = rest[0];
        const zone = rest[1] || gcpRegion;
        return stopComputeInstance(accessToken, projectId, zone, instanceName);
      }

      case "scale-down":
      default:
        switch (serviceType) {
          case "compute": {
            const instanceName = rest[0];
            const zone = rest[1] || gcpRegion;
            return stopComputeInstance(accessToken, projectId, zone, instanceName);
          }
          case "gke": {
            const clusterName = rest[0];
            const nodePoolName = rest[1] || "default-pool";
            return scaleGKENodePool(accessToken, projectId, gcpRegion, clusterName, nodePoolName);
          }
          case "bq":
            return setBigQueryQuota(accessToken, projectId);
          case "gcf":
            return scaleCloudFunction(accessToken, projectId, gcpRegion, rest[0]);
          default:
            // Cloud Run services (original behavior)
            return scaleDownService(accessToken, projectId, gcpRegion, serviceName);
        }
    }
  },

  async validateCredential(credential): Promise<ValidationResult> {
    const { serviceAccountJson, projectId } = credential;
    if (!serviceAccountJson || !projectId) {
      return { valid: false, error: "Missing service account JSON or project ID" };
    }

    try {
      const accessToken = await getAccessToken(serviceAccountJson);
      const res = await fetch(
        `https://cloudresourcemanager.googleapis.com/v1/projects/${projectId}`,
        { headers: { "Authorization": `Bearer ${accessToken}` } }
      );

      if (!res.ok) return { valid: false, error: `API returned ${res.status}` };

      const text = await res.text();
      const project = JSON.parse(text);

      return { valid: true, accountId: project.projectId, accountName: project.name };
    } catch (e: any) {
      return { valid: false, error: e.message };
    }
  },

  getDefaultThresholds(): ThresholdConfig {
    return {
      monthlySpendLimitUSD: 500,
      requestsPerMinute: 50000,
      errorRatePercent: 50,
      computeInstanceCount: 10,
      computeGPUCount: 0,
      gkeNodeCount: 20,
      bigqueryBytesPerDay: 1_000_000_000_000, // 1 TB
      cloudFunctionInvocationsPerDay: 1_000_000,
      gcsEgressGBPerDay: 100,
    };
  },
};
