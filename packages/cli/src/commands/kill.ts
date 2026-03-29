import { Command } from "commander";
import { outputJson, formatTable, formatObject, handleError, spinner, success, warn, colors as c } from "../output.js";
import { confirm } from "../prompts.js";
import type { ClientFactory } from "../types.js";

export function registerKillCommands(program: Command, createClient: ClientFactory) {
  const kill = program.command("kill").description("Database kill switch sequences");

  kill
    .command("init")
    .description("Initiate a database kill sequence")
    .requiredOption("--credential-id <id>", "Stored credential ID")
    .requiredOption("--trigger <reason>", "Kill trigger reason")
    .action(async (opts) => {
      const { json, yes } = program.opts();
      try {
        const ok = await confirm(
          `${c.red("WARNING:")} This will start a database kill sequence. Continue?`,
          { yes, json },
        );
        if (!ok) {
          console.log("Aborted.");
          return;
        }

        const s = json ? null : spinner("Initiating kill sequence...").start();
        const client = createClient();
        const data = await client.database.initiate({
          credentialId: opts.credentialId,
          trigger: opts.trigger,
        });
        s?.stop();
        if (json) {
          outputJson(data);
        } else {
          warn(`Kill sequence initiated: ${c.bold(data.id)}`);
          console.log(`  Status: ${data.status}`);
          console.log(`  Steps: ${data.steps?.map((s) => s.action).join(" → ")}`);
          console.log(`\n  Advance: ${c.dim(`ks kill advance ${data.id} --credential-id ${opts.credentialId}`)}`);
        }
      } catch (err) {
        handleError(err, json);
      }
    });

  kill
    .command("status [id]")
    .description("Get kill sequence status (or list all active)")
    .action(async (id) => {
      const json = program.opts().json;
      try {
        const client = createClient();
        if (id) {
          const data = await client.database.get(id);
          if (json) {
            outputJson(data);
          } else {
            formatObject(data, ["id", "status", "currentStep", "snapshotVerified"]);
            if (data.steps) {
              console.log("\nSteps:");
              formatTable(data.steps, [
                { key: "action", header: "Action" },
                { key: "status", header: "Status" },
                { key: "timestamp", header: "Timestamp" },
              ]);
            }
          }
        } else {
          const sequences = await client.database.list();
          if (json) {
            outputJson(sequences);
          } else {
            formatTable(sequences, [
              { key: "id", header: "Sequence ID" },
              { key: "status", header: "Status" },
              { key: "currentStep", header: "Step" },
            ]);
          }
        }
      } catch (err) {
        handleError(err, json);
      }
    });

  kill
    .command("advance <id>")
    .description("Execute the next step in a kill sequence")
    .requiredOption("--credential-id <credId>", "Stored credential ID")
    .option("--human-approval", "Confirm human approval (required for nuke step)")
    .action(async (id, opts) => {
      const { json, yes } = program.opts();
      try {
        const ok = await confirm(
          `Execute the next step in kill sequence ${id}?`,
          { yes, json },
        );
        if (!ok) {
          console.log("Aborted.");
          return;
        }

        const s = json ? null : spinner("Executing step...").start();
        const client = createClient();
        const data = await client.database.advance(id, {
          credentialId: opts.credentialId,
          humanApproval: opts.humanApproval || false,
        });
        s?.stop();
        if (json) {
          outputJson(data);
        } else {
          success(`Step executed: ${data.steps?.[data.currentStep! - 1]?.action || "?"}`);
          console.log(`  Status: ${data.status}`);
          if (data.status !== "completed") {
            console.log(`  Next: ${c.dim(`ks kill advance ${id} --credential-id ${opts.credentialId}`)}`);
          }
        }
      } catch (err) {
        handleError(err, json);
      }
    });

  kill
    .command("abort <id>")
    .description("Abort a kill sequence")
    .action(async (id) => {
      const { json, yes } = program.opts();
      try {
        const ok = await confirm(`Abort kill sequence ${id}?`, { yes, json });
        if (!ok) {
          console.log("Aborted.");
          return;
        }
        const client = createClient();
        await client.database.abort(id);
        if (json) {
          outputJson({ aborted: true, id });
        } else {
          success(`Kill sequence ${id} aborted.`);
        }
      } catch (err) {
        handleError(err, json);
      }
    });
}
