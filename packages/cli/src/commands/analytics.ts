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
          console.log(c.bold(`Analytics (last ${opts.days} days)\n`));
          if (data.dailyCosts) {
            formatTable(data.dailyCosts.slice(-7), [
              { key: "date", header: "Date" },
              { key: "totalUsd", header: "Cost (USD)" },
              { key: "violations", header: "Violations" },
              { key: "actions", header: "Actions" },
            ]);
          }
          if (data.totalSavingsUsd !== undefined) {
            console.log(`\nEstimated savings: ${c.green("$" + data.totalSavingsUsd)}`);
          }
        }
      } catch (err) {
        s?.stop();
        handleError(err, json);
      }
    });
}
