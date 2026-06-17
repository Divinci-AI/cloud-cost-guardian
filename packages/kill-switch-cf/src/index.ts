/**
 * Cloudflare Billing Kill Switch
 *
 * A Cloudflare Worker that monitors usage metrics and automatically disconnects
 * runaway workers before they generate surprise bills. Born from an $80K
 * Durable Objects bill.
 *
 * Features:
 * - Monitors Durable Objects, Workers, R2, D1, Workers AI (Neurons), AI Gateway
 *   (upstream LLM $), and Vectorize usage in a single batched GraphQL query
 * - Auto-disconnects offending workers (reversible — removes routes/domains, not code)
 * - Separates the ALERT threshold from the KILL threshold (DISCONNECT_THRESHOLD_MULTIPLIER)
 *   so a cheap-but-busy service can't be auto-killed off a low alert floor
 * - Alert de-dup / cooldown (KV) so a daily-cumulative breach doesn't re-spam
 *   Discord/Slack every cron tick
 * - Surfaces analytics auth failures instead of silently reading empty (no blind spots)
 * - Alerts via PagerDuty, Discord, Slack, or custom webhooks
 * - Protected workers/resources list to prevent killing critical infrastructure
 * - Fail-closed HTTP endpoints (refuse unless ADMIN_SECRET is configured)
 *
 * @see https://github.com/divinci-ai/cloudflare-billing-kill-switch
 * @license MIT
 */

interface Env {
  // Required secrets (set via `wrangler secret put`)
  CLOUDFLARE_API_TOKEN: string;
  CLOUDFLARE_ACCOUNT_ID: string;

  // HTTP endpoint auth. If unset, non-health endpoints fail CLOSED (refuse).
  ADMIN_SECRET?: string;

  // Alert destinations (at least one recommended)
  PAGERDUTY_ROUTING_KEY?: string;  // Events API v2 integration key
  DISCORD_WEBHOOK_URL?: string;    // Discord channel webhook URL
  SLACK_WEBHOOK_URL?: string;      // Slack incoming webhook URL
  CUSTOM_WEBHOOK_URL?: string;     // Any HTTP endpoint that accepts POST JSON

  // Alert de-dup / kill-snapshot state (KV namespace). Optional but recommended:
  // without it, webhook alerts cannot be deduped and will re-fire every cron tick.
  ALERT_STATE?: KVNamespace;

  // Thresholds (configurable via wrangler.toml [vars])
  DO_REQUEST_THRESHOLD: string;           // Daily DO requests before alerting
  DO_WALLTIME_HOURS_THRESHOLD: string;    // Daily DO wall-time hours before alerting
  WORKER_REQUEST_THRESHOLD: string;       // Daily Worker requests before alerting
  R2_OPS_THRESHOLD: string;              // Daily R2 operations before alerting
  R2_STORAGE_GB_THRESHOLD: string;       // R2 storage GB before alerting
  D1_ROWS_READ_THRESHOLD: string;        // Daily D1 rows read before alerting
  D1_ROWS_WRITTEN_THRESHOLD: string;     // Daily D1 rows written before alerting
  QUEUE_OPS_THRESHOLD: string;           // Daily queue operations before alerting
  STREAM_MINUTES_THRESHOLD: string;      // Stream minutes before alerting
  AI_NEURONS_THRESHOLD: string;          // Daily Workers AI Neurons before alerting
  AI_GATEWAY_COST_THRESHOLD: string;     // Daily AI Gateway upstream $ before alerting
  VECTORIZE_DIMENSIONS_THRESHOLD: string; // Daily Vectorize queried dimensions before alerting

  // Kill switch behavior
  AUTO_DISCONNECT: string;   // "true" to auto-disconnect routes (reversible)
  AUTO_DELETE: string;       // "true" to auto-delete workers (nuclear, irreversible)
  DISCONNECT_THRESHOLD_MULTIPLIER: string; // Kill only above N× the alert threshold (default 10)
  ALERT_COOLDOWN_SECONDS: string;          // De-dup window for webhook alerts (default 21600 = 6h)
  PROTECTED_WORKERS: string; // Comma-separated worker names to never kill
  PROTECTED_RESOURCES: string; // Comma-separated R2/D1/Queue names to never kill

  ENVIRONMENT: string;
}

const CF_API = "https://api.cloudflare.com/client/v4";
const CF_GRAPHQL = `${CF_API}/graphql`;

type Severity = "critical" | "error" | "warning" | "info";

// ─── Usage shapes ────────────────────────────────────────────────────────────

interface DOUsage { scriptName: string; requests: number; wallTimeHours: number; }
interface WorkerUsage { scriptName: string; requests: number; errors: number; cpuTimeMs: number; }
interface R2Usage { bucketName: string; ops: number; storageGB: number; }
interface D1Usage { dbName: string; rowsRead: number; rowsWritten: number; }
// #1 Workers AI (Neurons) — the scariest 2026 runaway, previously unmonitored.
interface AIUsage { modelId: string; neurons: number; inputTokens: number; outputTokens: number; requests: number; }
// #2 AI Gateway — attributes UPSTREAM provider (OpenAI/Anthropic/Gemini) $.
interface AIGatewayUsage { gateway: string; provider: string; model: string; cost: number; erroredRequests: number; cachedRequests: number; }
// #3 Vectorize — billed per queried dimension.
interface VectorizeUsage { indexId: string; queriedDimensions: number; }

interface AllUsage {
  doUsage: DOUsage[];
  workerUsage: WorkerUsage[];
  r2Usage: R2Usage[];
  d1Usage: D1Usage[];
  aiUsage: AIUsage[];
  aiGatewayUsage: AIGatewayUsage[];
  vectorizeUsage: VectorizeUsage[];
  // #9 Surface analytics auth health instead of silently reading empty.
  analyticsAuth: "OK" | "FAILING";
  analyticsError?: string;
  extendedAnalytics: "OK" | "DEGRADED"; // AI/Gateway/Vectorize availability
  extendedError?: string;
}

interface CheckResult {
  violations: string[];
  actions: string[];
  severity: Severity;
  analyticsAuth: "OK" | "FAILING";
  extendedAnalytics: "OK" | "DEGRADED";
  usage: AllUsage;
}

