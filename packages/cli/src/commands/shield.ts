import { Command } from "commander";
import { outputJson, formatTable, handleError, spinner, success, colors as c } from "../output.js";
import type { ClientFactory } from "../types.js";

const PRESETS = [
  "ddos", "brute-force", "cost-runaway", "error-storm",
  "exfiltration", "gpu-runaway", "lambda-loop", "aws-cost-runaway",
];

export function registerShieldCommands(program: Command, createClient: ClientFactory) {
  program
    .command("shield [preset]")
    .description("Quick-apply a protection preset (e.g., kill-switch shield cost-runaway)")
    .option("--list", "List available shields")
    .option("--dry-run", "Preview what the shield would do without applying")
    .action(async (preset, opts) => {
      const json = program.opts().json;
      const client = createClient();

      if (opts.list || !preset) {
        try {
          const presets = await client.rules.presets();
          if (json) {
            outputJson(presets);
          } else {
            console.log("Available shields:\n");
            formatTable(presets, [
              { key: "id", header: "Shield", width: 20 },
              { key: "name", header: "Name", width: 30 },
              { key: "description", header: "Description", width: 50 },
            ]);
            console.log("\nUsage: kill-switch shield <preset-id>");
          }
        } catch (err) {
          handleError(err, json);
        }
        return;
      }

      if (!PRESETS.includes(preset)) {
        handleError(new Error(`Unknown preset "${preset}". Run: kill-switch shield --list`), json);
      }

      if (opts.dryRun) {
        try {
          const presets = await client.rules.presets();
          const match = presets.find((p) => p.id === preset);
          if (json) {
            outputJson({ dryRun: true, preset, details: match });
          } else {
            console.log(c.yellow("Dry run — shield would be applied:"));
            console.log(`  ${c.bold("Shield:")}  ${match?.name || preset}`);
            console.log(`  ${c.bold("Description:")} ${match?.description || "N/A"}`);
            console.log(`  ${c.bold("Category:")} ${match?.category || "N/A"}`);
          }
        } catch (err) {
          handleError(err, json);
        }
        return;
      }

      const s = json ? null : spinner(`Applying ${preset} shield...`).start();
      try {
        const rule = await client.rules.applyPreset(preset);
        s?.stop();
        if (json) {
          outputJson(rule);
        } else {
          success(`Shield activated: ${rule.name || preset}`);
          if (rule.id) console.log(`  Rule ID: ${c.dim(rule.id)}`);
        }
      } catch (err) {
        s?.stop();
        handleError(err, json);
      }
    });
}
