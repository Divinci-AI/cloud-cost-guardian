import { Command } from "commander";
import { outputJson, formatTable, handleError, spinner, success, warn, colors as c } from "../output.js";
import type { ClientFactory } from "../types.js";

export function registerStatusCommand(program: Command, createClient: ClientFactory) {
  program
    .command("status")
    .description("Show a quick overview of your Kill Switch setup")
    .action(async () => {
      const json = program.opts().json;
      const s = json ? null : spinner("Loading status...").start();
      try {
        const client = createClient();

        // Fire all requests in parallel
        const [accountInfo, accounts, rules, sequences] = await Promise.all([
          client.billing.status().catch(() => null),
          client.accounts.list().catch(() => []),
          client.rules.list().catch(() => []),
          client.database.list().catch(() => []),
        ]);

        s?.stop();

        if (json) {
          outputJson({
            tier: accountInfo?.tier || "unknown",
            limits: accountInfo?.limits,
            accounts: accounts.length,
            rules: rules.length,
            activeKillSequences: sequences.length,
          });
          return;
        }

        // Header
        console.log(c.bold("\nKill Switch Status\n"));

        // Tier
        const tier = accountInfo?.tier || "unknown";
        const tierColor = tier === "free" ? c.dim : tier === "pro" ? c.cyan : c.green;
        console.log(`  ${c.bold("Plan:")}       ${tierColor(tier)}`);

        // Accounts
        const activeAccounts = accounts.filter((a) => a.status === "active").length;
        const limit = accountInfo?.limits?.cloudAccounts;
        console.log(`  ${c.bold("Accounts:")}   ${activeAccounts} active${limit ? c.dim(` / ${limit} max`) : ""}`);

        // Rules
        const enabledRules = rules.filter((r) => r.enabled).length;
        console.log(`  ${c.bold("Rules:")}      ${enabledRules} enabled${rules.length > enabledRules ? c.dim(` (${rules.length} total)`) : ""}`);

        // Kill sequences
        if (sequences.length > 0) {
          warn(`  ${c.bold("Kill sequences:")} ${sequences.length} active`);
        } else {
          console.log(`  ${c.bold("Kill seqs:")}  ${c.dim("none")}`);
        }

        // Account details
        if (accounts.length > 0) {
          console.log(c.bold("\nConnected Accounts:\n"));
          formatTable(accounts, [
            { key: "provider", header: "Provider", width: 12 },
            { key: "name", header: "Name", width: 25 },
            { key: "status", header: "Status", width: 12 },
            { key: "lastCheckStatus", header: "Last Check", width: 12 },
          ]);
        } else {
          console.log(`\n  ${c.dim("No accounts connected. Run:")} ks onboard`);
        }

        console.log();
      } catch (err) {
        s?.stop();
        handleError(err, json);
      }
    });
}
