#!/usr/bin/env node
/**
 * Kill Switch CLI
 *
 * Monitor cloud spending, kill runaway services from the terminal.
 *
 * Usage (also available as `kill-switch`):
 *   ks auth login --api-key ks_live_abc123
 *   ks shield cost-runaway
 *   ks check
 *   ks accounts list --json
 */

import { Command } from "commander";
import { KillSwitchClient } from "@kill-switch/sdk";
import { resolveApiKey, resolveApiUrl } from "./config.js";
import { outputError } from "./output.js";
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
import { registerAgentGuardCommands } from "./commands/agent-guard.js";
import { registerDoctorCommand } from "./commands/doctor.js";

import type { ClientFactory } from "./types.js";
import { CLI_VERSION } from "./version.js";
import { BIN } from "./program-name.js";

const program = new Command();

program
  .name(BIN)
  .description("Monitor cloud spending, kill runaway services, protect your infrastructure")
  .version(CLI_VERSION)
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
  try {
    return new KillSwitchClient({
      apiKey: resolveApiKey(opts.apiKey),
      baseUrl: resolveApiUrl(opts.apiUrl),
    });
  } catch (err) {
    // e.g. a malformed / non-https apiUrl from config/env (resolveApiUrl throws).
    // Some commands build the client outside their try/catch, so handle it here
    // to emit a clean error instead of a raw stack trace.
    outputError(err instanceof Error ? err.message : String(err), opts.json);
    process.exit(1);
  }
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
registerDoctorCommand(program, createClient);
registerWatchCommand(program, createClient);
registerProviderCommands(program, createClient);
registerAgentGuardCommands(program);

program.parse();
