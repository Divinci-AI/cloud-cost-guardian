import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { createServer, type Server, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { execFile, execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * End-to-end: drive the *built* CLI binary as a subprocess against a mock API
 * server, exercising the real auth → config-file → authenticated-call chain
 * (not the in-process handler harness used by the other CLI tests).
 */

const cliDir = resolve(dirname(fileURLToPath(import.meta.url)), ".."); // packages/cli
const cliBin = join(cliDir, "dist", "index.js");

let server: Server;
let baseUrl: string;
let home: string; // shared temp HOME so login persists config for the later call
let requests: Array<{ method?: string; url?: string; auth?: string }> = [];

beforeAll(async () => {
  // Ensure the binary is current (incremental tsc).
  execFileSync("npm", ["run", "build"], { cwd: cliDir, stdio: "ignore" });
  if (!existsSync(cliBin)) throw new Error("CLI build did not produce dist/index.js");

  home = mkdtempSync(join(tmpdir(), "ks-e2e-home-"));

  server = createServer((req: IncomingMessage, res) => {
    requests.push({ method: req.method, url: req.url, auth: req.headers["authorization"] as string });
    res.setHeader("content-type", "application/json");
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      if (req.url === "/accounts/me") {
        res.end(JSON.stringify({ _id: "acct_e2e", name: "E2E Acct", tier: "pro" }));
      } else if (req.url === "/cloud-accounts") {
        res.end(JSON.stringify({ accounts: [{ id: "a1", provider: "aws", name: "Prod", status: "active" }] }));
      } else {
        res.statusCode = 404;
        res.end(JSON.stringify({ error: "not found" }));
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}, 120_000);

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

beforeEach(() => { requests = []; });

/** Run the built CLI with a clean env (no inherited KS vars) + per-call overrides. */
function runCli(args: string[], extraEnv: Record<string, string> = {}): Promise<{ stdout: string; stderr: string; code: number }> {
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home };
  delete env.KILL_SWITCH_API_KEY;
  delete env.KILL_SWITCH_API_URL;
  Object.assign(env, extraEnv);
  return new Promise((res) => {
    execFile("node", [cliBin, ...args], { env }, (err: any, stdout, stderr) => {
      res({ stdout, stderr, code: err?.code ?? 0 });
    });
  });
}

describe("CLI e2e (built binary vs mock API)", () => {
  it("auth login --api-key validates against the API and persists config", async () => {
    const { stdout } = await runCli(
      ["--json", "auth", "login", "--api-key", "ks_live_e2e"],
      { KILL_SWITCH_API_URL: baseUrl }, // auth login reads the URL from env
    );
    const parsed = JSON.parse(stdout);
    expect(parsed).toEqual({ authenticated: true, account: "E2E Acct" });

    // It hit /accounts/me with the bearer key…
    const me = requests.find((r) => r.url === "/accounts/me");
    expect(me?.auth).toBe("Bearer ks_live_e2e");

    // …and wrote the key to the config file in our temp HOME.
    const cfg = JSON.parse(readFileSync(join(home, ".kill-switch", "config.json"), "utf8"));
    expect(cfg.apiKey).toBe("ks_live_e2e");
    expect(cfg.apiUrl).toBe(baseUrl);
  });

  it("a later command reads the persisted config and calls the API authenticated", async () => {
    // No --api-key, no env vars — must come entirely from the config written above.
    const { stdout } = await runCli(["--json", "accounts", "list"]);
    const list = JSON.parse(stdout);
    expect(list).toEqual([{ id: "a1", provider: "aws", name: "Prod", status: "active" }]);

    const call = requests.find((r) => r.url === "/cloud-accounts");
    expect(call?.method).toBe("GET");
    expect(call?.auth).toBe("Bearer ks_live_e2e");
  });

  it("explicit --api-key/--api-url flags work without any saved config", async () => {
    const { stdout } = await runCli([
      "--json", "--api-url", baseUrl, "--api-key", "ks_live_flag",
      "accounts", "list",
    ], { HOME: mkdtempSync(join(tmpdir(), "ks-e2e-empty-")) }); // empty HOME → no config file
    const list = JSON.parse(stdout);
    expect(list[0].id).toBe("a1");
    expect(requests.find((r) => r.url === "/cloud-accounts")?.auth).toBe("Bearer ks_live_flag");
  });

  it("auth status reports the authenticated account from saved config", async () => {
    const { stdout } = await runCli(["--json", "auth", "status"]);
    const parsed = JSON.parse(stdout);
    expect(parsed.authenticated).toBe(true);
    expect(parsed.tier).toBe("pro");
  });
});
