/**
 * Credential + update-input builders for `ks accounts add` / `ks accounts update`.
 *
 * Field names mirror what each provider's checker expects (and what `ks onboard`
 * already collects). Kept in a separate, pure module so they're unit-testable
 * without spinning up commander.
 */

/** Build a provider credential object from `accounts add` flags + escape hatches. */
export function buildAddCredential(opts: Record<string, any>): Record<string, any> {
  const cred: Record<string, any> = {};

  // cloudflare
  if (opts.token) cred.apiToken = opts.token;
  if (opts.accountId) cred.accountId = opts.accountId;
  // gcp
  if (opts.projectId) cred.projectId = opts.projectId;
  if (opts.serviceAccount) cred.serviceAccountJson = opts.serviceAccount;
  // aws
  if (opts.accessKey) cred.awsAccessKeyId = opts.accessKey;
  if (opts.secretKey) cred.awsSecretAccessKey = opts.secretKey;
  if (opts.region) cred.awsRegion = opts.region;
  // runpod
  if (opts.runpodApiKey) cred.runpodApiKey = opts.runpodApiKey;

  // mongodb — atlas vs self-hosted inferred from which flags are present
  if (opts.mongodbUri) {
    cred.mongodbSubType = "self-hosted";
    cred.mongodbUri = opts.mongodbUri;
  }
  if (opts.mongodbDatabase) cred.mongodbDatabaseName = opts.mongodbDatabase;
  if (opts.atlasPublicKey || opts.atlasPrivateKey || opts.atlasProjectId) {
    cred.mongodbSubType = "atlas";
    if (opts.atlasPublicKey) cred.atlasPublicKey = opts.atlasPublicKey;
    if (opts.atlasPrivateKey) cred.atlasPrivateKey = opts.atlasPrivateKey;
    if (opts.atlasProjectId) cred.atlasProjectId = opts.atlasProjectId;
    if (opts.atlasClusterName) cred.atlasClusterName = opts.atlasClusterName;
  }

  // redis — cloud vs self-hosted inferred
  if (opts.redisUrl) {
    cred.redisSubType = "self-hosted";
    cred.redisUrl = opts.redisUrl;
  }
  if (opts.redisCloudKey || opts.redisCloudSecret || opts.redisSubscriptionId) {
    cred.redisSubType = "redis-cloud";
    if (opts.redisCloudKey) cred.redisCloudAccountKey = opts.redisCloudKey;
    if (opts.redisCloudSecret) cred.redisCloudSecretKey = opts.redisCloudSecret;
    if (opts.redisSubscriptionId) cred.redisCloudSubscriptionId = opts.redisSubscriptionId;
  }
  if (opts.redisTls) cred.redisTlsEnabled = true;

  // neo4j
  if (opts.neo4jClientId) cred.neo4jClientId = opts.neo4jClientId;
  if (opts.neo4jClientSecret) cred.neo4jClientSecret = opts.neo4jClientSecret;
  if (opts.neo4jInstanceId) cred.neo4jInstanceId = opts.neo4jInstanceId;

  // generic escape hatches — let any provider work without per-flag plumbing
  if (opts.credentialJson) {
    let parsed: any;
    try {
      parsed = JSON.parse(opts.credentialJson);
    } catch {
      throw new Error("--credential-json must be valid JSON");
    }
    if (parsed && typeof parsed === "object") Object.assign(cred, parsed);
  }
  for (const pair of (opts.cred ?? []) as string[]) {
    const i = pair.indexOf("=");
    if (i <= 0) throw new Error(`--cred expects key=value (got "${pair}")`);
    cred[pair.slice(0, i)] = pair.slice(i + 1);
  }

  return cred;
}

/** Parse a boolean-ish CLI string. undefined for absent/unrecognized (so updates only touch what was passed). */
export function parseBoolFlag(v: string | undefined): boolean | undefined {
  if (v === undefined) return undefined;
  const s = String(v).trim().toLowerCase();
  if (["true", "on", "yes", "1"].includes(s)) return true;
  if (["false", "off", "no", "0"].includes(s)) return false;
  throw new Error(`expected true/false (got "${v}")`);
}

/** Build an UpdateAccountInput from `accounts update` flags. Only includes fields the user passed. */
export function buildUpdateInput(opts: Record<string, any>): Record<string, any> {
  const update: Record<string, any> = {};

  if (opts.name) update.name = opts.name;
  if (opts.status) {
    if (!["active", "paused"].includes(opts.status)) {
      throw new Error(`--status must be active or paused (got "${opts.status}")`);
    }
    update.status = opts.status;
  }

  if (opts.threshold?.length) {
    const t: Record<string, number> = {};
    for (const pair of opts.threshold as string[]) {
      const i = pair.indexOf("=");
      if (i <= 0) throw new Error(`--threshold expects key=value (got "${pair}")`);
      const num = Number(pair.slice(i + 1));
      if (Number.isNaN(num)) throw new Error(`--threshold value must be numeric (got "${pair}")`);
      t[pair.slice(0, i)] = num;
    }
    update.thresholds = t;
  }

  if (opts.protectedServices?.length) update.protectedServices = opts.protectedServices;
  if (opts.autokillCategories) {
    update.autoKillCategories = opts.autokillCategories.split(",").map((s: string) => s.trim()).filter(Boolean);
  }

  const ad = parseBoolFlag(opts.autoDisconnect);
  if (ad !== undefined) update.autoDisconnect = ad;
  const adel = parseBoolFlag(opts.autoDelete);
  if (adel !== undefined) update.autoDelete = adel;
  const pp = parseBoolFlag(opts.productionProtected);
  if (pp !== undefined) update.productionProtected = pp;

  return update;
}
