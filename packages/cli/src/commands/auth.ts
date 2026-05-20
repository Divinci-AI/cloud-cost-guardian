import { Command } from "commander";
import { KillSwitchClient } from "@kill-switch/sdk";
import { saveConfig, deleteConfig, resolveApiKey, resolveApiUrl } from "../config.js";
import { outputJson, formatObject, outputError, handleError, spinner, success, fail } from "../output.js";
import { ask } from "../prompts.js";
import { execFile } from "child_process";
import { hostname } from "os";
import type { ClientFactory } from "../types.js";

function openBrowser(url: string): void {
  const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
  execFile(cmd, [url], () => {});
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

interface DeviceFlowStart {
  code: string;
  verification_url: string;
  expires_in: number;
  polling_interval: number;
}

async function runDeviceFlow(apiUrl: string, cliVersion: string, json: boolean): Promise<string> {
  // 1. Start session
  const startResp = await fetch(`${apiUrl}/auth/cli/start`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ hostname: hostname(), cliVersion }),
  });
  if (!startResp.ok) {
    throw new Error(`Failed to start CLI auth (${startResp.status}): ${await startResp.text().then(t => t.slice(0, 200))}`);
  }
  const start = (await startResp.json()) as DeviceFlowStart;

  if (!json) {
    console.log("\n⚡ Kill Switch CLI Login\n");
    console.log("Open this URL in your browser to authorize:");
    console.log(`  ${start.verification_url}\n`);
    console.log("Confirm this code matches what you see on the page:");
    console.log(`  ${start.code}\n`);
  }

  openBrowser(start.verification_url);

  // 2. Poll until approved / denied / expired
  const deadline = Date.now() + start.expires_in * 1000;
  const intervalMs = Math.max(1, start.polling_interval) * 1000;
  const sp = json ? null : spinner("Waiting for browser authorization...").start();

  try {
    while (Date.now() < deadline) {
      await sleep(intervalMs);
      const pollResp = await fetch(`${apiUrl}/auth/cli/poll`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: start.code }),
      });
      const body = (await pollResp.json().catch(() => ({}))) as any;

      if (pollResp.status === 200 && body.api_key) {
        sp?.stop();
        return body.api_key;
      }
      if (pollResp.status === 410) {
        sp?.stop();
        throw new Error(`CLI login ${body.status || "ended"} — please run \`ks auth login\` again.`);
      }
      if (pollResp.status === 404) {
        sp?.stop();
        throw new Error("CLI login code expired before any response was recorded.");
      }
      // 202 pending → loop
    }
    sp?.stop();
    throw new Error("CLI login timed out after 10 minutes. Run `ks auth login` to try again.");
  } catch (e) {
    sp?.stop();
    throw e;
  }
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
        const cliVersion = "0.2.0";
        const apiKey = await runDeviceFlow(apiUrl, cliVersion, json);
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
      const apiUrl = resolveApiUrl();
      let key = opts.apiKey;

      // Device flow when no --api-key. JSON mode requires --api-key (no browser).
      if (!key) {
        if (json) {
          outputError("--api-key is required in JSON mode", json);
          process.exit(1);
        }
        try {
          key = await runDeviceFlow(apiUrl, "0.2.0", json);
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
