/**
 * Forensic Snapshot Service
 *
 * Captures the state of a service at the moment a kill switch triggers.
 * Preserves evidence for post-incident analysis and compliance.
 *
 * Captures:
 * - Service configuration (env vars names, scaling, routes)
 * - Recent logs (last N minutes)
 * - Usage metrics at time of incident
 * - Network/connection state
 * - Database snapshot trigger (if configured)
 *
 * All snapshots are written with SHA-256 integrity hashes for chain of custody.
 */

import { createHash } from "crypto";
import type { ForensicSnapshot, DecryptedCredential, ProviderId } from "../providers/types.js";

let snapshotCounter = 0;

function generateSnapshotId(): string {
  return `snap-${Date.now()}-${++snapshotCounter}`;
}

function computeIntegrityHash(data: any): string {
  return createHash("sha256").update(JSON.stringify(data)).digest("hex");
}

/**
 * Capture a forensic snapshot for a Cloudflare Worker
 */
async function captureCloudflareSnapshot(
  credential: DecryptedCredential,
  serviceName: string,
  trigger: string
): Promise<Partial<ForensicSnapshot["data"]>> {
  const { apiToken, accountId } = credential;
  if (!apiToken || !accountId) return {};

  const headers = { "Authorization": `Bearer ${apiToken}`, "Content-Type": "application/json" };
  const baseUrl = `https://api.cloudflare.com/client/v4/accounts/${accountId}`;
  const data: Partial<ForensicSnapshot["data"]> = {};

  // Capture service config
  try {
    const res = await fetch(`${baseUrl}/workers/scripts/${serviceName}/settings`, { headers });
    if (res.ok) {
      const text = await res.text();
      const config = JSON.parse(text);
      data.serviceConfig = {
        bindings: config.result?.bindings?.map((b: any) => ({ type: b.type, name: b.name })) || [],
        compatibilityDate: config.result?.compatibility_date,
        usageModel: config.result?.usage_model,
      };
      // Extract env var NAMES only (never values)
      data.environmentVariables = config.result?.bindings
        ?.filter((b: any) => b.type === "plain_text" || b.type === "secret_text")
        ?.map((b: any) => b.name) || [];
    }
  } catch (e) {
    data.serviceConfig = { error: `Failed to capture: ${e}` };
  }

  // Capture recent metrics (last 30 minutes)
  try {
    const thirtyMinAgo = new Date(Date.now() - 30 * 60 * 1000).toISOString();
    const query = `{
      viewer {
        accounts(filter: {accountTag: "${accountId}"}) {
          workersInvocationsAdaptive(
            filter: {scriptName: "${serviceName}", datetime_geq: "${thirtyMinAgo}"},
            limit: 1
          ) {
            sum { requests errors subrequests wallTime }
          }
        }
      }
    }`;

    const res = await fetch("https://api.cloudflare.com/client/v4/graphql", {
      method: "POST",
      headers,
      body: JSON.stringify({ query }),
    });

    if (res.ok) {
      const text = await res.text();
      const gql = JSON.parse(text);
      const metrics = gql.data?.viewer?.accounts?.[0]?.workersInvocationsAdaptive?.[0]?.sum;
      if (metrics) {
        data.recentMetrics = {
          requests: [metrics.requests],
          errors: [metrics.errors],
          subrequests: [metrics.subrequests],
          wallTimeMs: [metrics.wallTime / 1000],
        };
      }
    }
  } catch (e) {
    // Non-fatal
  }

  // Capture custom domains / routes
  try {
    const res = await fetch(`${baseUrl}/workers/domains?service=${serviceName}`, { headers });
    if (res.ok) {
      const text = await res.text();
      const domains = JSON.parse(text);
      data.networkRules = {
        customDomains: domains.result?.map((d: any) => d.hostname) || [],
      };
    }
  } catch (e) {
    // Non-fatal
  }

  return data;
}

/**
 * Capture a forensic snapshot for a GCP Cloud Run service
 */
