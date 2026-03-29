import { Command } from "commander";
import { outputJson, formatTable, handleError } from "../output.js";
import type { ClientFactory } from "../types.js";

export function registerActivityCommands(program: Command, createClient: ClientFactory) {
  const activity = program.command("activity").description("View audit trail and activity logs");

  activity
    .command("list")
    .alias("ls")
    .description("Query activity log (owner/admin only)")
    .option("--page <n>", "Page number", "1")
    .option("--limit <n>", "Results per page (max 100)", "25")
    .option("--action <prefix>", "Filter by action prefix (e.g., cloud_account, rule, team, kill_switch)")
    .option("--resource-type <type>", "Filter by resource type")
    .option("--actor <userId>", "Filter by actor user ID")
    .option("--from <date>", "Start date (ISO format)")
    .option("--to <date>", "End date (ISO format)")
    .action(async (opts) => {
      const json = program.opts().json;
      try {
        const client = createClient();
        const data = await client.activity.list({
          page: parseInt(opts.page) || undefined,
          limit: parseInt(opts.limit) || undefined,
          action: opts.action,
          resourceType: opts.resourceType,
          actorUserId: opts.actor,
          from: opts.from,
          to: opts.to,
        });

        if (json) {
          outputJson(data);
        } else {
          console.log(`Activity Log — Page ${data.page} (${data.total} total entries)\n`);
          formatTable((data.entries || []).map((e: any) => ({
            time: new Date(e.created_at).toLocaleString(),
            actor: e.actor_email || e.actor_user_id?.substring(0, 12) || "—",
            action: e.action,
            resource: `${e.resource_type}${e.resource_id ? `:${e.resource_id.substring(0, 8)}` : ""}`,
          })), [
            { key: "time", header: "Time" },
            { key: "actor", header: "Actor" },
            { key: "action", header: "Action" },
            { key: "resource", header: "Resource" },
          ]);

          const totalPages = Math.ceil(data.total / data.limit);
          if (totalPages > 1) {
            console.log(`\nPage ${data.page} of ${totalPages}. Use --page ${data.page + 1} for next.`);
          }
        }
      } catch (err) {
        handleError(err, json);
      }
    });

  // Shorthand: `ks activity` without subcommand shows recent
  activity
    .action(async () => {
      const json = program.opts().json;
      try {
        const client = createClient();
        const data = await client.activity.list({ limit: 10 });
        if (json) {
          outputJson(data);
        } else {
          console.log("Recent Activity (last 10):\n");
          for (const e of data.entries || []) {
            const time = new Date((e as any).created_at).toLocaleTimeString();
            const actor = (e as any).actor_email || (e as any).actor_user_id?.substring(0, 12) || "?";
            console.log(`  ${time}  ${actor}  ${e.action}  ${e.resourceType || ""}`);
          }
          if (data.total > 10) {
            console.log(`\n  ... ${data.total - 10} more. Use 'ks activity list' for full log.`);
          }
        }
      } catch (err) {
        handleError(err, json);
      }
    });
}
