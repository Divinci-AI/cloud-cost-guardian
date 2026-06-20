import { Command } from "commander";
import { outputJson, formatTable, formatObject, handleError, spinner, success } from "../output.js";
import { confirm } from "../prompts.js";
import { fetchOrgContext, orgBanner } from "../org-context.js";
import { BIN } from "../program-name.js";
import { buildAddCredential, buildUpdateInput } from "../account-credentials.js";
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
        // Accounts are scoped to the active org — fetch context in parallel so a
        // "missing" account that's really in another org is obvious from the header.
        const [listRaw, orgCtx] = await Promise.all([
          client.accounts.list(),
          json ? Promise.resolve(null) : fetchOrgContext(client),
        ]);
        let list = listRaw;
        if (opts.provider) list = list.filter((a) => a.provider === opts.provider);
        if (opts.status) list = list.filter((a) => a.status === opts.status);
        if (json) {
          outputJson(list);
        } else {
          const banner = orgBanner(orgCtx);
          if (banner) console.log(banner + "\n");
          if (list.length === 0) {
            console.log("No accounts in this org." + (orgCtx && orgCtx.orgCount > 1 ? ` Other orgs may have accounts — see: ${BIN} orgs list` : ""));
          }
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
    .description("Connect a provider (cloudflare, gcp, aws, runpod, mongodb, redis, neo4j, …)")
    .requiredOption("--name <name>", "Account name")
    // cloudflare
    .option("--token <token>", "API token (Cloudflare)")
    .option("--account-id <id>", "Account ID (Cloudflare)")
    // gcp
    .option("--project-id <id>", "Project ID (GCP)")
    .option("--service-account <json>", "Service Account JSON (GCP)")
    // aws
    .option("--access-key <key>", "Access Key ID (AWS)")
    .option("--secret-key <key>", "Secret Access Key (AWS)")
    .option("--region <region>", "Region (AWS)")
    // runpod
    .option("--runpod-api-key <key>", "API Key (RunPod)")
    // mongodb (atlas)
    .option("--atlas-public-key <key>", "Public key (MongoDB Atlas)")
    .option("--atlas-private-key <key>", "Private key (MongoDB Atlas)")
    .option("--atlas-project-id <id>", "Project ID (MongoDB Atlas)")
    .option("--atlas-cluster-name <name>", "Cluster name (MongoDB Atlas, optional)")
    // mongodb (self-hosted)
    .option("--mongodb-uri <uri>", "Connection URI (self-hosted MongoDB)")
    .option("--mongodb-database <name>", "Database name (self-hosted MongoDB, optional)")
    // redis
    .option("--redis-url <url>", "Connection URL (self-hosted Redis / ElastiCache)")
    .option("--redis-cloud-key <key>", "Account key (Redis Cloud API)")
    .option("--redis-cloud-secret <secret>", "Secret key (Redis Cloud API)")
    .option("--redis-subscription-id <id>", "Subscription ID (Redis Cloud)")
    .option("--redis-tls", "Enable TLS (Redis)")
    // neo4j
    .option("--neo4j-client-id <id>", "Client ID (Neo4j Aura)")
    .option("--neo4j-client-secret <secret>", "Client Secret (Neo4j Aura)")
    .option("--neo4j-instance-id <id>", "Instance ID (Neo4j Aura, optional)")
    // generic escape hatch — any provider/field without dedicated flags
    .option("--cred <key=value...>", "Credential field(s) as key=value (repeatable)")
    .option("--credential-json <json>", "Full credential object as JSON")
    .action(async (provider, opts) => {
      const json = program.opts().json;
      let credential: Record<string, any>;
      try {
        credential = buildAddCredential(opts);
      } catch (err) {
        return handleError(err, json);
      }
      if (Object.keys(credential).length === 0) {
        return handleError(
          new Error(`No credentials provided for ${provider}. See: ${BIN} onboard --help-provider ${provider}`),
          json,
        );
      }

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
    .command("update <id>")
    .description("Update an account's thresholds, auto-actions, or production-protected flag")
    .option("--name <name>", "Rename the account")
    .option("--status <status>", "Set status: active or paused")
    .option("--threshold <key=value...>", "Set threshold(s), e.g. --threshold mongodbDailyCostUSD=50 (repeatable)")
    .option("--protected-services <name...>", "Service names that destructive actions skip")
    .option("--autokill-categories <list>", "Comma-separated categories that auto-kill (e.g. cost,storage)")
    .option("--auto-disconnect <bool>", "Auto-disconnect on cost breach (true/false)")
    .option("--auto-delete <bool>", "Auto-delete on critical breach (true/false)")
    .option("--production-protected <bool>", "Block destructive managed-DB actions (true/false)")
    .action(async (id, opts) => {
      const json = program.opts().json;
      let update: Record<string, any>;
      try {
        update = buildUpdateInput(opts);
      } catch (err) {
        return handleError(err, json);
      }
      if (Object.keys(update).length === 0) {
        return handleError(new Error("Nothing to update — pass at least one field (see --help)."), json);
      }
      const s = json ? null : spinner(`Updating ${id}...`).start();
      try {
        const client = createClient();
        const data = await client.accounts.update(id, update as any);
        s?.stop();
        if (json) {
          outputJson(data);
        } else {
          success(`Updated account ${data.name || id}`);
          formatObject({ updated: Object.keys(update).join(", ") });
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
