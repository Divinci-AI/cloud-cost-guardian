import { Command } from "commander";
import { outputJson, formatTable, handleError, spinner, warn, colors as c } from "../output.js";
import { fetchOrgContext, orgBanner } from "../org-context.js";
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
        const [accountInfo, accounts, rules, sequences, channels, analytics, orgCtx] = await Promise.all([
          client.billing.status().catch(() => null),
          client.accounts.list().catch(() => []),
          client.rules.list().catch(() => []),
          client.database.list().catch(() => []),
          client.alerts.channels().catch(() => []),
          client.analytics.overview().catch(() => null) as Promise<any>,
          fetchOrgContext(client),
        ]);

        s?.stop();

        if (json) {
          outputJson({
            tier: accountInfo?.tier || "unknown",
            limits: accountInfo?.limits,
            activeOrgId: orgCtx?.activeOrgId ?? null,
            activeOrgName: orgCtx?.activeOrgName ?? null,
            orgCount: orgCtx?.orgCount ?? null,
            accounts: accounts.length,
            rules: rules.length,
            activeKillSequences: sequences.length,
            alertChannels: channels.length,
            totalSpendPeriod: analytics?.totalSpendPeriod ?? 0,
            savingsEstimate: analytics?.savingsEstimate ?? 0,
            killSwitchActions: analytics?.killSwitchActions ?? 0,
          });
          return;
        }

        // Header
        console.log(c.bold("\nKill Switch Status\n"));

        // Active org — accounts/rules/alerts below are scoped to it
        const banner = orgBanner(orgCtx);
        if (banner) console.log(`  ${banner}`);

        // Tier
        const tier = accountInfo?.tier || "unknown";
        const tierColor = tier === "free" ? c.dim : tier === "pro" ? c.cyan : c.green;
        console.log(`  ${c.bold("Plan:")}       ${tierColor(tier)}`);

        // Accounts
        const activeAccounts = (accounts as any[]).filter((a) => a.status === "active").length;
        const limit = accountInfo?.limits?.cloudAccounts;
        console.log(`  ${c.bold("Accounts:")}   ${activeAccounts} active${limit ? c.dim(` / ${limit} max`) : ""}`);

        // Rules (programmatic kill rules — account-level thresholds are set per account)
        const enabledRules = (rules as any[]).filter((r) => r.enabled).length;
        console.log(`  ${c.bold("Kill rules:")} ${enabledRules} enabled${rules.length > enabledRules ? c.dim(` (${rules.length} total)`) : ""}${enabledRules === 0 ? c.dim("  · thresholds set per account") : ""}`);

        // Kill sequences
        if (sequences.length > 0) {
          warn(`  ${c.bold("Kill sequences:")} ${sequences.length} active`);
        } else {
          console.log(`  ${c.bold("Kill seqs:")}  ${c.dim("none")}`);
        }

        // Alert channels
        if ((channels as any[]).length > 0) {
          const enabledChannels = (channels as any[]).filter((ch: any) => ch.enabled !== false).length;
          console.log(`  ${c.bold("Alerts:")}     ${enabledChannels} channel(s) — ${(channels as any[]).map((ch: any) => ch.type).join(", ")}`);
        } else {
          console.log(`  ${c.bold("Alerts:")}     ${c.yellow("none")} — run: ks alerts add --type pagerduty --routing-key KEY`);
        }

        // 30-day spend summary
        if (analytics) {
          const totalSpend = analytics.totalSpendPeriod ?? 0;
          const savings = analytics.savingsEstimate ?? 0;
          const actions = analytics.killSwitchActions ?? 0;
          console.log(`  ${c.bold("Spend (30d):")} $${totalSpend.toFixed(2)}${savings > 0 ? c.green(` · $${savings.toFixed(2)} saved`) : ""}${actions > 0 ? c.yellow(` · ${actions} action(s) taken`) : ""}`);
        }

        // Connected accounts table
        if ((accounts as any[]).length > 0) {
          console.log(c.bold("\nConnected Accounts:\n"));
          formatTable(accounts, [
            { key: "provider",       header: "Provider",   width: 12 },
            { key: "name",           header: "Name",       width: 25 },
            { key: "status",         header: "Status",     width: 12 },
            { key: "lastCheckStatus", header: "Last Check", width: 12 },
          ]);
        } else {
          console.log(`\n  ${c.dim("No accounts connected. Run:")} ks onboard`);
        }

        // Alert channels detail
        if ((channels as any[]).length > 0) {
          console.log(c.bold("\nAlert Channels:\n"));
          formatTable(channels, [
            { key: "type",          header: "Type",    width: 14 },
            { key: "name",          header: "Name",    width: 20 },
            { key: "enabled",       header: "Enabled", width: 8  },
            { key: "configPreview", header: "Config",  width: 30 },
          ]);
        }

        console.log();
      } catch (err) {
        s?.stop();
        handleError(err, json);
      }
    });
}
