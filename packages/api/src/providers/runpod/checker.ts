/**
 * RunPod Provider
 *
 * Monitors GPU pods (on-demand & spot), serverless endpoints, and network volumes.
 * Kill actions include pod stop/terminate and serverless endpoint scaling.
 *
 * Uses RunPod's GraphQL API for pod management and REST API for serverless.
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

// `cost` violations auto-disconnect; other categories alert-only by default.
const RUNPOD_METRIC_CATEGORIES: Record<string, MetricCategory> = {
  runpodDailyCostUSD: "cost",
  monthlySpendLimitUSD: "cost",
  runpodGPUPodCount: "count",
  runpodSpotPodCount: "count",
  runpodServerlessWorkers: "count",
  runpodNetworkVolumeGB: "storage",
};

// ─── API Helpers ───────────────────────────────────────────────────────────

const RUNPOD_GRAPHQL_URL = "https://api.runpod.io/graphql";

interface RunPodCreds {
  apiKey: string;
}

function getRunPodCredentials(credential: DecryptedCredential): RunPodCreds {
  if (!credential.runpodApiKey) {
    throw new Error("Missing RunPod API key");
  }
  return { apiKey: credential.runpodApiKey };
}

async function graphqlRequest(creds: RunPodCreds, query: string, variables?: Record<string, unknown>): Promise<any> {
  const response = await fetch(RUNPOD_GRAPHQL_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${creds.apiKey}`,
    },
    body: JSON.stringify({ query, variables }),
  });

  if (!response.ok) {
    throw new Error(`RunPod API error: ${response.status} ${response.statusText}`);
  }

  const result: any = await response.json();
  if (result.errors?.length) {
    throw new Error(`RunPod GraphQL error: ${result.errors[0].message}`);
  }
  return result.data;
}

// ─── GPU Cost Estimates (USD/hr) ───────────────────────────────────────────

const GPU_HOURLY_RATES: Record<string, number> = {
  "NVIDIA A100 80GB":  1.64,
  "NVIDIA A100 40GB":  1.22,
  "NVIDIA H100 80GB":  3.29,
  "NVIDIA A40":        0.69,
  "NVIDIA RTX A6000":  0.69,
  "NVIDIA RTX 4090":   0.69,
  "NVIDIA RTX 3090":   0.44,
  "NVIDIA RTX 3080":   0.35,
  "NVIDIA L40S":       1.14,
  "NVIDIA L40":        0.89,
};

function estimateHourlyCost(gpuType: string, gpuCount: number, isSpot: boolean): number {
  const baseRate = GPU_HOURLY_RATES[gpuType] || 1.00;
  return baseRate * gpuCount * (isSpot ? 0.3 : 1.0); // Spot is ~70% discount
}

// ─── Service Query Functions ───────────────────────────────────────────────

async function listGPUPods(creds: RunPodCreds): Promise<ServiceUsage[]> {
  const data = await graphqlRequest(creds, `
    query {
      myself {
        pods {
          id
          name
          desiredStatus
          runtime {
            uptimeInSeconds
            gpus {
              id
              gpuUtilPercent
              memoryUtilPercent
            }
          }
          machine {
            gpuDisplayName
          }
          gpuCount
          costPerHr
          podType
        }
      }
    }
  `);

  const pods = data?.myself?.pods || [];
  const services: ServiceUsage[] = [];
  let totalRunning = 0;
  let totalSpot = 0;

  for (const pod of pods) {
    if (pod.desiredStatus !== "RUNNING") continue;
    totalRunning++;
    const isSpot = pod.podType === "INTERRUPTABLE";
    if (isSpot) totalSpot++;

    const gpuType = pod.machine?.gpuDisplayName || "Unknown GPU";
    const gpuCount = pod.gpuCount || 1;
    const costPerHr = pod.costPerHr || estimateHourlyCost(gpuType, gpuCount, isSpot);
    const dailyCost = costPerHr * 24;

    services.push({
      serviceName: `pod:${pod.id}`,
      metrics: [
        { name: `${gpuType} x${gpuCount}${isSpot ? " (spot)" : ""}`, value: 1, unit: "pods", thresholdKey: "runpodGPUPodCount" },
        ...(isSpot ? [{ name: "Spot Pod", value: 1, unit: "pods", thresholdKey: "runpodSpotPodCount" }] : []),
      ],
      estimatedDailyCostUSD: dailyCost,
    });
  }

  if (totalRunning > 0) {
    services.unshift({
      serviceName: "pod:all-pods",
      metrics: [
        { name: "Total Running GPU Pods", value: totalRunning, unit: "pods", thresholdKey: "runpodGPUPodCount" },
        { name: "Total Spot Pods", value: totalSpot, unit: "pods", thresholdKey: "runpodSpotPodCount" },
      ],
      estimatedDailyCostUSD: 0,
    });
  }

  return services;
}

async function listServerlessEndpoints(creds: RunPodCreds): Promise<ServiceUsage[]> {
  const data = await graphqlRequest(creds, `
    query {
      myself {
        serverlessDiscount
        endpoints {
          id
          name
          workersMin
          workersMax
          workersStandby
          gpuIds
          idleTimeout
        }
      }
    }
  `);

  const endpoints = data?.myself?.endpoints || [];
  const services: ServiceUsage[] = [];
  let totalWorkers = 0;

  for (const ep of endpoints) {
    const activeWorkers = ep.workersStandby || ep.workersMin || 0;
    totalWorkers += activeWorkers;

    services.push({
      serviceName: `serverless:${ep.id}`,
      metrics: [
        { name: `Endpoint: ${ep.name || ep.id}`, value: activeWorkers, unit: "workers", thresholdKey: "runpodServerlessWorkers" },
      ],
      estimatedDailyCostUSD: activeWorkers * 0.50 * 24, // Rough: idle workers cost ~$0.50/hr
    });
  }

  if (endpoints.length > 0) {
    services.unshift({
      serviceName: "serverless:all-endpoints",
      metrics: [
        { name: "Total Serverless Workers", value: totalWorkers, unit: "workers", thresholdKey: "runpodServerlessWorkers" },
        { name: "Total Endpoints", value: endpoints.length, unit: "endpoints", thresholdKey: "runpodServerlessWorkers" },
      ],
      estimatedDailyCostUSD: 0,
    });
  }

  return services;
}

async function listNetworkVolumes(creds: RunPodCreds): Promise<ServiceUsage[]> {
  const data = await graphqlRequest(creds, `
    query {
      myself {
        networkVolumes {
          id
          name
          size
          dataCenterId
        }
      }
    }
  `);

  const volumes = data?.myself?.networkVolumes || [];
  const services: ServiceUsage[] = [];
  let totalGB = 0;

  for (const vol of volumes) {
    const sizeGB = vol.size || 0;
    totalGB += sizeGB;

    services.push({
      serviceName: `volume:${vol.id}`,
      metrics: [
        { name: `Volume: ${vol.name || vol.id}`, value: sizeGB, unit: "GB", thresholdKey: "runpodNetworkVolumeGB" },
      ],
      estimatedDailyCostUSD: sizeGB * 0.07 / 30, // $0.07/GB/month
    });
  }

  if (volumes.length > 0) {
    services.unshift({
      serviceName: "volume:all-volumes",
      metrics: [
        { name: "Total Network Volume Storage", value: totalGB, unit: "GB", thresholdKey: "runpodNetworkVolumeGB" },
      ],
      estimatedDailyCostUSD: 0,
    });
  }

  return services;
}

// ─── Kill Switch Actions ───────────────────────────────────────────────────

async function stopPod(creds: RunPodCreds, podId: string): Promise<ActionResult> {
  try {
    await graphqlRequest(creds, `
      mutation stopPod($input: PodStopInput!) {
        podStop(input: $input) {
          id
          desiredStatus
        }
      }
    `, { input: { podId } });

    return {
      success: true,
      action: "stop-pod",
      serviceName: `pod:${podId}`,
      details: `Stopped GPU pod ${podId} (volume data preserved)`,
    };
  } catch (e: any) {
    return { success: false, action: "stop-pod", serviceName: `pod:${podId}`, details: `Failed: ${e.message}` };
  }
}

async function terminatePod(creds: RunPodCreds, podId: string): Promise<ActionResult> {
  try {
    await graphqlRequest(creds, `
      mutation terminatePod($input: PodTerminateInput!) {
        podTerminate(input: $input) {
          id
        }
      }
    `, { input: { podId } });

    return {
      success: true,
      action: "terminate-pod",
      serviceName: `pod:${podId}`,
      details: `TERMINATED GPU pod ${podId} (container disk destroyed)`,
    };
  } catch (e: any) {
    return { success: false, action: "terminate-pod", serviceName: `pod:${podId}`, details: `Failed: ${e.message}` };
  }
}

async function scaleDownEndpoint(creds: RunPodCreds, endpointId: string): Promise<ActionResult> {
  try {
    await graphqlRequest(creds, `
      mutation updateEndpoint($input: UpdateEndpointInput!) {
        updateEndpoint(input: $input) {
          id
          workersMin
          workersMax
        }
      }
    `, {
      input: {
        endpointId,
        workersMin: 0,
        workersMax: 0,
      },
    });

    return {
      success: true,
      action: "scale-down",
      serviceName: `serverless:${endpointId}`,
      details: `Scaled serverless endpoint ${endpointId} to 0 workers`,
    };
  } catch (e: any) {
    return { success: false, action: "scale-down", serviceName: `serverless:${endpointId}`, details: `Failed: ${e.message}` };
  }
}

// ─── Provider Implementation ───────────────────────────────────────────────

export const runpodProvider: CloudProvider = {
  id: "runpod",
  name: "RunPod",

  async checkUsage(credential, thresholds): Promise<UsageResult> {
    const creds = getRunPodCredentials(credential);

    const [pods, serverless, volumes] = await Promise.all([
      listGPUPods(creds).catch(() => []),
      listServerlessEndpoints(creds).catch(() => []),
      listNetworkVolumes(creds).catch(() => []),
    ]);

    const services = [...pods, ...serverless, ...volumes];
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
            category: RUNPOD_METRIC_CATEGORIES[metric.thresholdKey],
          });
        }
      }
    }

    const totalDailyCost = services.reduce((sum, s) => sum + s.estimatedDailyCostUSD, 0);

    // Check daily cost threshold
    if (thresholds.runpodDailyCostUSD && totalDailyCost > thresholds.runpodDailyCostUSD) {
      violations.push({
        serviceName: "runpod:daily-cost",
        metricName: "Estimated Daily Cost",
        currentValue: totalDailyCost,
        threshold: thresholds.runpodDailyCostUSD,
        unit: "USD",
        severity: totalDailyCost > thresholds.runpodDailyCostUSD * 2 ? "critical" : "warning",
        category: "cost",
      });
    }

    return {
      provider: "runpod",
      accountId: credential.runpodApiKey?.slice(-4) || "unknown",
      checkedAt: Date.now(),
      services,
      totalEstimatedDailyCostUSD: totalDailyCost,
      violations,
      securityEvents: [],
    };
  },

  async executeKillSwitch(credential, serviceName, action): Promise<ActionResult> {
    const creds = getRunPodCredentials(credential);
    const [serviceType, ...rest] = serviceName.split(":");
    const serviceId = rest.join(":");

    switch (action) {
      case "stop-pod":
        return stopPod(creds, serviceId);

      case "terminate-pod":
      case "delete":
        if (serviceType === "pod") return terminatePod(creds, serviceId);
        return { success: false, action, serviceName, details: `Delete not supported for ${serviceType}` };

      case "scale-down":
        if (serviceType === "serverless") return scaleDownEndpoint(creds, serviceId);
        if (serviceType === "pod") return stopPod(creds, serviceId);
        return { success: false, action, serviceName, details: `Scale-down not supported for ${serviceType}` };

      case "stop-instances":
        if (serviceType === "pod") return stopPod(creds, serviceId);
        return { success: false, action, serviceName, details: `Stop not supported for ${serviceType}` };

      case "disconnect":
      default:
        // Default: stop pods, scale down serverless
        if (serviceType === "pod") return stopPod(creds, serviceId);
        if (serviceType === "serverless") return scaleDownEndpoint(creds, serviceId);
        return { success: false, action, serviceName, details: `Unknown service type: ${serviceType}` };
    }
  },

  async validateCredential(credential): Promise<ValidationResult> {
    if (!credential.runpodApiKey) {
      return { valid: false, error: "Missing RunPod API key" };
    }

    try {
      const creds = getRunPodCredentials(credential);
      const data = await graphqlRequest(creds, `
        query {
          myself {
            id
            email
            currentSpendPerHr
          }
        }
      `);

      const user = data?.myself;
      if (!user?.id) {
        return { valid: false, error: "Could not retrieve RunPod account info" };
      }

      return {
        valid: true,
        accountId: user.id,
        accountName: user.email || `RunPod ${user.id}`,
      };
    } catch (e: any) {
      return { valid: false, error: e.message };
    }
  },

  getDefaultThresholds(): ThresholdConfig {
    return {
      runpodGPUPodCount: 4,
      runpodSpotPodCount: 8,
      runpodServerlessWorkers: 10,
      runpodNetworkVolumeGB: 500,
      runpodDailyCostUSD: 50,
      monthlySpendLimitUSD: 1500,
    };
  },
};
