/**
 * CLI device-flow login helper.
 *
 * Runs the start → openBrowser → poll → return-key sequence against the
 * Kill Switch API. Side effects (fetch, browser opening, spinner output,
 * sleep, hostname) are injected via `deps` so the loop logic can be unit
 * tested without touching the network, terminal, or system clock.
 */

import { execFile } from "node:child_process";
import { hostname as osHostname } from "node:os";

export interface DeviceFlowStart {
  code: string;
  verification_url: string;
  expires_in: number;
  polling_interval: number;
}

export interface DeviceFlowDeps {
  fetch: typeof fetch;
  sleep: (ms: number) => Promise<void>;
  openBrowser: (url: string) => void;
  hostname: () => string;
  /** Called with status lines for the user — wired to console.log in prod, no-op in tests. */
  log: (line: string) => void;
  /** Spinner start/stop wrappers — wire to ora in prod, no-op in tests. */
  spinnerStart: (label: string) => void;
  spinnerStop: () => void;
  /** Source of "now" in ms — overridable in tests for deadline math. */
  now: () => number;
}

const defaultSleep: DeviceFlowDeps["sleep"] = (ms) =>
  new Promise((r) => setTimeout(r, ms));

const defaultOpenBrowser: DeviceFlowDeps["openBrowser"] = (url) => {
  const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
  execFile(cmd, [url], () => {});
};

export function defaultDeviceFlowDeps(extras?: Partial<DeviceFlowDeps>): DeviceFlowDeps {
  return {
    fetch,
    sleep: defaultSleep,
    openBrowser: defaultOpenBrowser,
    hostname: osHostname,
    log: (line: string) => console.log(line),
    spinnerStart: () => {},
    spinnerStop: () => {},
    now: () => Date.now(),
    ...extras,
  };
}

/**
 * Run the device-flow login. Returns the freshly-minted API key on success;
 * throws on user denial, expiry, /start failure, or 10-minute timeout.
 */
export async function runDeviceFlow(
  apiUrl: string,
  cliVersion: string,
  json: boolean,
  deps: DeviceFlowDeps = defaultDeviceFlowDeps(),
): Promise<string> {
  // 1. Start session — anonymous, server mints the short-lived code.
  const startResp = await deps.fetch(`${apiUrl}/auth/cli/start`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ hostname: deps.hostname(), cliVersion }),
  });
  if (!startResp.ok) {
    const text = await startResp.text().catch(() => "");
    throw new Error(`Failed to start CLI auth (${startResp.status}): ${text.slice(0, 200)}`);
  }
  const start = (await startResp.json()) as DeviceFlowStart;

  if (!json) {
    deps.log("\n⚡ Kill Switch CLI Login\n");
    deps.log("Open this URL in your browser to authorize:");
    deps.log(`  ${start.verification_url}\n`);
    deps.log("Confirm this code matches what you see on the page:");
    deps.log(`  ${start.code}\n`);
  }

  deps.openBrowser(start.verification_url);

  // 2. Poll until approved / denied / expired / timeout.
  // `expires_in` is server-controlled (currently 600s / 10 min).
  // `polling_interval` is also server-controlled — we floor it at 1s
  // so a server bug can't crash us into a busy loop.
  const deadline = deps.now() + start.expires_in * 1000;
  const intervalMs = Math.max(1, start.polling_interval) * 1000;
  if (!json) deps.spinnerStart("Waiting for browser authorization...");

  try {
    while (deps.now() < deadline) {
      await deps.sleep(intervalMs);
      const pollResp = await deps.fetch(`${apiUrl}/auth/cli/poll`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: start.code }),
      });
      const body = (await pollResp.json().catch(() => ({}))) as any;

      if (pollResp.status === 200 && body.api_key) {
        deps.spinnerStop();
        return body.api_key as string;
      }
      if (pollResp.status === 410) {
        deps.spinnerStop();
        throw new Error(`CLI login ${body.status || "ended"} — please run \`ks auth login\` again.`);
      }
      if (pollResp.status === 404) {
        deps.spinnerStop();
        throw new Error("CLI login code expired before any response was recorded.");
      }
      // 202 pending → loop. Any other code → also loop and let the deadline catch us.
    }
    deps.spinnerStop();
    throw new Error("CLI login timed out after 10 minutes. Run `ks auth login` to try again.");
  } catch (e) {
    deps.spinnerStop();
    throw e;
  }
}