// ─── Cloudflare GraphQL Analytics ───────────────────────────────────────────

type GraphQLErrorKind = "auth" | "rate-limit" | "graphql" | "parse" | "http";
type GraphQLResult = { ok: true; data: any } | { ok: false; kind: GraphQLErrorKind; message: string };

/**
 * Single GraphQL call. Returns a classified result instead of throwing, so the
 * caller can distinguish "you have no usage" (empty arrays) from "your token is
 * broken" (#9 — silent auth blindness was the bug we're fixing).
 */
async function cfGraphQL(env: Env, query: string): Promise<GraphQLResult> {
  let res: Response;
  try {
    res = await fetch(CF_GRAPHQL, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${env.CLOUDFLARE_API_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query }),
    });
  } catch (e) {
    return { ok: false, kind: "http", message: `fetch failed: ${e}` };
  }

  const text = await res.text();
  let data: any;
  try {
    data = JSON.parse(text);
  } catch {
    return { ok: false, kind: "parse", message: text.substring(0, 200) };
  }

  if (data.errors && data.errors.length) {
    const blob = JSON.stringify(data.errors);
    let kind: GraphQLErrorKind = "graphql";
    // CF analytics returns 10000 "Authentication error" when the token lacks
    // Account Analytics:Read — this is the silent-blindness case.
    if (/\b10000\b|9106|9109|authentication error|not authorized|account analytics/i.test(blob)) {
      kind = "auth";
    } else if (/\b10429\b|rate.?limit|too many request/i.test(blob)) {
      kind = "rate-limit";
    }
    return { ok: false, kind, message: blob.substring(0, 300) };
  }

  if (!res.ok) {
    return { ok: false, kind: "http", message: `HTTP ${res.status}: ${text.substring(0, 150)}` };
  }
  return { ok: true, data };
}

const acctTag = (env: Env) => env.CLOUDFLARE_ACCOUNT_ID.replace(/[^a-zA-Z0-9-]/g, "");
const todayUTC = () => new Date().toISOString().split("T")[0];

// #8 Batch all core datasets into ONE query under a single account{} selection.
// 4 sequential queries → 1 request; avoids the 10429 rate-limit that silently
// produced monitoring gaps.
const doField = (today: string) => `durableObjectsInvocationsAdaptiveGroups(limit: 50, filter: {date_geq: "${today}"}, orderBy: [sum_requests_DESC]) {
          dimensions { scriptName }
          sum { requests wallTime }
        }`;

const workerField = (today: string) => `workersInvocationsAdaptive(limit: 50, filter: {date_geq: "${today}"}, orderBy: [sum_requests_DESC]) {
          dimensions { scriptName }
          sum { requests errors wallTime }
        }`;

// No orderBy: r2StorageAdaptiveGroups' objectCount/payloadSize are max-aggregated
// gauges, so `sum_objectCount_DESC` is an invalid enum and errors the query. We
// iterate all returned buckets anyway, so ordering is unnecessary.
const r2Field = (today: string) => `r2StorageAdaptiveGroups(limit: 50, filter: {date_geq: "${today}"}) {
          dimensions { bucketName }
          sum { objectCount payloadSize uploadCount downloadCount }
        }`;

const d1Field = (today: string) => `d1AnalyticsAdaptiveGroups(limit: 50, filter: {date_geq: "${today}"}, orderBy: [sum_readQueries_DESC]) {
          dimensions { databaseId }
          sum { readQueries writeQueries rowsRead rowsWritten }
        }`;

function coreQuery(env: Env): string {
  const today = todayUTC();
  const acct = acctTag(env);
  return `{
    viewer {
      accounts(filter: {accountTag: "${acct}"}) {
        ${doField(today)}
        ${workerField(today)}
        ${r2Field(today)}
        ${d1Field(today)}
      }
    }
  }`;
}

// Extended (AI / AI Gateway / Vectorize) batched separately so a schema quirk in
// a newer dataset can't poison core coverage. Falls back to per-dataset queries.
function extendedQuery(env: Env): string {
  const today = todayUTC();
  const acct = acctTag(env);
  return `{
    viewer {
      accounts(filter: {accountTag: "${acct}"}) {
        ${aiInferenceField(today)}
        ${aiGatewayField(today)}
        ${vectorizeField(today)}
      }
    }
  }`;
}

const aiInferenceField = (today: string) => `aiInferenceAdaptiveGroups(limit: 100, filter: {date_geq: "${today}"}, orderBy: [sum_totalNeurons_DESC]) {
          count
          dimensions { modelId }
          sum { totalNeurons totalInputTokens totalOutputTokens totalInferenceTimeMs }
        }`;

const aiGatewayField = (today: string) => `aiGatewayRequestsAdaptiveGroups(limit: 100, filter: {date_geq: "${today}"}, orderBy: [sum_cost_DESC]) {
          dimensions { gateway provider model }
          sum { cost erroredRequests cachedRequests uncachedTokensIn uncachedTokensOut }
        }`;

// Gotcha (#3): vectorizeQueriesAdaptiveGroups has NO top-level `count` — selecting
// it errors. Only dimensions + sum.queriedVectorDimensions are valid.
const vectorizeField = (today: string) => `vectorizeQueriesAdaptiveGroups(limit: 50, filter: {date_geq: "${today}"}, orderBy: [sum_queriedVectorDimensions_DESC]) {
          dimensions { vectorizeIndexId }
          sum { queriedVectorDimensions }
        }`;

function wrapAccount(field: string, env: Env): string {
  return `{ viewer { accounts(filter: {accountTag: "${acctTag(env)}"}) { ${field} } } }`;
}

