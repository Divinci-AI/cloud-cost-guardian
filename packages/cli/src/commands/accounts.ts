import { Command } from "commander";
import { outputJson, formatTable, formatObject, handleError, spinner, success } from "../output.js";
import { confirm } from "../prompts.js";
import type { ClientFactory } from "../types.js";

export function registerAccountCommands(program: Command, createClient: ClientFactory) {
  const accounts = program.command("accounts").description("Manage cloud accounts");

  accounts
    .command("list")
    .alias("ls")
    .description("List connected cloud accounts")
    .option("--provider <provider>", "Filter by provider (cloudflare, gcp, aws, runpod)")
    .option("--status <status>", "Filter by status (active, paused, disconnected)")
    .action(async (opts) => {
      const json = program.opts().json;
      try {
        const client = createClient();
        let list = await client.accounts.list();
        if (opts.provider) list = list.filter((a) => a.provider === opts.provider);
        if (opts.status) list = list.filter((a) => a.status === opts.status);
        if (json) {
          outputJson(list);
        } else {
          formatTable(list, [
            { key: "id", header: "ID" },
            { key: "provider", header: "Provider" },
            { key: "name", header: "Name" },
            { key: "status", header: "Status" },
          ]);
        }
      } catch (err) {
        handleError(err, json);
      }
    });

  accounts
    .command("get <id>")
    .description("Get cloud account details")
    .action(async (id) => {
      const json = program.opts().json;
      try {
        const client = createClient();
        const data = await client.accounts.get(id);
        if (json) {
          outputJson(data);
        } else {
          formatObject(data);
        }
      } catch (err) {
        handleError(err, json);
      }
    });

  accounts
    .command("add <provider>")
    .description("Connect a cloud provider (cloudflare, gcp, aws)")
    .requiredOption("--name <name>", "Account name")
    .option("--token <token>", "API token (Cloudflare)")
    .option("--account-id <id>", "Account ID (Cloudflare)")
    .option("--project-id <id>", "Project ID (GCP)")
    .option("--service-account <json>", "Service Account JSON (GCP)")
    .action(async (provider, opts) => {
      const json = program.opts().json;
      const credential: Record<string, string> = {};
      if (opts.token) credential.apiToken = opts.token;
      if (opts.accountId) credential.accountId = opts.accountId;
      if (opts.projectId) credential.projectId = opts.projectId;
      if (opts.serviceAccount) credential.serviceAccountJson = opts.serviceAccount;

      const s = json ? null : spinner(`Connecting ${provider}...`).start();
      try {
        const client = createClient();
        const data = await client.accounts.create({
          provider: provider as any,
          name: opts.name,
          credential: credential as any,
        });
        s?.stop();
        if (json) {
          outputJson(data);
        } else {
          success(`Connected ${provider} account: ${data.name || data.id}`);
        }
      } catch (err) {
        s?.stop();
        handleError(err, json);
      }
    });

  accounts
    .command("delete <id>")
    .alias("rm")
    .description("Disconnect and delete a cloud account")
    .action(async (id) => {
      const { json, yes } = program.opts();
      try {
        const ok = await confirm(`Are you sure you want to disconnect account ${id}?`, { yes, json });
        if (!ok) {
          console.log("Aborted.");
          return;
        }
        const client = createClient();
        await client.accounts.delete(id);
        if (json) {
          outputJson({ deleted: true, id });
        } else {
          success(`Account ${id} disconnected.`);
        }
      } catch (err) {
        handleError(err, json);
      }
    });

  accounts
    .command("check <id>")
    .description("Run manual monitoring check on an account")
    .action(async (id) => {
      const json = program.opts().json;
      const s = json ? null : spinner("Running check...").start();
      try {
        const client = createClient();
        const data = await client.accounts.check(id);
        s?.stop();
        if (json) {
          outputJson(data);
        } else {
          console.log(`Check complete: ${data.violations?.length || 0} violations`);
          if (data.violations?.length) {
            formatTable(data.violations, [
              { key: "metric", header: "Metric" },
              { key: "value", header: "Value" },
              { key: "threshold", header: "Threshold" },
              { key: "action", header: "Action" },
            ]);
          }
        }
      } catch (err) {
        s?.stop();
        handleError(err, json);
      }
    });
}
