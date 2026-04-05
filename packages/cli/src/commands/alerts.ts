import { Command } from "commander";
import { outputJson, formatTable, handleError, spinner, success } from "../output.js";
import type { ClientFactory } from "../types.js";
import type { AlertChannel, AlertChannelType } from "@kill-switch/sdk";

export function registerAlertCommands(program: Command, createClient: ClientFactory) {
  const alerts = program.command("alerts").description("Manage alert channels");

  alerts
    .command("list")
    .alias("ls")
    .description("List configured alert channels")
    .action(async () => {
      const json = program.opts().json;
      try {
        const client = createClient();
        const channels = await client.alerts.channels();
        if (json) {
          outputJson(channels);
        } else {
          formatTable(channels, [
            { key: "type", header: "Type" },
            { key: "name", header: "Name" },
            { key: "enabled", header: "Enabled" },
            { key: "configPreview", header: "Config" },
          ]);
        }
      } catch (err) {
        handleError(err, json);
      }
    });

  alerts
    .command("add")
    .description("Add an alert channel")
    .requiredOption("--type <type>", "Channel type: pagerduty | slack | discord | webhook | email | github")
    .option("--name <name>", "Display name for this channel")
    .option("--routing-key <key>", "PagerDuty Events API v2 routing key")
    .option("--webhook-url <url>", "Webhook URL (Slack, Discord, or custom webhook)")
    .option("--email <address>", "Email address")
    // GitHub options
    .option("--token <token>", "GitHub Personal Access Token (repo + workflow scopes)")
    .option("--repo-owner <owner>", "GitHub repository owner / org")
    .option("--repo-name <name>", "GitHub repository name")
    .option("--workflow <file>", "Workflow filename (default: kill-switch-remediate.yml)")
    .option("--branch <ref>", "Branch to dispatch on (default: main)")
    .action(async (opts) => {
      const json = program.opts().json;
      const s = json ? null : spinner("Adding alert channel...").start();
      try {
        const type = opts.type as AlertChannelType;
        const validTypes: AlertChannelType[] = ["pagerduty", "slack", "discord", "webhook", "email", "github"];
        if (!validTypes.includes(type)) {
          throw new Error(`Unknown type "${type}". Valid types: ${validTypes.join(", ")}`);
        }

        // Build config and validate required fields per type
        const config: AlertChannel["config"] = {};
        if (type === "pagerduty") {
          if (!opts.routingKey) throw new Error("--routing-key is required for pagerduty");
          config.routingKey = opts.routingKey;
        } else if (type === "slack" || type === "discord" || type === "webhook") {
          if (!opts.webhookUrl) throw new Error(`--webhook-url is required for ${type}`);
          config.webhookUrl = opts.webhookUrl;
        } else if (type === "email") {
          if (!opts.email) throw new Error("--email is required for email");
          config.email = opts.email;
        } else if (type === "github") {
          if (!opts.token) throw new Error("--token is required for github");
          if (!opts.repoOwner) throw new Error("--repo-owner is required for github");
          if (!opts.repoName) throw new Error("--repo-name is required for github");
          config.githubToken = opts.token;
          config.repoOwner = opts.repoOwner;
          config.repoName = opts.repoName;
          config.workflowFile = opts.workflow || "kill-switch-remediate.yml";
          config.branchRef = opts.branch || "main";
        }

        const channel: AlertChannel = {
          type,
          name: opts.name || type.charAt(0).toUpperCase() + type.slice(1),
          enabled: true,
          config,
        };

        const client = createClient();
        const result = await client.alerts.addChannel(channel);
        s?.stop();

        if (json) {
          outputJson(result);
        } else {
          success(`Channel added. You now have ${result.channelCount} alert channel(s).`);
        }
      } catch (err) {
        s?.stop();
        handleError(err, json);
      }
    });

  alerts
    .command("remove")
    .alias("rm")
    .description("Remove an alert channel by name")
    .argument("<name>", "Channel name to remove")
    .action(async (name) => {
      const json = program.opts().json;
      const s = json ? null : spinner(`Removing channel "${name}"...`).start();
      try {
        const client = createClient();
        const result = await client.alerts.removeChannel(name);
        s?.stop();
        if (json) {
          outputJson(result);
        } else {
          success(`Channel removed. ${result.channelCount} channel(s) remaining.`);
        }
      } catch (err) {
        s?.stop();
        handleError(err, json);
      }
    });

  alerts
    .command("test")
    .description("Send a test alert to all channels")
    .action(async () => {
      const json = program.opts().json;
      const s = json ? null : spinner("Sending test alert...").start();
      try {
        const client = createClient();
        const data = await client.alerts.test();
        s?.stop();
        if (json) {
          outputJson(data);
        } else {
          success(`Test alert sent to ${data.channelsSent} channel(s).`);
        }
      } catch (err) {
        s?.stop();
        handleError(err, json);
      }
    });
}
