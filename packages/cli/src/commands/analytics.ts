import { Command } from "commander";
import { outputJson, formatTable, handleError, spinner, colors as c } from "../output.js";
import type { ClientFactory } from "../types.js";

export function registerAnalyticsCommands(program: Command, createClient: ClientFactory) {
  program
    .command("analytics")
    .description("FinOps analytics overview")
    .option("--days <n>", "Days to analyze", "30")
    .action(async (opts) => {
      const json = program.opts().json;
      const s = json ? null : spinner("Loading analytics...").start();
      try {
        const client = createClient();
        const data = await client.analytics.overview() as any;
        s?.stop();
        if (json) {
          outputJson(data);
        } else {
          console.log(c.bold(`\nAnalytics Overview\n`));

          // Summary stats
          const totalSpend = data.totalSpendPeriod ?? 0;
          const avgDaily = data.avgDailyCost ?? 0;
          const projected = data.projectedMonthlyCost ?? 0;
          const savings = data.savingsEstimate ?? 0;
          const actions = data.killSwitchActions ?? 0;

          console.log(`  ${c.bold("Total spend:")}        $${totalSpend.toFixed(2)}`);
          console.log(`  ${c.bold("Avg daily cost:")}     $${avgDaily.toFixed(2)}`);
          console.log(`  ${c.bold("Projected monthly:")}  $${projected.toFixed(2)}`);
          console.log(`  ${c.bold("Savings estimate:")}   ${c.green("$" + savings.toFixed(2))}`);
          console.log(`  ${c.bold("Kill switch actions:")} ${actions > 0 ? c.yellow(String(actions)) : c.dim("0")}`);

          // Last 7 days cost table
          if (data.dailyCosts?.length) {
            console.log(c.bold("\nLast 7 Days:\n"));
            formatTable(data.dailyCosts.slice(-7), [
              { key: "date",       header: "Date",       width: 12 },
              { key: "cost",       header: "Cost (USD)", width: 12 },
              { key: "services",   header: "Services",   width: 10 },
              { key: "violations", header: "Violations", width: 12 },
            ]);
          }

          // Per-account breakdown
          if (data.accountBreakdown?.length) {
            console.log(c.bold("\nAccount Breakdown:\n"));
            formatTable(data.accountBreakdown, [
              { key: "provider",     header: "Provider",     width: 14 },
              { key: "totalCost",    header: "Total Cost",   width: 12 },
              { key: "avgDailyCost", header: "Avg Daily",    width: 12 },
            ]);
          }

          console.log();
        }
      } catch (err) {
        s?.stop();
        handleError(err, json);
      }
    });
}
