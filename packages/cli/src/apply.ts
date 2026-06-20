/**
 * Integration-as-code for `ks apply -f <file>` (dogfood feedback C3).
 *
 * Replaces hand-rolled `*.config.ts` files (like divinci-prod-atlas.config.ts)
 * with a declarative, version-controllable spec that reconciles idempotently:
 * find-or-create the account, apply thresholds/flags, apply shields, ensure
 * alert channels. Secrets stay out of the file via ${ENV} interpolation.
 */
import type { KillSwitchClient } from "@kill-switch/sdk";
import { parse as parseYaml } from "yaml";

export interface ApplySpec {
  account: {
    provider: string;
    name: string;
    credential?: Record<string, any>;
    thresholds?: Record<string, number>;
    protectedServices?: string[];
    autoDisconnect?: boolean;
    autoDelete?: boolean;
    autoKillCategories?: string[];
    productionProtected?: boolean;
    status?: "active" | "paused";
  };
  shields?: string[];
  alerts?: Array<{ type: string; name?: string; [k: string]: any }>;
}

export type ChangeKind = "create" | "update" | "unchanged";
export interface PlanItem { resource: string; change: ChangeKind; detail: string; }
export interface ApplyResult { items: PlanItem[]; dryRun: boolean; }

/** Recursively replace ${ENV_VAR} in every string value. Throws if a referenced var is unset. */
export function interpolateEnv(value: any, env: NodeJS.ProcessEnv = process.env): any {
  if (typeof value === "string") {
    return value.replace(/\$\{([A-Z0-9_]+)\}/g, (_m, name) => {
      const v = env[name];
      if (v === undefined) throw new Error(`Environment variable ${name} referenced in config is not set`);
      return v;
    });
  }
  if (Array.isArray(value)) return value.map((v) => interpolateEnv(v, env));
  if (value && typeof value === "object") {
    const out: Record<string, any> = {};
    for (const [k, v] of Object.entries(value)) out[k] = interpolateEnv(v, env);
    return out;
  }
  return value;
}

/** Parse a spec from raw file contents. JSON if the path ends in .json, else YAML. */
export function parseSpec(raw: string, path: string): ApplySpec {
  const spec = /\.json$/i.test(path) ? JSON.parse(raw) : parseYaml(raw);
  if (!spec || typeof spec !== "object") throw new Error("Config must be a YAML/JSON object");
  if (!spec.account?.provider || !spec.account?.name) {
    throw new Error("Config must have account.provider and account.name");
  }
  return spec as ApplySpec;
}

/** Stable identity for an alert channel so re-applying doesn't duplicate it. */
function channelKey(c: { type?: string; config?: any; routingKey?: string; webhookUrl?: string; email?: string }): string {
  const cfg = c.config ?? c;
  const id = cfg.routingKey ?? cfg.webhookUrl ?? cfg.email ?? `${cfg.repoOwner ?? ""}/${cfg.repoName ?? ""}`;
  return `${c.type}:${id}`;
}

/** Build the AlertChannel payload addChannel expects from a spec alert entry. */
function toChannel(a: Record<string, any>) {
  const { type, name, ...rest } = a;
  const config: Record<string, any> = {};
  for (const k of ["routingKey", "webhookUrl", "email", "githubToken", "repoOwner", "repoName", "workflowFile", "branchRef"]) {
    if (rest[k] !== undefined) config[k] = rest[k];
  }
  return { type, name: name || (type.charAt(0).toUpperCase() + type.slice(1)), enabled: true, config };
}

/** The account-update subset of a spec (everything except provider/name/credential). */
function accountUpdateFromSpec(a: ApplySpec["account"]): Record<string, any> {
  const u: Record<string, any> = {};
  if (a.thresholds) u.thresholds = a.thresholds;
  if (a.protectedServices) u.protectedServices = a.protectedServices;
  if (a.autoDisconnect !== undefined) u.autoDisconnect = a.autoDisconnect;
  if (a.autoDelete !== undefined) u.autoDelete = a.autoDelete;
  if (a.autoKillCategories) u.autoKillCategories = a.autoKillCategories;
  if (a.productionProtected !== undefined) u.productionProtected = a.productionProtected;
  if (a.status) u.status = a.status;
  return u;
}

/**
 * Reconcile a spec against the live API. Idempotent: re-running converges and
 * reports `unchanged`. With dryRun, performs only reads and returns the plan.
 */
export async function reconcile(client: KillSwitchClient, spec: ApplySpec, opts: { dryRun?: boolean } = {}): Promise<ApplyResult> {
  const dryRun = !!opts.dryRun;
  const items: PlanItem[] = [];

  // 1. Account — find-or-create by provider + name.
  const accounts = await client.accounts.list();
  let account: any = accounts.find((a: any) => a.provider === spec.account.provider && a.name === spec.account.name);

  if (!account) {
    if (!spec.account.credential) {
      throw new Error(`Account "${spec.account.name}" doesn't exist and no credential was provided to create it`);
    }
    items.push({ resource: `account ${spec.account.name}`, change: "create", detail: `${spec.account.provider} account` });
    if (!dryRun) {
      account = await client.accounts.create({
        provider: spec.account.provider as any,
        name: spec.account.name,
        credential: spec.account.credential as any,
      });
    }
  }

  // 2. Account settings — thresholds + flags.
  const update = accountUpdateFromSpec(spec.account);
  if (Object.keys(update).length > 0) {
    items.push({ resource: `account ${spec.account.name}`, change: "update", detail: `set ${Object.keys(update).join(", ")}` });
    if (!dryRun && account?.id) await client.accounts.update(account.id, update as any);
  }

  // 3. Shields — apply each preset unless a matching rule already exists.
  if (spec.shields?.length) {
    const [presets, existingRules] = await Promise.all([
      client.rules.presets().catch(() => [] as any[]),
      client.rules.list().catch(() => [] as any[]),
    ]);
    const presetName = (id: string) => (presets.find((p: any) => p.id === id)?.name ?? id);
    for (const shield of spec.shields) {
      const already = existingRules.some((r: any) => r.name === presetName(shield) || r.presetId === shield);
      if (already) {
        items.push({ resource: `shield ${shield}`, change: "unchanged", detail: "rule already present" });
      } else {
        items.push({ resource: `shield ${shield}`, change: "create", detail: "apply preset" });
        if (!dryRun) await client.rules.applyPreset(shield);
      }
    }
  }

  // 4. Alerts — ensure each channel, deduped by type + identifier.
  if (spec.alerts?.length) {
    const existing = await client.alerts.channels().catch(() => [] as any[]);
    const haveKeys = new Set(existing.map((c: any) => channelKey(c)));
    for (const alert of spec.alerts) {
      const ch = toChannel(alert);
      if (haveKeys.has(channelKey(ch))) {
        items.push({ resource: `alert ${ch.type}`, change: "unchanged", detail: ch.name });
      } else {
        items.push({ resource: `alert ${ch.type}`, change: "create", detail: ch.name });
        if (!dryRun) await client.alerts.addChannel(ch as any);
      }
    }
  }

  return { items, dryRun };
}
