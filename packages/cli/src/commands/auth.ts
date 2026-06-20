import { Command } from "commander";
import { KillSwitchClient } from "@kill-switch/sdk";
import { saveConfig, deleteConfig, resolveApiKey, resolveApiUrl } from "../config.js";
import { outputJson, formatObject, outputError, handleError, spinner, success, fail } from "../output.js";
import { ask } from "../prompts.js";
import { execFile } from "child_process";
import { CLI_VERSION } from "../version.js";
import { runDeviceFlow, defaultDeviceFlowDeps } from "../device-flow.js";
import { BIN } from "../program-name.js";
import type { ClientFactory } from "../types.js";

function openBrowser(url: string): void {
  const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
  execFile(cmd, [url], () => {});
}

// Wires the device-flow helper to this command's spinner + console output.
// Kept here (not in device-flow.ts) so the helper stays free of CLI-specific
// presentation concerns and remains pure for unit testing.
function deviceFlowWithSpinner() {
  let sp: ReturnType<typeof spinner> | null = null;
  return defaultDeviceFlowDeps({
    log: (line) => console.log(line),
    spinnerStart: (label) => { sp = spinner(label).start(); },
    spinnerStop: () => { sp?.stop(); sp = null; },
  });
}

export function registerAuthCommands(program: Command, createClient: ClientFactory) {
  const auth = program.command("auth").description("Manage authentication");

  auth
    .command("setup")
    .description("Authenticate via your browser (opens a one-time approval page)")
    .option("--manual", "Manual flow: open Settings page, paste the key yourself")
    .action(async (opts) => {
      const json = program.opts().json;
      const existing = resolveApiKey();

      if (existing) {
        try {
          const client = createClient();
          const result = await client.account.me();
          if (!json) {
            console.log(`Already authenticated as ${result.name || result._id}.`);
            const proceed = await ask("Re-authenticate anyway? (y/N): ");
            if (proceed.toLowerCase() !== "y") return;
          }
        } catch {
          // Key invalid, proceed
        }
      }

      const apiUrl = resolveApiUrl();

      // Manual flow \u2014 original copy/paste path for offline / scripted setups
      if (opts.manual) {
        if (!json) {
          console.log("\n\u26a1 Kill Switch CLI Setup (manual)\n");
          console.log("1. Sign in at app.kill-switch.net");
          console.log("2. Go to Settings > API Keys");
          console.log("3. Click 'Create API Key'");
          console.log("4. Copy the key and paste it below\n");
        }
        openBrowser("https://app.kill-switch.net/settings");
        const key = await ask("Paste your API key (ks_live_...): ");
        if (!key.startsWith("ks_")) {
          outputError("API key must start with 'ks_'.", json);
          process.exit(1);
        }
        try {
          const client = new KillSwitchClient({ apiKey: key, baseUrl: apiUrl });
          const result = await client.account.me();
          saveConfig({ apiKey: key, apiUrl });
          if (json) outputJson({ authenticated: true, account: result.name || result._id });
          else {
            success(`Authenticated as ${result.name || result._id}`);
            console.log("API key saved to ~/.kill-switch/config.json");
          }
        } catch (err) { handleError(err, json); }
        return;
      }

      // Device flow \u2014 default path
      try {
        const apiKey = await runDeviceFlow(apiUrl, CLI_VERSION, json, deviceFlowWithSpinner());
        const client = new KillSwitchClient({ apiKey, baseUrl: apiUrl });
        const result = await client.account.me();
        saveConfig({ apiKey, apiUrl });

        if (json) {
          outputJson({ authenticated: true, account: result.name || result._id });
        } else {
          success(`Authenticated as ${result.name || result._id}`);
          console.log("API key saved to ~/.kill-switch/config.json\n");
          console.log("Next: ks onboard --help-provider mongodb");
        }
      } catch (err) { handleError(err, json); }
    });

  auth
    .command("login")
    .description("Authenticate (browser device flow by default, or pass --api-key for direct)")
    .option("--api-key <key>", "Personal API key (starts with ks_) — skips browser flow")
    .action(async (opts) => {
      const json = program.opts().json;
      const apiUrl = resolveApiUrl(program.opts().apiUrl);
      // The program also declares a global --api-key/--api-url; by commander's
      // parent/child precedence the value lands on the PARENT even when passed
      // after `login`, leaving opts.apiKey undefined. Read from either place so
      // `ks auth login --api-key KEY` actually works.
      let key = opts.apiKey ?? program.opts().apiKey;

      // Device flow when no --api-key. JSON mode requires --api-key (no browser).
      if (!key) {
        if (json) {
          outputError("--api-key is required in JSON mode", json);
          process.exit(1);
        }
        try {
          key = await runDeviceFlow(apiUrl, CLI_VERSION, json, deviceFlowWithSpinner());
        } catch (err) {
          handleError(err, json);
          return;
        }
      }

      if (!key.startsWith("ks_")) {
        outputError("API key must start with 'ks_'. Create one at app.kill-switch.net or run: ks auth setup", json);
        process.exit(1);
      }

      const s = json ? null : spinner("Validating API key...").start();
      try {
        const client = new KillSwitchClient({
          apiKey: key,
          baseUrl: apiUrl,
        });
        const result = await client.account.me();
        s?.stop();
        saveConfig({ apiKey: key, apiUrl });

        if (json) {
          outputJson({ authenticated: true, account: result.name || result._id });
        } else {
          success(`Authenticated as ${result.name || result._id}`);
          console.log("API key saved to ~/.kill-switch/config.json");
        }
      } catch (err) {
        s?.stop();
        handleError(err, json);
      }
    });

  auth
    .command("logout")
    .description("Clear stored credentials")
    .action(() => {
      const json = program.opts().json;
      deleteConfig();
      if (json) {
        outputJson({ loggedOut: true });
      } else {
        console.log("Credentials cleared.");
      }
    });

  auth
    .command("status")
    .description("Show current auth status")
    .action(async () => {
      const json = program.opts().json;
      const key = resolveApiKey();

      if (!key) {
        if (json) {
          outputJson({ authenticated: false });
        } else {
          console.log(`Not authenticated. Run: ${BIN} auth login --api-key YOUR_KEY`);
        }
        return;
      }

      try {
        const client = createClient();
        const result = await client.account.me();
        if (json) {
          outputJson({ authenticated: true, ...result });
        } else {
          formatObject({
            authenticated: "yes",
            account: result.name || result._id,
            tier: result.tier,
            keyPrefix: key.substring(0, 16) + "...",
          });
        }
      } catch {
        if (json) {
          outputJson({ authenticated: false, keyPresent: true, error: "Key is invalid or expired" });
        } else {
          console.log(`API key present but invalid. Run: ${BIN} auth login --api-key NEW_KEY`);
        }
      }
    });
}
