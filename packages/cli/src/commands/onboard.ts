/**
 * Onboard Command
 *
 * One-command setup for connecting cloud providers, applying protection rules,
 * and configuring alerts. Designed for both human use and AI agent automation.
 */

import { Command } from "commander";
import { outputJson, outputError, handleError, spinner, success, fail } from "../output.js";
import { ask } from "../prompts.js";
import type { ClientFactory } from "../types.js";

const PROVIDER_HELP: Record<string, { name: string; fields: string; howToGet: string }> = {
  cloudflare: {
    name: "Cloudflare",
    fields: "--account-id and --token",
    howToGet: `How to get these values:

  Account ID:
    Found in your browser URL bar on any Cloudflare dashboard page:
    https://dash.cloudflare.com/<ACCOUNT_ID>/example.com
    Or run: curl -s -H "Authorization: Bearer TOKEN" https://api.cloudflare.com/client/v4/accounts | jq '.result[].id'

  API Token (NOT Global API Key):
    1. Go to https://dash.cloudflare.com/profile/api-tokens
    2. Click "Create Token"
    3. Use the "Edit Cloudflare Workers" template, or create custom with:
       - Account > Account Analytics > Read
       - Account > Workers Scripts > Edit
       - Account > Workers R2 Storage > Read
       - Account > D1 > Read
       - Zone > Zone > Read
    4. Copy the token (starts with a long alphanumeric string)

  NOTE: The Global API Key will NOT work. You must create an API Token.`,
  },
  gcp: {
    name: "Google Cloud",
    fields: "--project-id and --service-account",
    howToGet: `How to get these values:

  Project ID:
    Run: gcloud config get-value project
    Or find it at: https://console.cloud.google.com/home/dashboard (project selector)

  Service Account Key (JSON):
    1. Go to https://console.cloud.google.com/iam-admin/serviceaccounts
    2. Create a service account with "Viewer" + "Cloud Run Admin" roles
    3. Create a JSON key: Actions > Manage Keys > Add Key > JSON
    4. Pass the file contents: --service-account "$(cat key.json)"`,
  },
  aws: {
    name: "Amazon Web Services",
    fields: "--access-key, --secret-key, and --region",
    howToGet: `How to get these values:

  Access Key ID & Secret Access Key:
    1. Go to https://console.aws.amazon.com/iam/home#/security_credentials
    2. Create an access key (or use an existing IAM user with read permissions)
    3. Copy both the Access Key ID and Secret Access Key
    Run: aws configure get aws_access_key_id

  Region:
    Run: aws configure get region
    Common values: us-east-1, us-west-2, eu-west-1`,
  },
  runpod: {
    name: "RunPod",
    fields: "--runpod-api-key",
    howToGet: `How to get this value:

  API Key:
    1. Go to https://www.runpod.io/console/user/settings
    2. Scroll to "API Keys" section
    3. Click "Create API Key" (or copy an existing one)
    4. The key starts with a long alphanumeric string

  Required permissions:
    - Read access to pods, serverless endpoints, and network volumes
    - Write access if you want auto-kill actions (stop/terminate pods, scale endpoints)`,
  },
  redis: {
    name: "Redis",
    fields: "--redis-url (self-hosted) or --redis-cloud-key + --redis-cloud-secret + --subscription-id",
    howToGet: `Redis supports three deployment types:

  Self-hosted Redis:
    Provide a connection URL: --redis-url redis://user:pass@host:6379

  Redis Cloud:
    1. Go to https://app.redislabs.com/#/account/api-keys
    2. Create an API key pair (Account Key + Secret Key)
    3. Find your subscription ID in the console
    Use: --redis-cloud-key KEY --redis-cloud-secret SECRET --subscription-id ID

  AWS ElastiCache:
    Use AWS credentials + cluster ID:
    --access-key AKIA... --secret-key ... --region us-east-1 --cluster-id my-cluster`,
  },
  mongodb: {
    name: "MongoDB",
    fields: "--mongodb-uri (self-hosted) or --atlas-public-key + --atlas-private-key + --atlas-project-id",
    howToGet: `MongoDB supports two deployment types:

  MongoDB Atlas:
    1. Go to Organization > Access Manager > API Keys
    2. Create a key with "Project Read Only" + "Project Cluster Manager" roles
    Use: --atlas-public-key PUB --atlas-private-key PRIV --atlas-project-id PROJ --cluster-name Cluster0

  Self-hosted MongoDB:
    Provide a URI: --mongodb-uri mongodb+srv://user:pass@host/db`,
  },
};

const AVAILABLE_SHIELDS = [
  "cost-runaway", "ddos", "brute-force", "error-storm",
  "exfiltration", "gpu-runaway", "lambda-loop", "aws-cost-runaway",
];

