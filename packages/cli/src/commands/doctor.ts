import { Command } from "commander";
import { outputJson, colors as c } from "../output.js";
import { resolveApiKey, resolveApiUrl } from "../config.js";
import { BIN } from "../program-name.js";
import type { ClientFactory } from "../types.js";

type CheckStatus = "ok" | "warn" | "fail";
interface Check {
  name: string;
  status: CheckStatus;
  detail: string;
  hint?: string;
}

const ICON: Record<CheckStatus, string> = { ok: "✓", warn: "⚠", fail: "✗" };
const COLOR: Record<CheckStatus, (s: string) => string> = { ok: c.green, warn: c.yellow, fail: c.red };

/**
 * `ks doctor` — one-stop diagnostic: config, auth, active org, connectivity,
 * accounts, alerts. Surfaces the active org prominently so a "missing" account
 * that's really in another org is immediately obvious (dogfood feedback C1).
 */
export function registerDoctorCommand(program: Command, createClient: ClientFactory) {
  program
    .command("doctor")
    .description("Diagnose CLI setup: config, auth, active org, connectivity, accounts, alerts")
    .action(async () => {
      const json = program.opts().json;
      const checks: Check[] = [];

      // 1. API URL (resolveApiUrl throws on a non-https / malformed URL)
      let apiUrl = "";
      try {
        apiUrl = resolveApiUrl(program.opts().apiUrl);
        checks.push({ name: "API URL", status: "ok", detail: apiUrl });
      } catch (e: any) {
        checks.push({ name: "API URL", status: "fail", detail: e?.message ?? String(e) });
      }

      // 2. API key present
      const key = resolveApiKey(program.opts().apiKey);
      if (key) {
        checks.push({ name: "API key", status: "ok", detail: `configured (…${key.slice(-4)})` });
      } else {
        checks.push({ name: "API key", status: "fail", detail: "not set", hint: `${BIN} auth login --api-key ks_live_...` });
      }

      // Network checks only when we have a key + a valid URL.
      if (key && apiUrl) {
        const client = createClient();

        let me: any = null;
        try {
          me = await client.account.me();
          checks.push({ name: "Authentication", status: "ok", detail: `authenticated as ${me.name || me._id}` });
        } catch (e: any) {
          const msg = e?.message ?? String(e);
          const is401 = /401|unauthor/i.test(msg);
          checks.push({
            name: "Authentication",
            status: "fail",
            detail: is401 ? "API key rejected (401)" : `API unreachable — ${msg}`,
            hint: is401 ? `${BIN} auth login --api-key NEW_KEY` : undefined,
          });
        }

        if (me) {
          const active = (me.orgs || []).find((o: any) => o.id === me.activeOrgId);
          const orgCount = me.orgs?.length || 1;
          checks.push({
            name: "Active org",
            status: "ok",
            detail: `${active?.name || me.activeOrgId || "personal"}${active?.role ? ` (${active.role})` : ""} · ${orgCount} org(s)`,
            hint: orgCount > 1 ? `accounts/rules/alerts are scoped to this org — switch: ${BIN} orgs switch <id>` : undefined,
          });

          try {
            const accounts = await client.accounts.list();
            const activeCount = (accounts as any[]).filter((a) => a.status === "active").length;
            checks.push({
              name: "Accounts",
              status: accounts.length ? "ok" : "warn",
              detail: accounts.length ? `${accounts.length} connected (${activeCount} active) in this org` : "none in this org",
              hint: accounts.length ? undefined : `${BIN} onboard`,
            });
          } catch (e: any) {
            checks.push({ name: "Accounts", status: "warn", detail: `couldn't list — ${e?.message ?? e}` });
          }

          try {
            const channels = await client.alerts.channels();
            checks.push({
              name: "Alert channels",
              status: channels.length ? "ok" : "warn",
              detail: channels.length ? `${channels.length} configured` : "none",
              hint: channels.length ? undefined : `${BIN} alerts add --type pagerduty --routing-key KEY`,
            });
          } catch (e: any) {
            checks.push({ name: "Alert channels", status: "warn", detail: `couldn't list — ${e?.message ?? e}` });
          }
        }
      }

      const fails = checks.filter((ck) => ck.status === "fail").length;
      const warns = checks.filter((ck) => ck.status === "warn").length;

      if (json) {
        outputJson({ ok: fails === 0, fails, warns, checks });
        return;
      }

      console.log(c.bold("\nKill Switch Doctor\n"));
      for (const ck of checks) {
        console.log(`  ${COLOR[ck.status](ICON[ck.status])} ${c.bold(`${ck.name}:`)} ${ck.detail}`);
        if (ck.hint) console.log(`      ${c.dim(`→ ${ck.hint}`)}`);
      }
      console.log();
      if (fails) console.log(`  ${c.red(`${fails} issue(s) need attention.`)}`);
      else if (warns) console.log(`  ${c.yellow(`Looks healthy — ${warns} suggestion(s).`)}`);
      else console.log(`  ${c.green("All checks passed.")}`);
      console.log();

      // Non-zero exit on hard failures so scripts/CI can gate on `ks doctor`.
      if (fails) process.exitCode = 1;
    });
}
