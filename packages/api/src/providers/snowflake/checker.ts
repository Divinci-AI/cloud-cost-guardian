/**
 * Snowflake Provider
 *
 * Monitors Snowflake usage: credits consumed, query counts, warehouses.
 * Kill actions: scale-down (resize warehouse), stop-instances (suspend warehouse).
 */

import type { CloudProvider, DecryptedCredential, ServiceUsage } from "../types.js";
import { evaluateViolations, providerFetch } from "../shared.js";

function snowflakeBase(cred: DecryptedCredential): string {
  return `https://${cred.snowflakeAccountName}.snowflakecomputing.com/api/v2`;
}

function snowflakeHeaders(cred: DecryptedCredential): Record<string, string> {
  const auth = Buffer.from(`${cred.snowflakeUsername}:${cred.snowflakePassword}`).toString("base64");
  return { "Authorization": `Basic ${auth}`, "Accept": "application/json" };
}

async function snowflakeSQL(cred: DecryptedCredential, sql: string): Promise<any> {
  return providerFetch(
    snowflakeBase(cred),
    "/statements",
    snowflakeHeaders(cred),
    "Snowflake",
    "POST",
    {
      statement: sql,
      warehouse: cred.snowflakeWarehouseName || "COMPUTE_WH",
      role: cred.snowflakeRole || "ACCOUNTADMIN",
    },
  );
}

export const snowflakeProvider: CloudProvider = {
  id: "snowflake",
  name: "Snowflake",

  async checkUsage(credential, thresholds) {
    const wh = credential.snowflakeWarehouseName || "COMPUTE_WH";
    if (!/^[A-Za-z0-9_]+$/.test(wh)) {
      throw new Error("Invalid warehouse name — must be alphanumeric");
    }

    let credits = 0;
    let queries = 0;
    let totalCost = 0;

    try {
      const creditResult = await snowflakeSQL(credential,
        "SELECT COALESCE(SUM(credits_used),0) as credits FROM snowflake.account_usage.warehouse_metering_history WHERE start_time >= DATEADD(day, -1, CURRENT_TIMESTAMP())");
      credits = Number(creditResult?.data?.[0]?.[0]) || 0;

      const queryResult = await snowflakeSQL(credential,
        "SELECT COUNT(*) FROM snowflake.account_usage.query_history WHERE start_time >= DATEADD(day, -1, CURRENT_TIMESTAMP())");
      queries = Number(queryResult?.data?.[0]?.[0]) || 0;

      // Snowflake credits ~$2-4/credit depending on edition
      totalCost = credits * 3;
      if (!isFinite(totalCost)) totalCost = 0;
    } catch {
      try {
        await snowflakeSQL(credential, "SELECT CURRENT_ACCOUNT()");
      } catch { throw new Error("Failed to connect to Snowflake"); }
    }

    const services: ServiceUsage[] = [{
      serviceName: "snowflake:compute",
      metrics: [
        { name: "Credits Today", value: Math.round(credits * 100) / 100, unit: "credits", thresholdKey: "snowflakeCreditsPerDay" },
        { name: "Queries Today", value: queries, unit: "queries", thresholdKey: "" },
      ],
      estimatedDailyCostUSD: totalCost,
    }];

    const violations = evaluateViolations(services, thresholds, totalCost, "snowflakeDailyCostUSD", "snowflake-billing", {
      // Snowflake credits ARE the cost metric (priced per-credit), so this
      // gets the kill semantic that "load" alone wouldn't.
      snowflakeCreditsPerDay: "cost",
    });
    return {
      provider: "snowflake", accountId: credential.snowflakeAccountName || "snowflake",
      checkedAt: Date.now(), services, totalEstimatedDailyCostUSD: totalCost,
      violations, securityEvents: [],
    };
  },

  async executeKillSwitch(credential, serviceName, action) {
    const wh = credential.snowflakeWarehouseName || "COMPUTE_WH";
    if (!/^[A-Za-z0-9_]+$/.test(wh)) {
      return { success: false, action, serviceName, details: "Invalid warehouse name — must be alphanumeric" };
    }
    if (action === "scale-down") {
      try {
        await snowflakeSQL(credential, `ALTER WAREHOUSE ${wh} SET WAREHOUSE_SIZE = 'X-SMALL'`);
        return { success: true, action, serviceName, details: `Warehouse ${wh} scaled down to X-SMALL` };
      } catch (err: any) {
        console.error(`[guardian] Snowflake scale-down failed:`, err.message);
        return { success: false, action, serviceName, details: "Failed to scale down warehouse" };
      }
    }
    if (action === "stop-instances") {
      try {
        await snowflakeSQL(credential, `ALTER WAREHOUSE ${wh} SUSPEND`);
        return { success: true, action, serviceName, details: `Warehouse ${wh} suspended` };
      } catch (err: any) {
        console.error(`[guardian] Snowflake suspend failed:`, err.message);
        return { success: false, action, serviceName, details: "Failed to suspend warehouse" };
      }
    }
    return { success: false, action, serviceName, details: `Action ${action} not supported for Snowflake` };
  },

  async validateCredential(credential) {
    if (!credential.snowflakeAccountName || !credential.snowflakeUsername || !credential.snowflakePassword) {
      return { valid: false, error: "Missing Snowflake account name, username, or password" };
    }
    try {
      const result = await snowflakeSQL(credential, "SELECT CURRENT_ACCOUNT()");
      const account = result?.data?.[0]?.[0] || credential.snowflakeAccountName;
      return { valid: true, accountId: account, accountName: `Snowflake (${account})` };
    } catch (err: any) {
      return { valid: false, error: err.message };
    }
  },

  getDefaultThresholds() {
    return { snowflakeCreditsPerDay: 10, snowflakeWarehouseCount: 3, snowflakeDailyCostUSD: 100, monthlySpendLimitUSD: 3000 };
  },
};
