import { Command } from "commander";
import { KillSwitchClient } from "@kill-switch/sdk";
import { saveConfig, deleteConfig, resolveApiKey, resolveApiUrl } from "../config.js";
import { outputJson, formatObject, outputError, handleError, spinner, success } from "../output.js";
import { ask } from "../prompts.js";
import { execFile } from "child_process";
import type { ClientFactory } from "../types.js";

function openBrowser(url: string): void {
  const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
  execFile(cmd, [url], () => {});
}

export function registerAuthCommands(program: Command, createClient: ClientFactory) {
  const auth = program.command("auth").description("Manage authentication");

  auth
    .command("setup")
    .description("Create an API key (opens browser to sign in, then paste the key)")
    .action(async () => {
      const json = program.opts().json;
      const existing = resolveApiKey();

      if (existing) {
        try {
          const client = createClient();
          const result = await client.account.me();
          if (!json) {
            console.log(`Already authenticated as ${result.name || result._id}.`);
            const proceed = await ask("Create a new API key anyway? (y/N): ");
            if (proceed.toLowerCase() !== "y") return;
          }
        } catch {
          // Key invalid, proceed
        }
      }

      if (!json) {
        console.log("\n\u26a1 Kill Switch CLI Setup\n");
        console.log("Opening app.kill-switch.net in your browser...");
        console.log("1. Sign in (or create an account)");
        console.log("2. Go to Settings > API Keys");
        console.log("3. Click 'Create API Key'");
        console.log("4. Copy the key and paste it below\n");
      }

      openBrowser("https://app.kill-switch.net/settings");

      const key = await ask("Paste your API key (ks_live_...): ");

      if (!key.startsWith("ks_")) {
        outputError("API key must start with 'ks_'. Try again.", json);
        process.exit(1);
      }

      try {
        // Validate with a fresh client using the provided key
        const client = new KillSwitchClient({
          apiKey: key,
          baseUrl: resolveApiUrl(),
        });
        const result = await client.account.me();
        saveConfig({ apiKey: key, apiUrl: resolveApiUrl() });

        if (json) {
          outputJson({ authenticated: true, account: result.name || result._id });
        } else {
          success(`Authenticated as ${result.name || result._id}`);
          console.log("API key saved to ~/.kill-switch/config.json\n");
          console.log("Next: ks onboard --provider cloudflare --help-provider cloudflare");
        }
      } catch (err) {
        handleError(err, json);
      }
    });

  auth
    .command("login")
    .description("Authenticate with an existing API key")
    .option("--api-key <key>", "Personal API key (starts with ks_)")
    .action(async (opts) => {
      const json = program.opts().json;
      let key = opts.apiKey;

      if (!key) {
        if (json) {
          outputError("--api-key is required in JSON mode", json);
          process.exit(1);
        }
        key = await ask("API key (ks_live_...): ");
      }

      if (!key.startsWith("ks_")) {
        outputError("API key must start with 'ks_'. Create one at app.kill-switch.net or run: ks auth setup", json);
        process.exit(1);
      }

      const s = json ? null : spinner("Validating API key...").start();
      try {
        const client = new KillSwitchClient({
          apiKey: key,
          baseUrl: resolveApiUrl(),
        });
        const result = await client.account.me();
        s?.stop();
        saveConfig({ apiKey: key, apiUrl: resolveApiUrl() });

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
          console.log("Not authenticated. Run: kill-switch auth login --api-key YOUR_KEY");
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
          console.log("API key present but invalid. Run: kill-switch auth login --api-key NEW_KEY");
        }
      }
    });
}