// Merge-safe: only assigns datasets present in `acct`, so it works both for the
// single batched response and for per-dataset fallback responses (no clobbering).
function parseCore(acct: any, usage: AllUsage): void {
  if (acct?.durableObjectsInvocationsAdaptiveGroups) {
    usage.doUsage = acct.durableObjectsInvocationsAdaptiveGroups.map((g: any) => ({
      scriptName: g.dimensions.scriptName,
      requests: g.sum.requests,
      wallTimeHours: g.sum.wallTime / 1e6 / 3600, // microseconds → hours
    }));
  }
  if (acct?.workersInvocationsAdaptive) {
    usage.workerUsage = acct.workersInvocationsAdaptive.map((g: any) => ({
      scriptName: g.dimensions.scriptName,
      requests: g.sum.requests,
      errors: g.sum.errors,
      cpuTimeMs: g.sum.wallTime / 1000,
    }));
  }
  if (acct?.r2StorageAdaptiveGroups) {
    usage.r2Usage = acct.r2StorageAdaptiveGroups.map((g: any) => ({
      bucketName: g.dimensions.bucketName,
      ops: (g.sum.uploadCount || 0) + (g.sum.downloadCount || 0),
      storageGB: (g.sum.payloadSize || 0) / (1024 * 1024 * 1024),
    }));
  }
  if (acct?.d1AnalyticsAdaptiveGroups) {
    usage.d1Usage = acct.d1AnalyticsAdaptiveGroups.map((g: any) => ({
      dbName: g.dimensions.databaseId,
      rowsRead: g.sum.rowsRead || 0,
      rowsWritten: g.sum.rowsWritten || 0,
    }));
  }
}

function parseExtended(acct: any, usage: AllUsage): void {
  if (acct?.aiInferenceAdaptiveGroups) {
    usage.aiUsage = acct.aiInferenceAdaptiveGroups.map((g: any) => ({
      modelId: g.dimensions.modelId,
      neurons: g.sum.totalNeurons || 0,
      inputTokens: g.sum.totalInputTokens || 0,
      outputTokens: g.sum.totalOutputTokens || 0,
      requests: g.count || 0,
    }));
  }
  if (acct?.aiGatewayRequestsAdaptiveGroups) {
    usage.aiGatewayUsage = acct.aiGatewayRequestsAdaptiveGroups.map((g: any) => ({
      gateway: g.dimensions.gateway,
      provider: g.dimensions.provider,
      model: g.dimensions.model,
      cost: g.sum.cost || 0,
      erroredRequests: g.sum.erroredRequests || 0,
      cachedRequests: g.sum.cachedRequests || 0,
    }));
  }
  if (acct?.vectorizeQueriesAdaptiveGroups) {
    usage.vectorizeUsage = acct.vectorizeQueriesAdaptiveGroups.map((g: any) => ({
      indexId: g.dimensions.vectorizeIndexId,
      queriedDimensions: g.sum.queriedVectorDimensions || 0,
    }));
  }
}

async function queryAllUsage(env: Env): Promise<AllUsage> {
  const usage: AllUsage = {
    doUsage: [], workerUsage: [], r2Usage: [], d1Usage: [],
    aiUsage: [], aiGatewayUsage: [], vectorizeUsage: [],
    analyticsAuth: "OK", extendedAnalytics: "OK",
  };

  // Core datasets — if these fail on auth, the operator is BLIND. Surface it.
  const core = await cfGraphQL(env, coreQuery(env));
  if (core.ok) {
    parseCore(core.data?.data?.viewer?.accounts?.[0] ?? {}, usage);
  } else if (core.kind === "auth") {
    // Auth failure means the token is broken — every dataset is blind. Surface
    // it loudly and skip extended (same token).
    usage.analyticsAuth = "FAILING";
    usage.analyticsError = `[${core.kind}] ${core.message}`;
    usage.extendedAnalytics = "DEGRADED";
    usage.extendedError = "skipped (core auth failing)";
    console.error(`[kill-switch] CORE ANALYTICS FAILING (auth): ${core.message}`);
    return usage;
  } else {
    // Non-auth failure (schema quirk, rate-limit) — fall back to per-dataset so
    // one bad dataset can't blind the other three.
    console.error(`[kill-switch] core batch failed (${core.kind}): ${core.message} — falling back to per-dataset`);
    const today = todayUTC();
    const coreFields: [string, string][] = [
      ["do", doField(today)],
      ["worker", workerField(today)],
      ["r2", r2Field(today)],
      ["d1", d1Field(today)],
    ];
    let authFailed = false;
    let anyFail = false;
    for (const [name, field] of coreFields) {
      const r = await cfGraphQL(env, wrapAccount(field, env));
      if (r.ok) {
        parseCore(r.data?.data?.viewer?.accounts?.[0] ?? {}, usage);
      } else {
        anyFail = true;
        if (r.kind === "auth") authFailed = true;
        console.error(`[kill-switch] core dataset ${name} unavailable (${r.kind}): ${r.message}`);
      }
    }
    // Only declare BLIND if a dataset actually failed on auth, or every dataset
    // failed. A single quirky dataset shouldn't flip analyticsAuth to FAILING.
    if (authFailed) {
      usage.analyticsAuth = "FAILING";
      usage.analyticsError = `[${core.kind}] ${core.message}`;
    } else if (anyFail) {
      console.error(`[kill-switch] core partially degraded: ${core.message}`);
    }
  }

  // Extended datasets — best-effort. A schema quirk here must not break core.
  const ext = await cfGraphQL(env, extendedQuery(env));
  if (ext.ok) {
    parseExtended(ext.data?.data?.viewer?.accounts?.[0] ?? {}, usage);
  } else {
    // Fall back to per-dataset so one bad dataset doesn't blind the other two.
    console.error(`[kill-switch] extended batch failed (${ext.kind}): ${ext.message} — falling back to per-dataset`);
    const today = todayUTC();
    const fields: [string, string][] = [
      ["ai", aiInferenceField(today)],
      ["aiGateway", aiGatewayField(today)],
      ["vectorize", vectorizeField(today)],
    ];
    let anyFail = false;
    for (const [name, field] of fields) {
      const r = await cfGraphQL(env, wrapAccount(field, env));
      if (r.ok) {
        parseExtended(r.data?.data?.viewer?.accounts?.[0] ?? {}, usage);
      } else {
        anyFail = true;
        console.error(`[kill-switch] ${name} dataset unavailable (${r.kind}): ${r.message}`);
        if (r.kind === "auth") usage.analyticsAuth = "FAILING";
      }
    }
    if (anyFail) {
      usage.extendedAnalytics = "DEGRADED";
      usage.extendedError = `[${ext.kind}] ${ext.message}`;
    }
  }

  return usage;
}