async function captureGCPSnapshot(
  credential: DecryptedCredential,
  serviceName: string,
  trigger: string
): Promise<Partial<ForensicSnapshot["data"]>> {
  const { serviceAccountJson, projectId, region } = credential;
  if (!serviceAccountJson || !projectId) return {};

  const sa = JSON.parse(serviceAccountJson);
  const accessToken = sa.access_token;
  if (!accessToken) return {};

  const gcpRegion = region || "us-central1";
  const data: Partial<ForensicSnapshot["data"]> = {};

  // Capture service config
  try {
    const res = await fetch(
      `https://run.googleapis.com/v2/projects/${projectId}/locations/${gcpRegion}/services/${serviceName}`,
      { headers: { "Authorization": `Bearer ${accessToken}` } }
    );

    if (res.ok) {
      const text = await res.text();
      const service = JSON.parse(text);
      data.serviceConfig = {
        scaling: service.template?.scaling,
        containers: service.template?.containers?.map((c: any) => ({
          image: c.image,
          resources: c.resources,
          ports: c.ports,
        })),
        conditions: service.conditions,
        latestRevision: service.latestReadyRevision,
      };
      // Env var names only
      data.environmentVariables = service.template?.containers?.[0]?.env?.map((e: any) => e.name) || [];
    }
  } catch (e) {
    data.serviceConfig = { error: `Failed: ${e}` };
  }

  // Capture recent logs
  try {
    const logsUrl = `https://logging.googleapis.com/v2/entries:list`;
    const thirtyMinAgo = new Date(Date.now() - 30 * 60 * 1000).toISOString();

    const res = await fetch(logsUrl, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        resourceNames: [`projects/${projectId}`],
        filter: `resource.type="cloud_run_revision" AND resource.labels.service_name="${serviceName}" AND timestamp>="${thirtyMinAgo}"`,
        orderBy: "timestamp desc",
        pageSize: 50,
      }),
    });

    if (res.ok) {
      const text = await res.text();
      const logs = JSON.parse(text);
      data.recentLogs = logs.entries?.map((e: any) => `${e.timestamp} ${e.severity} ${e.textPayload || JSON.stringify(e.jsonPayload || {})}`) || [];
    }
  } catch (e) {
    // Non-fatal — logs may require additional permissions
  }

  return data;
}

/**
 * Capture a forensic snapshot for an AWS service
 */
async function captureAWSSnapshot(
  credential: DecryptedCredential,
  serviceName: string,
  trigger: string
): Promise<Partial<ForensicSnapshot["data"]>> {
  // AWS forensics require SDK calls — for now capture basic metadata
  // Full implementation would use EC2 DescribeInstances, Lambda GetFunction, etc.
  const data: Partial<ForensicSnapshot["data"]> = {};

  const [serviceType, ...rest] = serviceName.split(":");
  const serviceId = rest.join(":");

  data.serviceConfig = {
    serviceType,
    serviceId,
    region: credential.awsRegion || "us-east-1",
    capturedAt: new Date().toISOString(),
    trigger,
  };

  // Environment variable names are not accessible without SDK calls
  // This is intentionally minimal — extended in future with SDK integration
  data.environmentVariables = [];
  data.recentLogs = [`Forensic snapshot triggered by: ${trigger}`];

  return data;
}

/**
 * Capture a complete forensic snapshot
 */
export async function captureSnapshot(
  credential: DecryptedCredential,
  serviceName: string,
  trigger: string,
  incidentId: string
): Promise<ForensicSnapshot> {
  const snapshotId = generateSnapshotId();

  let providerData: Partial<ForensicSnapshot["data"]> = {};

  if (credential.provider === "cloudflare") {
    providerData = await captureCloudflareSnapshot(credential, serviceName, trigger);
  } else if (credential.provider === "gcp") {
    providerData = await captureGCPSnapshot(credential, serviceName, trigger);
  } else if (credential.provider === "aws") {
    providerData = await captureAWSSnapshot(credential, serviceName, trigger);
  }

  const snapshot: ForensicSnapshot = {
    id: snapshotId,
    incidentId,
    capturedAt: Date.now(),
    provider: credential.provider,
    serviceName,
    trigger,
    data: {
      serviceConfig: providerData.serviceConfig,
      recentLogs: providerData.recentLogs,
      recentMetrics: providerData.recentMetrics,
      environmentVariables: providerData.environmentVariables,
      networkRules: providerData.networkRules,
    },
    integrityHash: "", // Computed below
  };

  // Compute integrity hash over all data (chain of custody)
  snapshot.integrityHash = computeIntegrityHash(snapshot.data);

  return snapshot;
}
