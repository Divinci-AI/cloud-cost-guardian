import { Command } from "commander";
import { outputJson, formatTable, formatObject, handleError, spinner, success, fail, colors as c } from "../output.js";
import type { ClientFactory } from "../types.js";

export function registerProviderCommands(program: Command, createClient: ClientFactory) {
  const providers = program.command("providers").description("Cloud provider information and credential validation");

  providers
    .command("list")
    .alias("ls")
    .description("List supported cloud providers")
    .action(async () => {
      const json = program.opts().json;
      try {
        const client = createClient();
        const list = await client.providers.list();
        if (json) {
          outputJson(list);
        } else {
          formatTable(list, [
            { key: "id", header: "ID", width: 14 },
            { key: "name", header: "Name", width: 25 },
          ]);
        }
      } catch (err) {
        handleError(err, json);
      }
    });

  providers
    .command("validate <provider>")
    .description("Validate cloud provider credentials without connecting")
    .option("--token <token>", "API token (Cloudflare)")
    .option("--account-id <id>", "Account ID (Cloudflare)")
    .option("--project-id <id>", "Project ID (GCP)")
    .option("--service-account <json>", "Service Account JSON (GCP)")
    .option("--access-key <key>", "Access Key ID (AWS)")
    .option("--secret-key <key>", "Secret Access Key (AWS)")
    .option("--region <region>", "Region (AWS)")
    .option("--runpod-api-key <key>", "API Key (RunPod)")
    .action(async (provider, opts) => {
      const json = program.opts().json;
      const credential: Record<string, string> = {};

      // Build credential based on provider
      if (opts.token) credential.apiToken = opts.token;
      if (opts.accountId) credential.accountId = opts.accountId;
      if (opts.projectId) credential.projectId = opts.projectId;
      if (opts.serviceAccount) credential.serviceAccountJson = opts.serviceAccount;
      if (opts.accessKey) credential.awsAccessKeyId = opts.accessKey;
      if (opts.secretKey) credential.awsSecretAccessKey = opts.secretKey;
      if (opts.region) credential.awsRegion = opts.region;
      if (opts.runpodApiKey) credential.runpodApiKey = opts.runpodApiKey;

      const s = json ? null : spinner(`Validating ${provider} credentials...`).start();
      try {
        const client = createClient();
        const result = await client.providers.validate(provider, credential);
        s?.stop();

        if (json) {
          outputJson(result);
        } else if (result.valid) {
          success("Credentials are valid!");
          if (result.accountId) console.log(`  ${c.bold("Account ID:")}   ${result.accountId}`);
          if (result.accountName) console.log(`  ${c.bold("Account Name:")} ${result.accountName}`);
        } else {
          fail(`Validation failed: ${result.error || "Unknown error"}`);
        }
      } catch (err) {
        s?.stop();
        handleError(err, json);
      }
    });
}