// ─── Worker Kill Switch ─────────────────────────────────────────────────────

async function disconnectWorker(env: Env, scriptName: string): Promise<string[]> {
  const actions: string[] = [];
  const baseUrl = `${CF_API}/accounts/${env.CLOUDFLARE_ACCOUNT_ID}`;
  const headers = {
    "Authorization": `Bearer ${env.CLOUDFLARE_API_TOKEN}`,
    "Content-Type": "application/json",
  };
  const removedDomains: string[] = [];

  // 1. Disable workers.dev subdomain
  try {
    const res = await fetch(`${baseUrl}/workers/scripts/${encodeURIComponent(scriptName)}/subdomain`, {
      method: "POST",
      headers,
      body: JSON.stringify({ enabled: false }),
    });
    if (res.ok) {
      actions.push(`Disabled workers.dev subdomain for ${scriptName}`);
    } else {
      const text = await res.text();
      actions.push(`Failed to disable subdomain: ${res.status} ${text.substring(0, 100)}`);
    }
  } catch (e) {
    actions.push(`Error disabling subdomain: ${e}`);
  }

  // 2. Get and remove custom domains
  try {
    const res = await fetch(`${baseUrl}/workers/domains?service=${encodeURIComponent(scriptName)}`, { headers });
    if (res.ok) {
      const data: any = await res.json().catch(() => null);
      for (const domain of (data?.result || [])) {
        const delRes = await fetch(`${baseUrl}/workers/domains/${domain.id}`, { method: "DELETE", headers });
        if (delRes.ok) {
          removedDomains.push(domain.hostname);
          actions.push(`Removed custom domain ${domain.hostname} from ${scriptName}`);
        }
      }
    }
  } catch (e) {
    actions.push(`Error removing domains: ${e}`);
  }

  // 3. Remove zone Workers Routes ([[routes]] patterns). (#10)
  // The previous version only handled workers.dev + custom domains, so a worker
  // served via a zone route was NOT actually disconnected despite the docs.
  const { actions: routeActions, removed: removedRoutes } = await removeWorkerRoutes(env, scriptName);
  actions.push(...routeActions);

  // 4. Forensic snapshot for recovery (powers `/restore`). Stable per-worker key
  // (latest kill wins) so a false positive can be reversed in seconds.
  if (env.ALERT_STATE) {
    try {
      await env.ALERT_STATE.put(
        `kill:${scriptName}`,
        JSON.stringify({ scriptName, killedAt: new Date().toISOString(), removedDomains, removedRoutes, actions }),
        { expirationTtl: 60 * 60 * 24 * 30 }, // 30 days
      );
    } catch (e) {
      console.error(`[kill-switch] failed to persist kill snapshot: ${e}`);
    }
  }

  return actions;
}

/**
 * #11 Restore a worker disconnected by a false positive: re-enable the
 * workers.dev subdomain and re-attach the custom domains + zone routes recorded
 * in the kill snapshot. Requires the ALERT_STATE KV binding (where the snapshot
 * lives). Does NOT recover auto-DELETED workers — their code is gone.
 */
async function restoreWorker(env: Env, scriptName: string): Promise<{ actions: string[]; restored: boolean }> {
  const actions: string[] = [];
  const headers = { "Authorization": `Bearer ${env.CLOUDFLARE_API_TOKEN}`, "Content-Type": "application/json" };

  if (!env.ALERT_STATE) {
    return { actions: ["Cannot restore: ALERT_STATE KV is not bound (no kill snapshots are recorded)."], restored: false };
  }
  const raw = await env.ALERT_STATE.get(`kill:${scriptName}`);
  if (!raw) {
    return { actions: [`No kill snapshot found for ${scriptName} (nothing to restore, or it expired).`], restored: false };
  }
  let snapshot: { removedDomains?: string[]; removedRoutes?: { pattern: string; zoneId: string }[]; killedAt?: string };
  try {
    snapshot = JSON.parse(raw);
  } catch {
    return { actions: [`Kill snapshot for ${scriptName} is corrupt — restore manually.`], restored: false };
  }
  if (snapshot.killedAt) actions.push(`Restoring ${scriptName} (killed at ${snapshot.killedAt})`);

  const baseUrl = `${CF_API}/accounts/${env.CLOUDFLARE_ACCOUNT_ID}`;

  // 1. Re-enable workers.dev subdomain
  try {
    const res = await fetch(`${baseUrl}/workers/scripts/${encodeURIComponent(scriptName)}/subdomain`, {
      method: "POST",
      headers,
      body: JSON.stringify({ enabled: true }),
    });
    actions.push(res.ok ? `Re-enabled workers.dev subdomain for ${scriptName}` : `Failed to re-enable subdomain: ${res.status} (worker may have been deleted)`);
  } catch (e) {
    actions.push(`Error re-enabling subdomain: ${e}`);
  }

  // 2. Re-attach custom domains (CF resolves the zone from the hostname).
  for (const hostname of (snapshot.removedDomains || [])) {
    try {
      const res = await fetch(`${baseUrl}/workers/domains`, {
        method: "PUT",
        headers,
        body: JSON.stringify({ hostname, service: scriptName, environment: "production" }),
      });
      actions.push(res.ok ? `Re-attached custom domain ${hostname}` : `Failed to re-attach ${hostname}: ${res.status}`);
    } catch (e) {
      actions.push(`Error re-attaching ${hostname}: ${e}`);
    }
  }

  // 3. Re-create zone routes
  for (const route of (snapshot.removedRoutes || [])) {
    try {
      const res = await fetch(`${CF_API}/zones/${route.zoneId}/workers/routes`, {
        method: "POST",
        headers,
        body: JSON.stringify({ pattern: route.pattern, script: scriptName }),
      });
      actions.push(res.ok ? `Re-created route ${route.pattern}` : `Failed to re-create route ${route.pattern}: ${res.status}`);
    } catch (e) {
      actions.push(`Error re-creating route ${route.pattern}: ${e}`);
    }
  }

  // Clear the snapshot so a stale restore can't fire twice.
  try { await env.ALERT_STATE.delete(`kill:${scriptName}`); } catch { /* best-effort */ }

  return { actions, restored: true };
}

