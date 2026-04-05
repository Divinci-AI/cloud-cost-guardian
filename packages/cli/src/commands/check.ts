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
          const totalViolations = results.reduce((n: number, r: any) => n + (r.violations?.length || 0), 0);
          console.log(`Checked ${c.bold(String(results.length))} account(s) — ${totalViolations === 0 ? c.green("all clear") : c.red(totalViolations + " violation(s)")}\n`);

          for (const r of results as any[]) {
            const statusMark = r.status === "violation" ? c.red("✗") : r.status === "error" ? c.yellow("⚠") : c.green("✓");
            console.log(`${statusMark} ${c.bold((r.provider || "unknown").padEnd(12))} ${r.name || r.cloudAccountId}`);

            if (r.violations?.length) {
              // Compute multiplier for each violation inline
              const rows = r.violations.map((v: any) => ({
                ...v,
                multiplier: v.threshold > 0 ? `${Math.round(v.currentValue / v.threshold)}x` : "—",
              }));
              formatTable(rows, [
                { key: "serviceName",  header: "Service",    width: 28 },
                { key: "metricName",   header: "Metric",     width: 22 },
                { key: "currentValue", header: "Current",    width: 14 },
                { key: "threshold",    header: "Threshold",  width: 12 },
                { key: "multiplier",   header: "Over",       width: 8  },
                { key: "severity",     header: "Severity",   width: 10 },
              ]);
              if (r.actionsTaken?.length) {
                console.log(c.dim(`  Actions: ${r.actionsTaken.join(", ")}`));
              }
            }
            console.log();
          }
        }
      } catch (err) {
        s?.stop();
        handleError(err, json);
      }
    });
}
