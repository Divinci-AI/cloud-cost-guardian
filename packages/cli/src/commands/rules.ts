import { Command } from "commander";
import { outputJson, formatTable, handleError, success, colors as c } from "../output.js";
import { confirm } from "../prompts.js";
import type { ClientFactory } from "../types.js";

export function registerRuleCommands(program: Command, createClient: ClientFactory) {
  const rules = program.command("rules").description("Manage kill switch rules");

  rules
    .command("list")
    .alias("ls")
    .description("List active rules")
    .option("--trigger <type>", "Filter by trigger type (cost, security, custom, api, agent)")
    .option("--enabled", "Show only enabled rules")
    .option("--disabled", "Show only disabled rules")
    .action(async (opts) => {
      const json = program.opts().json;
      try {
        const client = createClient();
        let list = await client.rules.list();
        if (opts.trigger) list = list.filter((r) => r.trigger === opts.trigger);
        if (opts.enabled) list = list.filter((r) => r.enabled);
        if (opts.disabled) list = list.filter((r) => !r.enabled);
        if (json) {
          outputJson(list);
        } else {
          formatTable(list, [
            { key: "id", header: "ID" },
            { key: "name", header: "Name" },
            { key: "trigger", header: "Trigger" },
            { key: "enabled", header: "Enabled" },
          ]);
        }
      } catch (err) {
        handleError(err, json);
      }
    });

  rules
    .command("presets")
    .description("List available preset templates")
    .action(async () => {
      const json = program.opts().json;
      try {
        const client = createClient();
        const presets = await client.rules.presets();
        if (json) {
          outputJson(presets);
        } else {
          formatTable(presets, [
            { key: "id", header: "ID", width: 20 },
            { key: "name", header: "Name", width: 30 },
            { key: "description", header: "Description", width: 50 },
          ]);
        }
      } catch (err) {
        handleError(err, json);
      }
    });

  rules
    .command("create <name>")
    .description("Create a custom rule")
    .requiredOption("--trigger <type>", "Trigger type (cost, security, api)")
    .option("--condition <json>", "Condition JSON")
    .option("--action <json>", "Action JSON")
    .option("--dry-run", "Preview rule without creating it")
    .action(async (name, opts) => {
      const json = program.opts().json;
      try {
        const body: any = { name, trigger: opts.trigger };
        if (opts.condition) body.conditions = JSON.parse(opts.condition);
        if (opts.action) body.actions = JSON.parse(opts.action);

        if (opts.dryRun) {
          if (json) {
            outputJson({ dryRun: true, rule: body });
          } else {
            console.log(c.yellow("Dry run — rule would be created:"));
            console.log(JSON.stringify(body, null, 2));
          }
          return;
        }

        const client = createClient();
        const rule = await client.rules.create(body);
        if (json) {
          outputJson(rule);
        } else {
          success(`Rule created: ${rule.id}`);
        }
      } catch (err) {
        handleError(err, json);
      }
    });

  rules
    .command("delete <id>")
    .alias("rm")
    .description("Delete a rule")
    .action(async (id) => {
      const { json, yes } = program.opts();
      try {
        const ok = await confirm(`Delete rule ${id}?`, { yes, json });
        if (!ok) {
          console.log("Aborted.");
          return;
        }
        const client = createClient();
        await client.rules.delete(id);
        if (json) {
          outputJson({ deleted: true, id });
        } else {
          success(`Rule ${id} deleted.`);
        }
      } catch (err) {
        handleError(err, json);
      }
    });

  rules
    .command("toggle <id>")
    .description("Enable/disable a rule")
    .action(async (id) => {
      const json = program.opts().json;
      try {
        const client = createClient();
        const rule = await client.rules.toggle(id);
        if (json) {
          outputJson(rule);
        } else {
          success(`Rule ${id} is now ${rule.enabled ? c.green("enabled") : c.yellow("disabled")}.`);
        }
      } catch (err) {
        handleError(err, json);
      }
    });
}