/** List the account's zones, find Workers routes bound to scriptName, delete them. */
async function removeWorkerRoutes(
  env: Env,
  scriptName: string,
): Promise<{ actions: string[]; removed: { pattern: string; zoneId: string }[] }> {
  const actions: string[] = [];
  const removed: { pattern: string; zoneId: string }[] = [];
  const headers = { "Authorization": `Bearer ${env.CLOUDFLARE_API_TOKEN}`, "Content-Type": "application/json" };

  try {
    // Zones owned by this account (requires Zone:Read). Single page (50) covers
    // the vast majority of accounts; multi-page accounts are rare for this tool.
    const zonesRes = await fetch(`${CF_API}/zones?account.id=${env.CLOUDFLARE_ACCOUNT_ID}&per_page=50`, { headers });
    if (!zonesRes.ok) {
      actions.push(`Could not list zones for route removal: ${zonesRes.status} (needs Zone:Read)`);
      return { actions, removed };
    }
    const zonesData: any = await zonesRes.json().catch(() => null);
    const zones: any[] = zonesData?.result || [];

    for (const zone of zones) {
      const routesRes = await fetch(`${CF_API}/zones/${zone.id}/workers/routes`, { headers });
      if (!routesRes.ok) continue;
      const routesData: any = await routesRes.json().catch(() => null);
      for (const route of (routesData?.result || [])) {
        if (route.script !== scriptName) continue;
        const delRes = await fetch(`${CF_API}/zones/${zone.id}/workers/routes/${route.id}`, { method: "DELETE", headers });
        if (delRes.ok) {
          removed.push({ pattern: route.pattern, zoneId: zone.id });
          actions.push(`Removed route ${route.pattern} (zone ${zone.name || zone.id}) from ${scriptName}`);
        } else {
          actions.push(`Failed to remove route ${route.pattern}: ${delRes.status}`);
        }
      }
    }
    if (removed.length === 0) {
      actions.push(`No zone routes bound to ${scriptName}`);
    }
  } catch (e) {
    actions.push(`Error removing zone routes: ${e}`);
  }

  return { actions, removed };
}

async function deleteWorker(env: Env, scriptName: string): Promise<string> {
  const res = await fetch(
    `${CF_API}/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/workers/scripts/${encodeURIComponent(scriptName)}?force=true`,
    { method: "DELETE", headers: { "Authorization": `Bearer ${env.CLOUDFLARE_API_TOKEN}` } },
  );
  if (res.ok) return `DELETED worker ${scriptName}`;
  const text = await res.text();
  return `Failed to delete ${scriptName}: ${res.status} ${text.substring(0, 100)}`;
}

async function deleteR2Bucket(env: Env, bucketName: string): Promise<string> {
  const res = await fetch(
    `${CF_API}/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/r2/buckets/${bucketName}`,
    { method: "DELETE", headers: { "Authorization": `Bearer ${env.CLOUDFLARE_API_TOKEN}` } },
  );
  return res.ok ? `DELETED R2 bucket ${bucketName}` : `Failed to delete R2 bucket ${bucketName}: ${res.status}`;
}

async function deleteD1Database(env: Env, dbId: string): Promise<string> {
  const res = await fetch(
    `${CF_API}/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/d1/database/${dbId}`,
    { method: "DELETE", headers: { "Authorization": `Bearer ${env.CLOUDFLARE_API_TOKEN}` } },
  );
  return res.ok ? `DELETED D1 database ${dbId}` : `Failed to delete D1 database ${dbId}: ${res.status}`;
}

// ─── Alerting ───────────────────────────────────────────────────────────────

/**
 * #4 De-dup signature: strip digits from the violation set so the changing
 * numbers in messages ("1,000,001 reqs" vs "1,002,330 reqs") don't defeat the
 * key. Same *set of violated resources* → same signature → one alert per window.
 */
async function violationSignature(violations: string[]): Promise<string> {
  const normalized = violations.map((v) => v.replace(/[\d.,]+/g, "#")).sort().join("|");
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(normalized));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 32);
}

/**
 * Returns true if webhook alerts (Discord/Slack/custom) should be suppressed
 * because we already alerted for this same violation set within the cooldown.
 * PagerDuty is exempt (it self-dedups via dedup_key). Without KV, never suppress.
 */
async function webhookCooldownActive(env: Env, signature: string): Promise<boolean> {
  if (!env.ALERT_STATE) return false;
  const key = `alert:${signature}`;
  const existing = await env.ALERT_STATE.get(key);
  if (existing) return true;
  const ttl = parseInt(env.ALERT_COOLDOWN_SECONDS || "21600"); // 6h default
  await env.ALERT_STATE.put(key, new Date().toISOString(), { expirationTtl: ttl });
  return false;
}

async function sendAlerts(
  env: Env,
  summary: string,
  severity: Severity,
  details: Record<string, unknown>,
  opts: { dedupSuffix?: string; suppressWebhooks?: boolean } = {},
): Promise<void> {
  const { dedupSuffix = "", suppressWebhooks = false } = opts;
  const promises: Promise<void>[] = [];

  if (env.PAGERDUTY_ROUTING_KEY) {
    promises.push(alertPagerDuty(env, summary, severity, details, dedupSuffix));
  }
  // Webhooks have no native dedup → respect the cooldown so we don't spam ~288×/day.
  if (!suppressWebhooks) {
    if (env.DISCORD_WEBHOOK_URL) promises.push(alertDiscord(env, summary, severity, details));
    if (env.SLACK_WEBHOOK_URL) promises.push(alertSlack(env, summary, severity, details));
    if (env.CUSTOM_WEBHOOK_URL) promises.push(alertCustomWebhook(env, summary, severity, details));
  }

  if (!env.PAGERDUTY_ROUTING_KEY && !env.DISCORD_WEBHOOK_URL && !env.SLACK_WEBHOOK_URL && !env.CUSTOM_WEBHOOK_URL) {
    console.error("[kill-switch] WARNING: No alert destinations configured. Set at least one of: PAGERDUTY_ROUTING_KEY, DISCORD_WEBHOOK_URL, SLACK_WEBHOOK_URL, CUSTOM_WEBHOOK_URL");
  }

  await Promise.allSettled(promises);
}

