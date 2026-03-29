import { Command } from "commander";
import { outputJson, formatTable, handleError, spinner, success, warn, fail, colors as c } from "../output.js";
import type { ClientFactory } from "../types.js";

export function registerWatchCommand(program: Command, createClient: ClientFactory) {
  program
    .command("watch")
    .description("Continuously monitor all accounts (polls on interval)")
    .option("--interval <seconds>", "Check interval in seconds", "60")
    .action(async (opts) => {
      const json = program.opts().json;
      const intervalSec = Math.max(10, parseInt(opts.interval) || 60);
      const client = createClient();

      if (!json) {
        console.log(c.bold(`\nKill Switch Watch Mode`) + c.dim(` (every ${intervalSec}s, Ctrl+C to stop)\n`));
      }

      const runCheck = async () => {
        const s = json ? null : spinner("Checking...").start();
        try {
          const data = await client.monitoring.checkAll();
          s?.stop();

          const results = data.results || [];
          const now = new Date().toLocaleTimeString();

          if (json) {
            outputJson({ checkedAt: now, ...data });
            return;
          }

          const totalViolations = results.reduce(
            (sum, r) => sum + (r.violations?.length || 0),
            0,
          );

          if (totalViolations === 0) {
            success(`${c.dim(now)} All ${results.length} account(s) clear`);
          } else {
            warn(`${c.dim(now)} ${c.bold(String(totalViolations))} violation(s) across ${results.length} account(s)`);
            for (const r of results) {
              if (r.violations?.length) {
                console.log(`  ${c.bold((r.provider || "?") + ":")} ${(r as any).name || r.cloudAccountId}`);
                for (const v of r.violations) {
                  console.log(`    ${c.red("!")} ${v.metricName}: ${v.currentValue} ${v.unit} (threshold: ${v.threshold})`);
                }
              }
            }
          }
        } catch (err: any) {
          s?.stop();
          if (json) {
            handleError(err, json);
          } else {
            const now = new Date().toLocaleTimeString();
            fail(`${c.dim(now)} Check failed: ${err.message}`);
          }
        }
      };

      // Run immediately
      await runCheck();

      // Then loop
      const timer = setInterval(runCheck, intervalSec * 1000);

      // Graceful shutdown
      const cleanup = () => {
        clearInterval(timer);
        if (!json) console.log(c.dim("\nWatch stopped."));
        process.exit(0);
      };
      process.on("SIGINT", cleanup);
      process.on("SIGTERM", cleanup);

      // Keep alive
      await new Promise(() => {});
    });
}