export function registerOnboardCommands(program: Command, createClient: ClientFactory) {
  program
    .command("onboard")
    .alias("setup")
    .description("Quick setup: connect a cloud provider, apply protection, configure alerts")
    .option("--provider <provider>", "Cloud provider: cloudflare, gcp, aws")
    .option("--name <name>", "Account name (e.g., Production)")
    .option("--token <token>", "API token (Cloudflare)")
    .option("--account-id <id>", "Account ID (Cloudflare)")
    .option("--project-id <id>", "Project ID (GCP)")
    .option("--service-account <json>", "Service Account JSON (GCP)")
    .option("--access-key <key>", "Access Key ID (AWS)")
    .option("--secret-key <key>", "Secret Access Key (AWS)")
    .option("--region <region>", "Region (AWS, default: us-east-1)")
    .option("--runpod-api-key <key>", "API Key (RunPod)")
    .option("--shields <presets>", "Comma-separated shield presets to apply (default: cost-runaway)")
    .option("--alert-email <email>", "Email address for alerts")
    .option("--alert-discord <url>", "Discord webhook URL for alerts")
    .option("--alert-slack <url>", "Slack webhook URL for alerts")
    .option("--skip-shields", "Skip applying protection rules")
    .option("--skip-alerts", "Skip setting up alerts")
    .option("--help-provider <provider>", "Show how to get credentials for a provider")
    .addHelpText("after", `
Examples:

  # Interactive onboarding
  kill-switch onboard

  # AI agent / non-interactive: connect Cloudflare
  kill-switch onboard \\
    --provider cloudflare \\
    --account-id 14a6fa23390363382f378b5bd4a0f849 \\
    --token cf-api-token-here \\
    --name "Production" \\
    --shields cost-runaway,ddos \\
    --alert-email you@example.com

  # Show how to get Cloudflare credentials
  kill-switch onboard --help-provider cloudflare

  # Connect AWS with shields
  kill-switch onboard \\
    --provider aws \\
    --access-key AKIA... \\
    --secret-key wJalr... \\
    --region us-east-1 \\
    --shields aws-cost-runaway,gpu-runaway

Available shields: ${AVAILABLE_SHIELDS.join(", ")}
    `)
    .action(async (opts) => {
      const json = program.opts().json;

      // Help for a specific provider
      if (opts.helpProvider) {
        const help = PROVIDER_HELP[opts.helpProvider];
        if (!help) {
          outputError(`Unknown provider: ${opts.helpProvider}. Use: cloudflare, gcp, aws, runpod`, json);
          process.exit(1);
        }
        if (json) {
          outputJson({ provider: opts.helpProvider, ...help });
        } else {
          console.log(`\n${help.name} — required flags: ${help.fields}\n`);
          console.log(help.howToGet);
          console.log();
        }
        return;
      }

      try {
        const client = createClient();
        let provider = opts.provider;
        let name = opts.name;

        // Interactive mode if no provider specified
        if (!provider) {
          if (json) {
            outputError("--provider is required in JSON mode. Use: cloudflare, gcp, aws, runpod", json);
            process.exit(1);
          }

          console.log("\n\u26a1 Kill Switch Onboarding\n");
          console.log("Let's connect your cloud provider and set up cost protection.\n");

          console.log("Available providers:");
          console.log("  1. cloudflare  — Workers, R2, D1, Queues, Stream");
          console.log("  2. gcp         — Cloud Run, Compute, GKE, BigQuery");
          console.log("  3. aws         — EC2, Lambda, RDS, ECS, S3");
          console.log("  4. runpod      — GPU Pods, Serverless Endpoints, Network Volumes");
          console.log();

          const choice = await ask("Choose a provider (1/2/3/4 or name): ");
          provider = { "1": "cloudflare", "2": "gcp", "3": "aws", "4": "runpod" }[choice] || choice;
        }

        if (!PROVIDER_HELP[provider]) {
          outputError(`Unknown provider: ${provider}. Use: cloudflare, gcp, aws, runpod`, json);
          process.exit(1);
        }

        if (!name && !json) {
          name = await ask("Account name (e.g., Production): ");
        }
        name = name || `${PROVIDER_HELP[provider].name} account`;

        // Build credential
        const credential: Record<string, string> = { provider };
        if (provider === "cloudflare") {
          let accountId = opts.accountId;
          let token = opts.token;

          if (!accountId && !json) {
            console.log("\n  Tip: Your Account ID is in the URL: dash.cloudflare.com/<ACCOUNT_ID>/...");
            accountId = await ask("  Cloudflare Account ID: ");
          }
          if (!token && !json) {
            console.log("\n  Tip: Create an API Token (not Global Key) at:");
            console.log("  https://dash.cloudflare.com/profile/api-tokens");
            console.log("  Use the 'Edit Cloudflare Workers' template.\n");
            token = await ask("  API Token: ");
          }
          if (!accountId || !token) {
            outputError(`Cloudflare requires ${PROVIDER_HELP.cloudflare.fields}`, json);
            process.exit(1);
          }
          credential.accountId = accountId;
          credential.apiToken = token;
        } else if (provider === "gcp") {
          let projectId = opts.projectId;
          let serviceAccount = opts.serviceAccount;

          if (!projectId && !json) {
            console.log("\n  Tip: Run `gcloud config get-value project` to find your project ID.");
            projectId = await ask("  GCP Project ID: ");
          }
          if (!serviceAccount && !json) {
            console.log("\n  Tip: Create at IAM > Service Accounts > Manage Keys > Add Key > JSON");
            serviceAccount = await ask("  Service Account Key JSON: ");
          }
          if (!projectId || !serviceAccount) {
            outputError(`GCP requires ${PROVIDER_HELP.gcp.fields}`, json);
            process.exit(1);
          }
          credential.projectId = projectId;
          credential.serviceAccountJson = serviceAccount;
        } else if (provider === "aws") {
          let accessKey = opts.accessKey;
          let secretKey = opts.secretKey;
          let region = opts.region;

          if (!accessKey && !json) {
            console.log("\n  Tip: Find at IAM > Security Credentials, or `aws configure get aws_access_key_id`");
            accessKey = await ask("  AWS Access Key ID: ");
          }
          if (!secretKey && !json) {
            secretKey = await ask("  AWS Secret Access Key: ");
          }
          if (!region && !json) {
            region = await ask("  AWS Region (default: us-east-1): ");
          }
          if (!accessKey || !secretKey) {
            outputError(`AWS requires ${PROVIDER_HELP.aws.fields}`, json);
            process.exit(1);
          }
          credential.awsAccessKeyId = accessKey;
          credential.awsSecretAccessKey = secretKey;
          credential.awsRegion = region || "us-east-1";
        } else if (provider === "runpod") {
          let apiKey = opts.runpodApiKey;

          if (!apiKey && !json) {
            console.log("\n  Tip: Create an API Key at https://www.runpod.io/console/user/settings");
            apiKey = await ask("  RunPod API Key: ");
          }
          if (!apiKey) {
            outputError(`RunPod requires ${PROVIDER_HELP.runpod.fields}`, json);
            process.exit(1);
          }
          credential.runpodApiKey = apiKey;
        }

        // 1. Connect cloud account
        const s = json ? null : spinner(`Connecting ${PROVIDER_HELP[provider].name}...`).start();
        const account = await client.accounts.create({
          provider: provider as any,
          name,
          credential: credential as any,
        });
        s?.stop();
        if (!json) success(`Connected: ${account.name || account.id}`);

        // 2. Apply shields
        if (!opts.skipShields) {
          const shieldList = opts.shields
            ? opts.shields.split(",").map((s: string) => s.trim())
            : ["cost-runaway"];

          if (!json) console.log(`\nApplying ${shieldList.length} shield(s)...`);
          for (const shield of shieldList) {
            try {
              await client.rules.applyPreset(shield);
              if (!json) success(`  ${shield}`);
            } catch (err: any) {
              if (!json) fail(`  ${shield}: ${err.message}`);
            }
          }
        }

        // 3. Set up alerts
        if (!opts.skipAlerts) {
          const channels: any[] = [];
          if (opts.alertEmail) {
            channels.push({ type: "email", name: "Email", config: { email: opts.alertEmail }, enabled: true });
          }
          if (opts.alertDiscord) {
            channels.push({ type: "discord", name: "Discord", config: { webhookUrl: opts.alertDiscord }, enabled: true });
          }
          if (opts.alertSlack) {
            channels.push({ type: "slack", name: "Slack", config: { webhookUrl: opts.alertSlack }, enabled: true });
          }

          if (channels.length === 0 && !json) {
            const email = await ask("\nAlert email (or Enter to skip): ");
            if (email) {
              channels.push({ type: "email", name: "Email", config: { email }, enabled: true });
            }
          }

          if (channels.length > 0) {
            if (!json) console.log("Setting up alerts...");
            try {
              await client.alerts.updateChannels(channels);
              if (!json) success(`  ${channels.length} alert channel(s) configured`);
            } catch (err: any) {
              if (!json) fail(`  Alerts: ${err.message}`);
            }
          }
        }

        // 4. Complete onboarding
        try {
          await client.account.update({ onboardingCompleted: true });
        } catch {
          // Non-critical
        }

        if (json) {
          outputJson({
            success: true,
            provider,
            accountId: account.id,
            accountName: account.name,
          });
        } else {
          console.log(`\nSetup complete! Kill Switch is monitoring your ${PROVIDER_HELP[provider].name} account.`);
          console.log("\nNext steps:");
          console.log("  kill-switch accounts list      — view connected accounts");
          console.log("  kill-switch check               — run a monitoring check");
          console.log("  kill-switch shield --list       — see all available shields");
          console.log("  kill-switch onboard --provider  — add another provider\n");
        }
      } catch (err) {
        handleError(err, json);
      }
    });
}