async function alertPagerDuty(env: Env, summary: string, severity: Severity, details: Record<string, unknown>, dedupSuffix = ""): Promise<void> {
  const dedup = `cf-billing-${todayUTC()}${dedupSuffix ? `-${dedupSuffix}` : ""}`;
  const res = await fetch("https://events.pagerduty.com/v2/enqueue", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      routing_key: env.PAGERDUTY_ROUTING_KEY,
      event_action: "trigger",
      dedup_key: dedup,
      payload: {
        summary,
        source: "cloudflare-billing-kill-switch",
        severity,
        component: "cloudflare-workers",
        group: env.ENVIRONMENT || "production",
        class: "billing",
        custom_details: details,
      },
      client: "Cloudflare Billing Kill Switch",
      client_url: "https://dash.cloudflare.com",
    }),
  });
  if (!res.ok) console.error(`[kill-switch] PagerDuty error: ${res.status} ${await res.text()}`);
}

async function alertDiscord(env: Env, summary: string, severity: Severity, details: Record<string, unknown>): Promise<void> {
  const colorMap = { critical: 0xFF0000, error: 0xFF6600, warning: 0xFFCC00, info: 0x0099FF };
  const res = await fetch(env.DISCORD_WEBHOOK_URL!, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      embeds: [{
        title: `Cloudflare Billing Alert [${severity.toUpperCase()}]`,
        description: summary,
        color: colorMap[severity],
        fields: Object.entries(details).slice(0, 10).map(([key, value]) => ({
          name: key,
          value: typeof value === "string" ? value : JSON.stringify(value).substring(0, 200),
          inline: false,
        })),
        timestamp: new Date().toISOString(),
      }],
    }),
  });
  if (!res.ok) console.error(`[kill-switch] Discord error: ${res.status} ${await res.text()}`);
}

async function alertSlack(env: Env, summary: string, severity: Severity, details: Record<string, unknown>): Promise<void> {
  const emojiMap = { critical: ":rotating_light:", error: ":warning:", warning: ":large_yellow_circle:", info: ":information_source:" };
  const res = await fetch(env.SLACK_WEBHOOK_URL!, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      text: `${emojiMap[severity]} *Cloudflare Billing Alert [${severity.toUpperCase()}]*\n${summary}`,
      blocks: [
        { type: "section", text: { type: "mrkdwn", text: `${emojiMap[severity]} *Cloudflare Billing Alert [${severity.toUpperCase()}]*\n${summary}` } },
        { type: "section", text: { type: "mrkdwn", text: "```" + JSON.stringify(details, null, 2).substring(0, 2500) + "```" } },
      ],
    }),
  });
  if (!res.ok) console.error(`[kill-switch] Slack error: ${res.status} ${await res.text()}`);
}

async function alertCustomWebhook(env: Env, summary: string, severity: Severity, details: Record<string, unknown>): Promise<void> {
  const res = await fetch(env.CUSTOM_WEBHOOK_URL!, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ summary, severity, details, timestamp: new Date().toISOString(), source: "cloudflare-billing-kill-switch" }),
  });
  if (!res.ok) console.error(`[kill-switch] Custom webhook error: ${res.status}`);
}

// ─── Main Check ─────────────────────────────────────────────────────────────

