import { Command } from "commander";
import { readFileSync } from "node:fs";
import { outputJson, handleError, spinner, colors as c } from "../output.js";
import { interpolateEnv, parseSpec, reconcile, type PlanItem } from "../apply.js";
import { BIN } from "../program-name.js";
import type { ClientFactory } from "../types.js";

const MARK: Record<PlanItem["change"], string> = { create: "+", update: "~", unchanged: "=" };
const MARK_COLOR: Record<PlanItem["change"], (s: string) => string> = {
  create: c.green, update: c.cyan, unchanged: c.dim,
};

/**
 * `ks apply -f config.{yaml,json}` — declarative, idempotent integration-as-code.
 * Reconciles an account + thresholds/flags + shields + alerts from one file so
 * teams stop hand-rolling *.config.ts. Secrets stay out via ${ENV} interpolation.
 */
export function registerApplyCommand(program: Command, createClient: ClientFactory) {
  program
    .command("apply")
    .description("Apply a declarative integration config (account, thresholds, shields, alerts)")
    .requiredOption("-f, --file <path>", "Config file (.yaml, .yml, or .json)")
    .option("--dry-run", "Show what would change without applying it")
    .addHelpText("after", `
Example config (apply with: ${BIN} apply -f ks.yaml):

  account:
    provider: mongodb
    name: Divinci Production Atlas
    credential:                    # only needed to create; \${ENV} interpolated
      mongodbSubType: atlas
      atlasPublicKey: \${ATLAS_PUBLIC_KEY}
      atlasPrivateKey: \${ATLAS_PRIVATE_KEY}
      atlasProjectId: \${ATLAS_PROJECT_ID}
      atlasClusterName: divinci-prod-api-cluster0
    thresholds: { mongodbDailyCostUSD: 40, monthlySpendLimitUSD: 1200 }
    protectedServices: [divinci-prod-api-cluster0]
    productionProtected: true
  shields: [cost-runaway]
  alerts:
    - { type: pagerduty, routingKey: \${PD_ROUTING_KEY}, name: On-Call }
`)
    .action(async (opts) => {
      const json = program.opts().json;
      let spec;
      try {
        const raw = readFileSync(opts.file, "utf-8");
        // Interpolate ${ENV} on the raw text *before* parsing (envsubst-style), so
        // secrets live in the environment — and so unquoted ${VAR} doesn't trip
        // YAML's flow syntax. Then parse the substituted text.
        spec = parseSpec(interpolateEnv(raw), opts.file);
      } catch (err) {
        return handleError(err, json);
      }

      const s = json ? null : spinner(opts.dryRun ? "Planning..." : "Applying...").start();
      try {
        const client = createClient();
        const result = await reconcile(client, spec, { dryRun: opts.dryRun });
        s?.stop();

        if (json) {
          outputJson(result);
          return;
        }

        console.log(c.bold(`\n${opts.dryRun ? "Plan" : "Applied"}: ${opts.file}\n`));
        for (const it of result.items) {
          console.log(`  ${MARK_COLOR[it.change](MARK[it.change])} ${it.resource} ${c.dim(`— ${it.detail}`)}`);
        }
        const changed = result.items.filter((i) => i.change !== "unchanged").length;
        console.log();
        if (opts.dryRun) {
          console.log(`  ${c.yellow(`${changed} change(s) planned.`)} Re-run without --dry-run to apply.`);
        } else {
          console.log(`  ${c.green(`Done — ${changed} change(s) applied.`)}`);
        }
        console.log();
      } catch (err) {
        s?.stop();
        handleError(err, json);
      }
    });
}
