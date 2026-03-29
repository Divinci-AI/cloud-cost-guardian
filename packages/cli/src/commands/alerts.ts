import { Command } from "commander";
import { outputJson, formatTable, handleError, spinner, success } from "../output.js";
import type { ClientFactory } from "../types.js";

export function registerAlertCommands(program: Command, createClient: ClientFactory) {
  const alerts = program.command("alerts").description("Manage alert channels");

  alerts
    .command("list")
    .alias("ls")
    .description("List configured alert channels")
    .action(async () => {
      const json = program.opts().json;
      try {
        const client = createClient();
        const channels = await client.alerts.channels();
        if (json) {
          outputJson(channels);
        } else {
          formatTable(channels, [
            { key: "type", header: "Type" },
            { key: "name", header: "Name" },
            { key: "enabled", header: "Enabled" },
          ]);
        }
      } catch (err) {
        handleError(err, json);
      }
    });

  alerts
    .command("test")
    .description("Send a test alert to all channels")
    .action(async () => {
      const json = program.opts().json;
      const s = json ? null : spinner("Sending test alert...").start();
      try {
        const client = createClient();
        const data = await client.alerts.test();
        s?.stop();
        if (json) {
          outputJson(data);
        } else {
          success(`Test alert sent to ${data.channelsSent} channel(s).`);
        }
      } catch (err) {
        s?.stop();
        handleError(err, json);
      }
    });
}