async function checkUsage(env: Env): Promise<CheckResult> {
  const doReqThreshold = parseInt(env.DO_REQUEST_THRESHOLD || "1000000");
  const doWallThreshold = parseFloat(env.DO_WALLTIME_HOURS_THRESHOLD || "100");
  const workerReqThreshold = parseInt(env.WORKER_REQUEST_THRESHOLD || "10000000");
  const r2OpsThreshold = parseInt(env.R2_OPS_THRESHOLD || "10000000");
  const r2StorageThreshold = parseFloat(env.R2_STORAGE_GB_THRESHOLD || "10");
  const d1RowsReadThreshold = parseInt(env.D1_ROWS_READ_THRESHOLD || "5000000");
  const d1RowsWrittenThreshold = parseInt(env.D1_ROWS_WRITTEN_THRESHOLD || "1000000");
  const aiNeuronsThreshold = parseInt(env.AI_NEURONS_THRESHOLD || "500000");
  const aiGatewayCostThreshold = parseFloat(env.AI_GATEWAY_COST_THRESHOLD || "10");
  const vectorizeDimsThreshold = parseInt(env.VECTORIZE_DIMENSIONS_THRESHOLD || "100000000");

  const autoDisconnect = env.AUTO_DISCONNECT === "true";
  const autoDelete = env.AUTO_DELETE === "true";
  // #5 Kill threshold = alert threshold × multiplier. Alerts fire at 1×; kills
  // only above N×, so a cheap-but-busy service (the $0.23/day DO outage) can't
  // be auto-disconnected off a low alert floor. Set to 1 to restore old behavior.
  const killMultiplier = parseFloat(env.DISCONNECT_THRESHOLD_MULTIPLIER || "10");
  const protectedWorkers = (env.PROTECTED_WORKERS || "").split(",").map((s) => s.trim()).filter(Boolean);
  const protectedResources = (env.PROTECTED_RESOURCES || "").split(",").map((s) => s.trim()).filter(Boolean);

  const violations: string[] = [];
  const actions: string[] = [];
  let anyKillEligible = false;

  const usage = await queryAllUsage(env);

  // #9 If analytics auth is broken we are BLIND — page immediately rather than
  // silently reporting "all clear" on empty data.
  if (usage.analyticsAuth === "FAILING") {
    const msg = `ANALYTICS AUTH FAILING — Cloudflare monitoring is BLIND. Check CLOUDFLARE_API_TOKEN has 'Account Analytics:Read'. ${usage.analyticsError || ""}`;
    violations.push(msg);
    console.error(`[kill-switch] ${msg}`);
  }

  // ── Durable Objects (kill-eligible) ──
  for (const u of usage.doUsage) {
    const reqExceeded = u.requests > doReqThreshold;
    const wallExceeded = u.wallTimeHours > doWallThreshold;
    if (!reqExceeded && !wallExceeded) {
      console.error(`[kill-switch] ${u.scriptName}: ${u.requests.toLocaleString()} reqs - ok`);
      continue;
    }
    const killEligible = u.requests > doReqThreshold * killMultiplier || u.wallTimeHours > doWallThreshold * killMultiplier;
    anyKillEligible = anyKillEligible || killEligible;
    violations.push(`DO THRESHOLD EXCEEDED${killEligible ? " [KILL-ELIGIBLE]" : " [alert-only]"}: ${u.scriptName} - ${u.requests.toLocaleString()} reqs, ${u.wallTimeHours.toFixed(0)}h wall-time`);

    if (protectedWorkers.includes(u.scriptName)) {
      actions.push(`PROTECTED: ${u.scriptName} exceeded threshold but is protected`);
      continue;
    }
    if (!killEligible) {
      actions.push(`ALERT-ONLY: ${u.scriptName} over alert threshold but below kill threshold (${killMultiplier}×)`);
      continue;
    }
    if (autoDelete) actions.push(await deleteWorker(env, u.scriptName));
    else if (autoDisconnect) actions.push(...await disconnectWorker(env, u.scriptName));
  }

  // ── Workers (kill-eligible) ──
  for (const u of usage.workerUsage) {
    if (u.requests <= workerReqThreshold) continue;
    const killEligible = u.requests > workerReqThreshold * killMultiplier;
    anyKillEligible = anyKillEligible || killEligible;
    violations.push(`WORKER REQUEST SPIKE${killEligible ? " [KILL-ELIGIBLE]" : " [alert-only]"}: ${u.scriptName} - ${u.requests.toLocaleString()} reqs today`);

    if (protectedWorkers.includes(u.scriptName)) {
      actions.push(`PROTECTED: ${u.scriptName} request spike but is protected`);
      continue;
    }
    if (!killEligible) {
      actions.push(`ALERT-ONLY: ${u.scriptName} over alert threshold but below kill threshold (${killMultiplier}×)`);
      continue;
    }
    if (autoDisconnect) actions.push(...await disconnectWorker(env, u.scriptName));
  }

  // ── R2 (delete-eligible) ──
  for (const u of usage.r2Usage) {
    if (u.ops <= r2OpsThreshold && u.storageGB <= r2StorageThreshold) continue;
    const killEligible = u.ops > r2OpsThreshold * killMultiplier || u.storageGB > r2StorageThreshold * killMultiplier;
    anyKillEligible = anyKillEligible || killEligible;
    violations.push(`R2 THRESHOLD EXCEEDED${killEligible ? " [KILL-ELIGIBLE]" : " [alert-only]"}: ${u.bucketName} - ${u.ops.toLocaleString()} ops, ${u.storageGB.toFixed(2)} GB`);

    if (protectedResources.includes(u.bucketName)) {
      actions.push(`PROTECTED: R2 bucket ${u.bucketName}`);
      continue;
    }
    if (killEligible && autoDelete) actions.push(await deleteR2Bucket(env, u.bucketName));
  }

  // ── D1 (delete-eligible) ──
  for (const u of usage.d1Usage) {
    if (u.rowsRead <= d1RowsReadThreshold && u.rowsWritten <= d1RowsWrittenThreshold) continue;
    const killEligible = u.rowsRead > d1RowsReadThreshold * killMultiplier || u.rowsWritten > d1RowsWrittenThreshold * killMultiplier;
    anyKillEligible = anyKillEligible || killEligible;
    violations.push(`D1 THRESHOLD EXCEEDED${killEligible ? " [KILL-ELIGIBLE]" : " [alert-only]"}: ${u.dbName} - ${u.rowsRead.toLocaleString()} rows read, ${u.rowsWritten.toLocaleString()} rows written`);

    if (protectedResources.includes(u.dbName)) {
      actions.push(`PROTECTED: D1 database ${u.dbName}`);
      continue;
    }
    if (killEligible && autoDelete) actions.push(await deleteD1Database(env, u.dbName));
  }

  // ── Workers AI (#1) — detect-and-alert only (no CF API to throttle per-model). ──
  for (const u of usage.aiUsage) {
    if (u.neurons <= aiNeuronsThreshold) continue;
    const estCost = (u.neurons / 1000) * 0.011; // $0.011 / 1k Neurons
    violations.push(`WORKERS AI NEURON SPIKE: ${u.modelId} - ${u.neurons.toLocaleString()} Neurons (~$${estCost.toFixed(2)}), ${u.requests.toLocaleString()} reqs. Mitigate in-app (drop model from fallback chain).`);
  }

  // ── AI Gateway (#2) — upstream LLM $ (OpenAI/Anthropic/Gemini). Alert-only. ──
  for (const u of usage.aiGatewayUsage) {
    // sum.cost is $0 for the workers-ai provider (Neurons bill that separately,
    // counted above) — skip to avoid double-counting / false zeros.
    if (u.provider === "workers-ai") continue;
    if (u.cost <= aiGatewayCostThreshold) continue;
    violations.push(`AI GATEWAY COST SPIKE: ${u.gateway}/${u.provider}/${u.model} - $${u.cost.toFixed(2)} upstream today`);
  }

  // ── Vectorize (#3) — alert-only. ──
  for (const u of usage.vectorizeUsage) {
    if (u.queriedDimensions <= vectorizeDimsThreshold) continue;
    const estCost = (u.queriedDimensions / 1e6) * 0.01; // $0.01 / 1M queried dims
    violations.push(`VECTORIZE QUERY SPIKE: ${u.indexId} - ${u.queriedDimensions.toLocaleString()} queried dimensions (~$${estCost.toFixed(2)})`);
  }

  // ── Dispatch ──
  let severity: Severity = "info";
  if (violations.length > 0) {
    severity = (anyKillEligible || usage.analyticsAuth === "FAILING") ? "critical" : "warning";
    const signature = await violationSignature(violations);
    const suppressWebhooks = await webhookCooldownActive(env, signature);
    if (suppressWebhooks) {
      console.error(`[kill-switch] webhook alerts suppressed (cooldown active for signature ${signature})`);
    }
    await sendAlerts(
      env,
      `Cloudflare cost alert: ${violations.length} violation(s) [${severity}]`,
      severity,
      {
        violations,
        actionsTaken: actions,
        autoDisconnect,
        autoDelete,
        killMultiplier,
        analyticsAuth: usage.analyticsAuth,
        extendedAnalytics: usage.extendedAnalytics,
        checkedAt: new Date().toISOString(),
      },
      { suppressWebhooks },
    );
  } else {
    console.error("[kill-switch] All usage within thresholds.");
  }

  return { violations, actions, severity, analyticsAuth: usage.analyticsAuth, extendedAnalytics: usage.extendedAnalytics, usage };
}

