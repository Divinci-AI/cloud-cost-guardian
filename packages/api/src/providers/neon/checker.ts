/**
 * Neon Provider
 *
 * Monitors Neon PostgreSQL usage: compute hours, storage, data transfer.
 * Free tier: 100 CU-hrs/month, 0.5 GB storage, 5 GB transfer.
 * Kill action: scale-down suspends all compute endpoints (reversible).
 */

import type { CloudProvider, ServiceUsage } from "../types.js";
import { evaluateViolations } from "../shared.js";

const NEON_BASE = "https://console.neon.tech/api/v2";

async function neonFetch(apiKey: string, path: string, options?: RequestInit, timeoutMs = 15_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${NEON_BASE}${path}`, {
      ...options,
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Accept": "application/json",
        "Content-Type": "application/json",
        ...(options?.headers || {}),
      },
      signal: controller.signal,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`Neon API ${res.status}: ${body.slice(0, 200)}`);
    }
    return res.json();
  } catch (err: any) {
    if (err.name === "AbortError") throw new Error(`Neon API timeout after ${timeoutMs}ms`);
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

export const neonProvider: CloudProvider = {
  id: "neon",
  name: "Neon",

  async checkUsage(credential, thresholds) {
    const key = credential.neonApiKey!;

    // Fetch projects (scoped or all)
    let projects: any[];
    if (credential.neonProjectId) {
      const p = await neonFetch(key, `/projects/${credential.neonProjectId}`) as any;
      projects = [p.project];
    } else {
      const list = await neonFetch(key, "/projects") as any;
      projects = list.projects || [];
    }

    // Fetch this-month consumption for all projects
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().split("T")[0];
    const monthEnd = new Date(now.getFullYear(), now.getMonth() + 1, 0).toISOString().split("T")[0];
    const projectIds = projects.map((p: any) => p.id).join(",");

    let consumptionByProject: Record<string, any> = {};
    try {
      const consumption = await neonFetch(
        key,
        `/consumption_history/projects?from=${monthStart}&to=${monthEnd}T23:59:59Z&granularity=monthly&project_ids=${projectIds}`
      ) as any;
      for (const entry of consumption.projects || []) {
        consumptionByProject[entry.project_id] = entry;
      }
    } catch {
      // Consumption API unavailable — fall back to project-level usage fields
    }

    const services: ServiceUsage[] = [];
    let totalDailyCost = 0;

    for (const project of projects) {
      const consumption = consumptionByProject[project.id];
      const periods = consumption?.periods || [];

      let computeSeconds = 0;
      let storageBytes = 0;
      let dataTransferBytes = 0;

      for (const period of periods) {
        computeSeconds += period.compute_time_seconds || 0;
        dataTransferBytes += period.data_transfer_bytes || 0;
        // Storage is a snapshot (take max)
        const s = period.synthetic_storage_size_bytes || 0;
        if (s > storageBytes) storageBytes = s;
      }

      // Fall back to project fields if consumption unavailable
      if (!periods.length) {
        computeSeconds = project.compute_time_seconds || 0;
        dataTransferBytes = project.data_transfer_bytes || 0;
        storageBytes = project.synthetic_storage_size_bytes || 0;
      }

      const computeHours = computeSeconds / 3600;
      const storageMB = storageBytes / (1024 * 1024);
      const transferGB = dataTransferBytes / (1024 * 1024 * 1024);

      // Cost estimate (free_v2 plan = $0; paid = $0.16/CU-hr, $0.000164/GB-hr storage, $0.09/GB transfer)
      const plan = project.settings?.plan || project.plan || "free";
      const isFree = plan.startsWith("free");
      const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
      const dailyCost = isFree ? 0 : (computeHours / daysInMonth) * 0.16 + (storageMB / 1024 / daysInMonth) * 0.15 + (transferGB / daysInMonth) * 0.09;
      totalDailyCost += dailyCost;

      services.push({
        serviceName: `neon:${project.id}`,
        metrics: [
          { name: "Compute", value: Math.round(computeHours * 100) / 100, unit: "CU-hrs", thresholdKey: "neonComputeHoursPerMonth" },
          { name: "Storage", value: Math.round(storageMB * 10) / 10, unit: "MB", thresholdKey: "neonStorageMB" },
          { name: "Data Transfer", value: Math.round(transferGB * 100) / 100, unit: "GB", thresholdKey: "neonDataTransferGB" },
        ],
        estimatedDailyCostUSD: dailyCost,
      });
    }

    const violations = evaluateViolations(services, thresholds, totalDailyCost, "neonDailyCostUSD", "neon-billing");
    return {
      provider: "neon",
      accountId: credential.neonProjectId || "neon",
      checkedAt: Date.now(),
      services,
      totalEstimatedDailyCostUSD: totalDailyCost,
      violations,
      securityEvents: [],
    };
  },

  async executeKillSwitch(credential, serviceName, action) {
    const key = credential.neonApiKey!;
    const projectId = serviceName.startsWith("neon:") ? serviceName.slice(5) : serviceName;

    if (action === "scale-down") {
      try {
        const { endpoints } = await neonFetch(key, `/projects/${projectId}/endpoints`) as any;
        let suspended = 0;
        for (const ep of endpoints || []) {
          if (ep.type === "read_write" || ep.type === "read_only") {
            await neonFetch(key, `/projects/${projectId}/endpoints/${ep.id}`, {
              method: "PATCH",
              body: JSON.stringify({ endpoint: { autosuspend_duration_seconds: 0 } }),
            });
            suspended++;
          }
        }
        return { success: true, action, serviceName, details: `Suspended ${suspended} compute endpoint(s) in project ${projectId}` };
      } catch (err: any) {
        return { success: false, action, serviceName, details: err.message };
      }
    }

    if (action === "delete") {
      try {
        await neonFetch(key, `/projects/${projectId}`, { method: "DELETE" });
        return { success: true, action, serviceName, details: `Deleted Neon project ${projectId}` };
      } catch (err: any) {
        return { success: false, action, serviceName, details: err.message };
      }
    }

    return { success: false, action, serviceName, details: `Action ${action} not supported for Neon` };
  },

  async validateCredential(credential) {
    if (!credential.neonApiKey) return { valid: false, error: "Missing Neon API key" };
    try {
      if (credential.neonProjectId) {
        const { project } = await neonFetch(credential.neonApiKey, `/projects/${credential.neonProjectId}`) as any;
        return { valid: true, accountId: project.id, accountName: `Neon — ${project.name}` };
      }
      const { projects } = await neonFetch(credential.neonApiKey, "/projects") as any;
      const count = (projects || []).length;
      return { valid: true, accountId: "neon", accountName: `Neon (${count} project${count !== 1 ? "s" : ""})` };
    } catch (err: any) {
      return { valid: false, error: err.message };
    }
  },

  getDefaultThresholds() {
    return {
      neonComputeHoursPerMonth: 80,  // Alert at 80% of free 100 CU-hr limit
      neonStorageMB: 400,            // Alert at 80% of free 512 MB limit
      neonDataTransferGB: 4,         // Alert at 80% of free 5 GB limit
      neonDailyCostUSD: 1.00,        // For paid plans
      monthlySpendLimitUSD: 30,
    };
  },
};
