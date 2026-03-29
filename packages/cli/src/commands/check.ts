import { Command } from "commander";
import { outputJson, formatTable, handleError, spinner, success, colors as c } from "../output.js";
import type { ClientFactory } from "../types.js";

export function registerCheckCommands(program: Command, createClient: ClientFactory) {
  program
    .command("check")
    .description("Run monitoring check on all connected accounts")
    .action(async () => {
      const json = program.opts().json;
      const s = json ? null : spinner("Running monitoring check...").start();
      try {
        const client = createClient();
        const data = await client.monitoring.checkAll();
        s?.stop();
        if (json) {
          outputJson(data);
        } else {
          const results = data.results || [];
          console.log(`Checked ${c.bold(String(results.length))} account(s)\n`);
          for (const r of results) {
            console.log(`${c.bold((r.provider || "unknown") + ":")} ${(r as any).name || r.cloudAccountId}`);
            if (r.violations?.length) {
              formatTable(r.violations, [
                { key: "metric", header: "Metric" },
                { key: "value", header: "Value" },
                { key: "threshold", header: "Threshold" },
              ]);
            } else {
              success("All clear\n");
            }
          }
        }
      } catch (err) {
        s?.stop();
        handleError(err, json);
      }
    });
}