// ─── Worker Entry Points ────────────────────────────────────────────────────

function thresholdsSummary(env: Env) {
  return {
    doRequests: parseInt(env.DO_REQUEST_THRESHOLD || "1000000"),
    doWalltimeHours: parseFloat(env.DO_WALLTIME_HOURS_THRESHOLD || "100"),
    workerRequests: parseInt(env.WORKER_REQUEST_THRESHOLD || "10000000"),
    aiNeurons: parseInt(env.AI_NEURONS_THRESHOLD || "500000"),
    aiGatewayCostUSD: parseFloat(env.AI_GATEWAY_COST_THRESHOLD || "10"),
    vectorizeDimensions: parseInt(env.VECTORIZE_DIMENSIONS_THRESHOLD || "100000000"),
    disconnectThresholdMultiplier: parseFloat(env.DISCONNECT_THRESHOLD_MULTIPLIER || "10"),
  };
}

export default {
  async scheduled(_event: ScheduledEvent, env: Env, _ctx: ExecutionContext): Promise<void> {
    await checkUsage(env);
  },

  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // #12 Fail CLOSED: every non-health endpoint requires ADMIN_SECRET. If it is
    // not configured, refuse — /check can trigger destructive actions and
    // /test-alert can be spammed, so unauthenticated-by-default is unacceptable.
    if (url.pathname !== "/") {
      const adminSecret = env.ADMIN_SECRET;
      if (!adminSecret) {
        return Response.json(
          { error: "ADMIN_SECRET not configured — refusing (fail-closed). Set it via `wrangler secret put ADMIN_SECRET`." },
          { status: 403 },
        );
      }
      if (request.headers.get("Authorization") !== `Bearer ${adminSecret}`) {
        return Response.json({ error: "Unauthorized" }, { status: 401 });
      }
    }

    // Manual check trigger
    if (url.pathname === "/check") {
      const result = await checkUsage(env);
      return Response.json({ status: "checked", ...result, timestamp: new Date().toISOString() });
    }

    // Restore a worker disconnected by a false positive (#11)
    if (url.pathname === "/restore") {
      const worker = url.searchParams.get("worker");
      if (!worker) {
        return Response.json({ error: "Missing ?worker=<scriptName>" }, { status: 400 });
      }
      const { actions, restored } = await restoreWorker(env, worker);
      return Response.json({ status: restored ? "restored" : "not-restored", worker, actions, timestamp: new Date().toISOString() }, { status: restored ? 200 : 404 });
    }

    // Test alert integrations
    if (url.pathname === "/test-alert") {
      await sendAlerts(env, "Test alert from Cloudflare Billing Kill Switch", "info", {
        test: true,
        timestamp: new Date().toISOString(),
        message: "If you received this, your alert integration is working correctly.",
      }, { dedupSuffix: "test" });
      return Response.json({ status: "test alert sent" });
    }

    // Usage report (no alerts, just data)
    if (url.pathname === "/usage") {
      const usage = await queryAllUsage(env);
      return Response.json({
        analyticsAuth: usage.analyticsAuth,
        analyticsError: usage.analyticsError,
        extendedAnalytics: usage.extendedAnalytics,
        extendedError: usage.extendedError,
        doUsage: usage.doUsage,
        workerUsage: usage.workerUsage.slice(0, 20),
        r2Usage: usage.r2Usage,
        d1Usage: usage.d1Usage,
        aiUsage: usage.aiUsage,
        aiGatewayUsage: usage.aiGatewayUsage,
        vectorizeUsage: usage.vectorizeUsage,
        thresholds: thresholdsSummary(env),
        timestamp: new Date().toISOString(),
      });
    }

    // Health check (public)
    return Response.json({
      service: "cloudflare-billing-kill-switch",
      status: "healthy",
      schedule: "every 6 hours",
      thresholds: thresholdsSummary(env),
      autoDisconnect: env.AUTO_DISCONNECT === "true",
      autoDelete: env.AUTO_DELETE === "true",
      failClosed: !env.ADMIN_SECRET ? "ADMIN_SECRET not set — endpoints refuse" : "ADMIN_SECRET set",
      alertCooldown: env.ALERT_STATE ? `${parseInt(env.ALERT_COOLDOWN_SECONDS || "21600")}s` : "DISABLED (bind ALERT_STATE KV to enable)",
      protectedWorkers: (env.PROTECTED_WORKERS || "").split(",").filter(Boolean),
      coverage: ["durable-objects", "workers", "r2", "d1", "workers-ai", "ai-gateway", "vectorize"],
      alertDestinations: {
        pagerduty: !!env.PAGERDUTY_ROUTING_KEY,
        discord: !!env.DISCORD_WEBHOOK_URL,
        slack: !!env.SLACK_WEBHOOK_URL,
        customWebhook: !!env.CUSTOM_WEBHOOK_URL,
      },
      endpoints: {
        "/": "Health check (this page)",
        "/check": "Run usage check now (triggers alerts if thresholds exceeded) — requires ADMIN_SECRET",
        "/usage": "View current usage data (no alerts) — requires ADMIN_SECRET",
        "/restore": "Restore a disconnected worker from its kill snapshot (?worker=NAME) — requires ADMIN_SECRET + ALERT_STATE KV",
        "/test-alert": "Send a test alert to all configured destinations — requires ADMIN_SECRET",
      },
    });
  },
};
