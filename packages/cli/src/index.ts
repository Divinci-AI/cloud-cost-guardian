#!/usr/bin/env node
/**
 * Kill Switch CLI
 *
 * Monitor cloud spending, kill runaway services from the terminal.
 *
 * Usage:
 *   kill-switch auth login --api-key ks_live_abc123
 *   kill-switch shield cost-runaway
 *   kill-switch check
 *   kill-switch accounts list --json
 */

import { Command } from "commander";
import { KillSwitchClient } from "@kill-switch/sdk";
import { resolveApiKey, resolveApiUrl } from "./config.js";
import { registerAuthCommands } from "./commands/auth.js";
import { registerAccountCommands } from "./commands/accounts.js";
import { registerRuleCommands } from "./commands/rules.js";
import { registerShieldCommands } from "./commands/shield.js";
import { registerCheckCommands } from "./commands/check.js";
import { registerAlertCommands } from "./commands/alerts.js";
import { registerKillCommands } from "./commands/kill.js";
import { registerAnalyticsCommands } from "./commands/analytics.js";
import { registerConfigCommands } from "./commands/config-cmd.js";
import { registerOnboardCommands } from "./commands/onboard.js";
import { registerOrgCommands } from "./commands/orgs.js";
import { registerActivityCommands } from "./commands/activity.js";
import { registerStatusCommand } from "./commands/status.js";
import { registerWatchCommand } from "./commands/watch.js";
import { registerProviderCommands } from "./commands/providers.js";

import type { ClientFactory } from "./types.js";

const program = new Command();

program
  .name("kill-switch")
  .description("Monitor cloud spending, kill runaway services, protect your infrastructure")
  .version("0.1.0")
  .option("--json", "Output as JSON (for automation/scripting)")
  .option("--api-key <key>", "API key (overrides config and env)")
  .option("--api-url <url>", "API URL (overrides config and env)")
  .option("-y, --yes", "Skip confirmation prompts");

/**
 * Create an SDK client with the resolved apiKey/apiUrl.
 * Called lazily when a command runs (after options are parsed).
 */
const createClient: ClientFactory = () => {
  const opts = program.opts();
  return new KillSwitchClient({
    apiKey: resolveApiKey(opts.apiKey),
    baseUrl: resolveApiUrl(opts.apiUrl),
  });
};

registerAuthCommands(program, createClient);
registerAccountCommands(program, createClient);
registerRuleCommands(program, createClient);
registerShieldCommands(program, createClient);
registerCheckCommands(program, createClient);
registerAlertCommands(program, createClient);
registerKillCommands(program, createClient);
registerAnalyticsCommands(program, createClient);
registerConfigCommands(program);
registerOnboardCommands(program, createClient);
registerOrgCommands(program, createClient);
registerActivityCommands(program, createClient);
registerStatusCommand(program, createClient);
registerWatchCommand(program, createClient);
registerProviderCommands(program, createClient);

program.parse();
