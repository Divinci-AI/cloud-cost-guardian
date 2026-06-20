/**
 * `ks doctor` — one-stop diagnostic (dogfood feedback C1).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { Command } from "commander";
import type { ClientFactory } from "../src/types.js";

// Deterministic key/URL resolution so the diagnostic doesn't depend on the
// dev machine's real ~/.kill-switch config.
const resolveApiKey = vi.fn();
const resolveApiUrl = vi.fn();
vi.mock("../src/config.js", () => ({
  resolveApiKey: (...a: any[]) => resolveApiKey(...a),
  resolveApiUrl: (...a: any[]) => resolveApiUrl(...a),
}));

import { registerDoctorCommand } from "../src/commands/doctor.js";

function makeProgram() {
  return new Command().name("ks").option("--json").option("--api-key <key>").option("--api-url <url>").exitOverride();
}
function captureConsole() {
  const lines: string[] = [];
  vi.spyOn(console, "log").mockImplementation((...a) => { lines.push(a.join(" ")); });
  vi.spyOn(console, "error").mockImplementation(() => {});
  return lines;
}

const healthyClient: any = {
  account: { me: vi.fn() },
  accounts: { list: vi.fn() },
  alerts: { channels: vi.fn() },
};

beforeEach(() => {
  vi.clearAllMocks();
  process.exitCode = undefined;
  resolveApiUrl.mockReturnValue("https://api.kill-switch.net");
  resolveApiKey.mockReturnValue("ks_live_abcd1234");
  healthyClient.account.me.mockResolvedValue({
    _id: "u1", name: "Mike", activeOrgId: "o2",
    orgs: [{ id: "o1", name: "personal", role: "owner" }, { id: "o2", name: "divinci", role: "admin" }],
  });
  healthyClient.accounts.list.mockResolvedValue([{ status: "active" }, { status: "paused" }]);
  healthyClient.alerts.channels.mockResolvedValue([{ type: "pagerduty" }]);
});

describe("ks doctor", () => {
  it("reports all checks healthy and surfaces the active org", async () => {
    const program = makeProgram();
    registerDoctorCommand(program, (() => healthyClient) as ClientFactory);
    const lines = captureConsole();
    await program.parseAsync(["node", "ks", "doctor"]);
    const out = lines.join("\n");
    expect(out).toContain("authenticated as Mike");
    expect(out).toContain("divinci (admin)");   // active org, not the first org
    expect(out).toContain("2 org(s)");
    expect(out).toContain("2 connected (1 active)");
    expect(out).toContain("All checks passed");
    expect(process.exitCode).toBeFalsy();
  });

  it("fails (exit 1) and gives a login hint when no API key is set", async () => {
    resolveApiKey.mockReturnValue(undefined);
    const program = makeProgram();
    registerDoctorCommand(program, (() => healthyClient) as ClientFactory);
    const lines = captureConsole();
    await program.parseAsync(["node", "ks", "doctor"]);
    const out = lines.join("\n");
    expect(out).toContain("API key:");
    expect(out).toContain("not set");
    expect(out).toContain("auth login");
    expect(out).toContain("need attention");
    expect(process.exitCode).toBe(1);
    expect(healthyClient.account.me).not.toHaveBeenCalled(); // skipped network checks
  });

  it("flags a rejected API key (401) as a failure", async () => {
    healthyClient.account.me.mockRejectedValue(new Error("Request failed: 401 Unauthorized"));
    const program = makeProgram();
    registerDoctorCommand(program, (() => healthyClient) as ClientFactory);
    const lines = captureConsole();
    await program.parseAsync(["node", "ks", "doctor"]);
    const out = lines.join("\n");
    expect(out).toContain("API key rejected (401)");
    expect(process.exitCode).toBe(1);
  });

  it("emits structured JSON with --json", async () => {
    const program = makeProgram();
    registerDoctorCommand(program, (() => healthyClient) as ClientFactory);
    const lines = captureConsole();
    await program.parseAsync(["node", "ks", "--json", "doctor"]);
    const parsed = JSON.parse(lines.join("\n"));
    expect(parsed.ok).toBe(true);
    expect(parsed.checks.some((c: any) => c.name === "Active org")).toBe(true);
  });
});
