/**
 * CLI command tests: accounts, alerts, orgs, providers, rules, activity, kill,
 * and auth (status/logout). Mirrors commands.test.ts — a fresh Commander program
 * with an injected mock SDK client, invoked via parseAsync.
 *
 * Most assertions run in --json mode: that makes confirm() auto-true (so
 * destructive commands proceed without a prompt) and the spinner a no-op, while
 * outputJson() emits a single parseable blob.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Command } from "commander";
import type { ClientFactory } from "../src/types.js";

// auth.ts resolves the API key + writes config via ./config.js, whose paths are
// computed from homedir() at import time. Mock it so auth tests are isolated
// from (and never mutate) the real ~/.kill-switch/config.json.
vi.mock("../src/config.js", () => ({
  resolveApiKey: vi.fn(),
  resolveApiUrl: vi.fn(() => "https://api.kill-switch.net"),
  saveConfig: vi.fn(),
  deleteConfig: vi.fn(),
  loadConfig: vi.fn(() => ({})),
  CONFIG_FILE: "/tmp/ks-test-config.json",
  CONFIG_DIR: "/tmp",
  DEFAULT_API_URL: "https://api.kill-switch.net",
}));
import { resolveApiKey, deleteConfig, loadConfig } from "../src/config.js";

import { registerAccountCommands } from "../src/commands/accounts.js";
import { registerAlertCommands } from "../src/commands/alerts.js";
import { registerOrgCommands } from "../src/commands/orgs.js";
import { registerProviderCommands } from "../src/commands/providers.js";
import { registerRuleCommands } from "../src/commands/rules.js";
import { registerActivityCommands } from "../src/commands/activity.js";
import { registerKillCommands } from "../src/commands/kill.js";
import { registerAuthCommands } from "../src/commands/auth.js";
import { registerShieldCommands } from "../src/commands/shield.js";
import { registerOnboardCommands } from "../src/commands/onboard.js";
import { registerConfigCommands } from "../src/commands/config-cmd.js";

function makeProgram() {
  return new Command()
    .name("ks")
    .option("--json", "JSON output")
    .option("--api-key <key>")
    .option("--api-url <url>")
    .option("-y, --yes")
    .exitOverride();
}

function captureConsole() {
  const lines: string[] = [];
  vi.spyOn(console, "log").mockImplementation((...a) => { lines.push(a.join(" ")); });
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  return lines;
}

/** parse helper that returns parsed JSON from the captured output */
function parseJson(lines: string[]) {
  return JSON.parse(lines.join(""));
}

beforeEach(() => vi.clearAllMocks());
afterEach(() => vi.restoreAllMocks());

// ── accounts ──────────────────────────────────────────────────────────────
describe("ks accounts", () => {
  const list = vi.fn(), get = vi.fn(), create = vi.fn(), del = vi.fn(), check = vi.fn(), update = vi.fn();
  // orgs.list lets `accounts list` fetch its org banner without throwing.
  const client: any = { accounts: { list, get, create, delete: del, check, update }, orgs: { list: vi.fn().mockResolvedValue({ orgs: [], activeOrgId: null }) } };
  const createClient: ClientFactory = () => client;

  it("list --json returns the accounts", async () => {
    list.mockResolvedValue([{ id: "a1", provider: "aws", status: "active" }]);
    const p = makeProgram(); registerAccountCommands(p, createClient);
    const out = captureConsole();
    await p.parseAsync(["node", "ks", "--json", "accounts", "list"]);
    expect(parseJson(out)).toEqual([{ id: "a1", provider: "aws", status: "active" }]);
  });

  it("list --provider filters client-side", async () => {
    list.mockResolvedValue([
      { id: "a1", provider: "aws", status: "active" },
      { id: "a2", provider: "gcp", status: "active" },
    ]);
    const p = makeProgram(); registerAccountCommands(p, createClient);
    const out = captureConsole();
    await p.parseAsync(["node", "ks", "--json", "accounts", "list", "--provider", "gcp"]);
    const parsed = parseJson(out);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].provider).toBe("gcp");
  });

  it("get <id> calls accounts.get with the id", async () => {
    get.mockResolvedValue({ id: "a1" });
    const p = makeProgram(); registerAccountCommands(p, createClient);
    captureConsole();
    await p.parseAsync(["node", "ks", "--json", "accounts", "get", "a1"]);
    expect(get).toHaveBeenCalledWith("a1");
  });

  it("add builds the credential from flags", async () => {
    create.mockResolvedValue({ id: "a9", name: "Prod" });
    const p = makeProgram(); registerAccountCommands(p, createClient);
    captureConsole();
    await p.parseAsync([
      "node", "ks", "--json", "accounts", "add", "cloudflare",
      "--name", "Prod", "--token", "tok", "--account-id", "acc",
    ]);
    expect(create).toHaveBeenCalledWith({
      provider: "cloudflare",
      name: "Prod",
      credential: { apiToken: "tok", accountId: "acc" },
    });
  });

  it("add mongodb (atlas) infers subtype and builds the credential", async () => {
    create.mockResolvedValue({ id: "m1", name: "Atlas" });
    const p = makeProgram(); registerAccountCommands(p, createClient);
    captureConsole();
    await p.parseAsync([
      "node", "ks", "--json", "accounts", "add", "mongodb", "--name", "Atlas",
      "--atlas-public-key", "pub", "--atlas-private-key", "priv", "--atlas-project-id", "proj",
    ]);
    expect(create).toHaveBeenCalledWith({
      provider: "mongodb",
      name: "Atlas",
      credential: { mongodbSubType: "atlas", atlasPublicKey: "pub", atlasPrivateKey: "priv", atlasProjectId: "proj" },
    });
  });

  it("add errors when no credentials are provided", async () => {
    const p = makeProgram(); registerAccountCommands(p, createClient);
    captureConsole();
    const exit = vi.spyOn(process, "exit").mockImplementation(((c: number) => { throw new Error("exit:" + c); }) as never);
    await expect(
      p.parseAsync(["node", "ks", "--json", "accounts", "add", "redis", "--name", "R"]),
    ).rejects.toThrow("exit:1");
    expect(create).not.toHaveBeenCalled();
    exit.mockRestore();
  });

  it("update <id> maps flags to UpdateAccountInput (incl. productionProtected)", async () => {
    update.mockResolvedValue({ id: "a1", name: "Prod Atlas" });
    const p = makeProgram(); registerAccountCommands(p, createClient);
    captureConsole();
    await p.parseAsync([
      "node", "ks", "--json", "accounts", "update", "a1",
      "--production-protected", "false", "--threshold", "mongodbDailyCostUSD=75", "--status", "paused",
    ]);
    expect(update).toHaveBeenCalledWith("a1", {
      productionProtected: false,
      thresholds: { mongodbDailyCostUSD: 75 },
      status: "paused",
    });
  });

  it("update with no fields errors instead of calling the API", async () => {
    const p = makeProgram(); registerAccountCommands(p, createClient);
    captureConsole();
    const exit = vi.spyOn(process, "exit").mockImplementation(((c: number) => { throw new Error("exit:" + c); }) as never);
    await expect(
      p.parseAsync(["node", "ks", "--json", "accounts", "update", "a1"]),
    ).rejects.toThrow("exit:1");
    expect(update).not.toHaveBeenCalled();
    exit.mockRestore();
  });

  it("delete <id> proceeds in --json (confirm auto-true) and reports deleted", async () => {
    del.mockResolvedValue({ deleted: true });
    const p = makeProgram(); registerAccountCommands(p, createClient);
    const out = captureConsole();
    await p.parseAsync(["node", "ks", "--json", "accounts", "delete", "a1"]);
    expect(del).toHaveBeenCalledWith("a1");
    expect(parseJson(out)).toEqual({ deleted: true, id: "a1" });
  });

  it("check <id> calls accounts.check", async () => {
    check.mockResolvedValue({ violations: [] });
    const p = makeProgram(); registerAccountCommands(p, createClient);
    captureConsole();
    await p.parseAsync(["node", "ks", "--json", "accounts", "check", "a1"]);
    expect(check).toHaveBeenCalledWith("a1");
  });
});

// ── alerts ────────────────────────────────────────────────────────────────
describe("ks alerts", () => {
  const channels = vi.fn(), addChannel = vi.fn(), removeChannel = vi.fn(), test = vi.fn();
  const client: any = { alerts: { channels, addChannel, removeChannel, test } };
  const createClient: ClientFactory = () => client;

  it("list --json returns channels", async () => {
    channels.mockResolvedValue([{ type: "slack", name: "Eng" }]);
    const p = makeProgram(); registerAlertCommands(p, createClient);
    const out = captureConsole();
    await p.parseAsync(["node", "ks", "--json", "alerts", "list"]);
    expect(parseJson(out)[0].type).toBe("slack");
  });

  it("add pagerduty builds the channel + config", async () => {
    addChannel.mockResolvedValue({ channelCount: 1 });
    const p = makeProgram(); registerAlertCommands(p, createClient);
    captureConsole();
    await p.parseAsync(["node", "ks", "--json", "alerts", "add", "--type", "pagerduty", "--routing-key", "RK", "--name", "On-Call"]);
    expect(addChannel).toHaveBeenCalledWith({
      type: "pagerduty",
      name: "On-Call",
      enabled: true,
      config: { routingKey: "RK" },
    });
  });

  it("add github applies workflow/branch defaults", async () => {
    addChannel.mockResolvedValue({ channelCount: 2 });
    const p = makeProgram(); registerAlertCommands(p, createClient);
    captureConsole();
    await p.parseAsync([
      "node", "ks", "--json", "alerts", "add", "--type", "github",
      "--token", "ghp_x", "--repo-owner", "org", "--repo-name", "repo",
    ]);
    const arg = addChannel.mock.calls[0][0];
    expect(arg.config.workflowFile).toBe("kill-switch-remediate.yml");
    expect(arg.config.branchRef).toBe("main");
    expect(arg.config.githubToken).toBe("ghp_x");
  });

  it("add with unknown type exits with an error", async () => {
    const exit = vi.spyOn(process, "exit").mockImplementation(((c: number) => { throw new Error("exit:" + c); }) as never);
    const p = makeProgram(); registerAlertCommands(p, createClient);
    captureConsole();
    await expect(
      p.parseAsync(["node", "ks", "--json", "alerts", "add", "--type", "carrierpigeon"]),
    ).rejects.toThrow("exit:1");
    expect(addChannel).not.toHaveBeenCalled();
    exit.mockRestore();
  });

  it("add pagerduty without routing-key exits with an error", async () => {
    const exit = vi.spyOn(process, "exit").mockImplementation(((c: number) => { throw new Error("exit:" + c); }) as never);
    const p = makeProgram(); registerAlertCommands(p, createClient);
    captureConsole();
    await expect(
      p.parseAsync(["node", "ks", "--json", "alerts", "add", "--type", "pagerduty"]),
    ).rejects.toThrow("exit:1");
    exit.mockRestore();
  });

  it("remove <name> calls removeChannel", async () => {
    removeChannel.mockResolvedValue({ channelCount: 0 });
    const p = makeProgram(); registerAlertCommands(p, createClient);
    captureConsole();
    await p.parseAsync(["node", "ks", "--json", "alerts", "remove", "On-Call"]);
    expect(removeChannel).toHaveBeenCalledWith("On-Call");
  });

  it("test sends a test alert", async () => {
    test.mockResolvedValue({ channelsSent: 3 });
    const p = makeProgram(); registerAlertCommands(p, createClient);
    const out = captureConsole();
    await p.parseAsync(["node", "ks", "--json", "alerts", "test"]);
    expect(parseJson(out).channelsSent).toBe(3);
  });
});

// ── orgs ──────────────────────────────────────────────────────────────────
describe("ks orgs", () => {
  const list = vi.fn(), create = vi.fn(), switchOrg = vi.fn(), get = vi.fn(), del = vi.fn();
  const me = vi.fn(), members = vi.fn(), invite = vi.fn();
  const client: any = {
    orgs: { list, create, switch: switchOrg, get, delete: del },
    account: { me },
    teams: { members, invite },
  };
  const createClient: ClientFactory = () => client;

  it("list --json returns orgs + activeOrgId", async () => {
    list.mockResolvedValue({ orgs: [{ id: "o1" }], activeOrgId: "o1" });
    const p = makeProgram(); registerOrgCommands(p, createClient);
    const out = captureConsole();
    await p.parseAsync(["node", "ks", "--json", "orgs", "list"]);
    expect(parseJson(out).activeOrgId).toBe("o1");
  });

  it("create <name> calls orgs.create", async () => {
    create.mockResolvedValue({ id: "o2", name: "New", slug: "new", type: "organization" });
    const p = makeProgram(); registerOrgCommands(p, createClient);
    captureConsole();
    await p.parseAsync(["node", "ks", "--json", "orgs", "create", "New"]);
    expect(create).toHaveBeenCalledWith({ name: "New" });
  });

  it("switch <id> calls orgs.switch", async () => {
    switchOrg.mockResolvedValue({ switched: true });
    const p = makeProgram(); registerOrgCommands(p, createClient);
    const out = captureConsole();
    await p.parseAsync(["node", "ks", "--json", "orgs", "switch", "o2"]);
    expect(switchOrg).toHaveBeenCalledWith("o2");
    expect(parseJson(out)).toEqual({ switched: true, activeOrgId: "o2" });
  });

  it("info <id> calls orgs.get; info (no id) calls account.me", async () => {
    get.mockResolvedValue({ id: "o2" });
    me.mockResolvedValue({ name: "Me", tier: "pro" });
    let p = makeProgram(); registerOrgCommands(p, createClient);
    captureConsole();
    await p.parseAsync(["node", "ks", "--json", "orgs", "info", "o2"]);
    expect(get).toHaveBeenCalledWith("o2");

    p = makeProgram(); registerOrgCommands(p, createClient);
    captureConsole();
    await p.parseAsync(["node", "ks", "--json", "orgs", "info"]);
    expect(me).toHaveBeenCalled();
  });

  it("members lists team members", async () => {
    members.mockResolvedValue({ members: [{ email: "a@b.com", role: "owner" }], invitations: [] });
    const p = makeProgram(); registerOrgCommands(p, createClient);
    const out = captureConsole();
    await p.parseAsync(["node", "ks", "--json", "orgs", "members"]);
    expect(parseJson(out).members[0].email).toBe("a@b.com");
  });

  it("invite passes email + role", async () => {
    invite.mockResolvedValue({ acceptUrl: "https://x" });
    const p = makeProgram(); registerOrgCommands(p, createClient);
    captureConsole();
    await p.parseAsync(["node", "ks", "--json", "orgs", "invite", "x@y.com", "--role", "admin"]);
    expect(invite).toHaveBeenCalledWith({ email: "x@y.com", role: "admin" });
  });

  it("delete <id> proceeds in --json and calls orgs.delete", async () => {
    del.mockResolvedValue({ deleted: true });
    const p = makeProgram(); registerOrgCommands(p, createClient);
    const out = captureConsole();
    await p.parseAsync(["node", "ks", "--json", "orgs", "delete", "o2"]);
    expect(del).toHaveBeenCalledWith("o2");
    expect(parseJson(out)).toEqual({ deleted: true, orgId: "o2" });
  });
});

// ── providers ───────────────────────────────────────────────────────────────
describe("ks providers", () => {
  const list = vi.fn(), validate = vi.fn();
  const client: any = { providers: { list, validate } };
  const createClient: ClientFactory = () => client;

  it("list returns supported providers", async () => {
    list.mockResolvedValue([{ id: "cloudflare", name: "Cloudflare" }]);
    const p = makeProgram(); registerProviderCommands(p, createClient);
    const out = captureConsole();
    await p.parseAsync(["node", "ks", "--json", "providers", "list"]);
    expect(parseJson(out)[0].id).toBe("cloudflare");
  });

  it("validate builds credential and calls providers.validate", async () => {
    validate.mockResolvedValue({ valid: true });
    const p = makeProgram(); registerProviderCommands(p, createClient);
    captureConsole();
    await p.parseAsync([
      "node", "ks", "--json", "providers", "validate", "cloudflare",
      "--token", "tok", "--account-id", "acc",
    ]);
    expect(validate).toHaveBeenCalledWith("cloudflare", { apiToken: "tok", accountId: "acc" });
  });
});

// ── rules ───────────────────────────────────────────────────────────────────
describe("ks rules", () => {
  const list = vi.fn(), presets = vi.fn(), create = vi.fn(), del = vi.fn(), toggle = vi.fn();
  const client: any = { rules: { list, presets, create, delete: del, toggle } };
  const createClient: ClientFactory = () => client;

  it("list --trigger filters", async () => {
    list.mockResolvedValue([
      { id: "r1", trigger: "cost", enabled: true },
      { id: "r2", trigger: "security", enabled: true },
    ]);
    const p = makeProgram(); registerRuleCommands(p, createClient);
    const out = captureConsole();
    await p.parseAsync(["node", "ks", "--json", "rules", "list", "--trigger", "security"]);
    const parsed = parseJson(out);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].trigger).toBe("security");
  });

  it("presets lists templates", async () => {
    presets.mockResolvedValue([{ id: "cost-runaway", name: "Cost Runaway" }]);
    const p = makeProgram(); registerRuleCommands(p, createClient);
    const out = captureConsole();
    await p.parseAsync(["node", "ks", "--json", "rules", "presets"]);
    expect(parseJson(out)[0].id).toBe("cost-runaway");
  });

  it("create passes name + trigger", async () => {
    create.mockResolvedValue({ id: "r9" });
    const p = makeProgram(); registerRuleCommands(p, createClient);
    captureConsole();
    await p.parseAsync(["node", "ks", "--json", "rules", "create", "MyRule", "--trigger", "cost"]);
    expect(create).toHaveBeenCalledWith({ name: "MyRule", trigger: "cost" });
  });

  it("create --dry-run does NOT call the API", async () => {
    const p = makeProgram(); registerRuleCommands(p, createClient);
    const out = captureConsole();
    await p.parseAsync(["node", "ks", "--json", "rules", "create", "MyRule", "--trigger", "cost", "--dry-run"]);
    expect(create).not.toHaveBeenCalled();
    expect(parseJson(out)).toEqual({ dryRun: true, rule: { name: "MyRule", trigger: "cost" } });
  });

  it("toggle <id> calls rules.toggle", async () => {
    toggle.mockResolvedValue({ id: "r1", enabled: false });
    const p = makeProgram(); registerRuleCommands(p, createClient);
    captureConsole();
    await p.parseAsync(["node", "ks", "--json", "rules", "toggle", "r1"]);
    expect(toggle).toHaveBeenCalledWith("r1");
  });

  it("delete <id> proceeds in --json", async () => {
    del.mockResolvedValue({ deleted: true });
    const p = makeProgram(); registerRuleCommands(p, createClient);
    const out = captureConsole();
    await p.parseAsync(["node", "ks", "--json", "rules", "delete", "r1"]);
    expect(del).toHaveBeenCalledWith("r1");
    expect(parseJson(out)).toEqual({ deleted: true, id: "r1" });
  });
});

// ── activity ──────────────────────────────────────────────────────────────
describe("ks activity", () => {
  const listFn = vi.fn();
  const client: any = { activity: { list: listFn } };
  const createClient: ClientFactory = () => client;

  it("bare command fetches the last 10", async () => {
    listFn.mockResolvedValue({ entries: [], total: 0, page: 1, limit: 10 });
    const p = makeProgram(); registerActivityCommands(p, createClient);
    captureConsole();
    await p.parseAsync(["node", "ks", "--json", "activity"]);
    expect(listFn).toHaveBeenCalledWith({ limit: 10 });
  });

  it("list parses paging + filter options", async () => {
    listFn.mockResolvedValue({ entries: [], total: 0, page: 2, limit: 50 });
    const p = makeProgram(); registerActivityCommands(p, createClient);
    captureConsole();
    await p.parseAsync([
      "node", "ks", "--json", "activity", "list",
      "--page", "2", "--limit", "50", "--action", "rule", "--actor", "u_1",
    ]);
    expect(listFn).toHaveBeenCalledWith(expect.objectContaining({
      page: 2, limit: 50, action: "rule", actorUserId: "u_1",
    }));
  });
});

// ── kill ────────────────────────────────────────────────────────────────────
describe("ks kill", () => {
  const initiate = vi.fn(), get = vi.fn(), list = vi.fn(), advance = vi.fn(), abort = vi.fn();
  const client: any = { database: { initiate, get, list, advance, abort } };
  const createClient: ClientFactory = () => client;

  it("init passes credentialId + trigger", async () => {
    initiate.mockResolvedValue({ id: "k1", status: "initiated", steps: [] });
    const p = makeProgram(); registerKillCommands(p, createClient);
    captureConsole();
    await p.parseAsync(["node", "ks", "--json", "kill", "init", "--credential-id", "c1", "--trigger", "compromise"]);
    expect(initiate).toHaveBeenCalledWith({ credentialId: "c1", trigger: "compromise" });
  });

  it("status <id> gets one sequence; status alone lists", async () => {
    get.mockResolvedValue({ id: "k1", status: "active" });
    list.mockResolvedValue([{ id: "k1" }]);
    let p = makeProgram(); registerKillCommands(p, createClient);
    captureConsole();
    await p.parseAsync(["node", "ks", "--json", "kill", "status", "k1"]);
    expect(get).toHaveBeenCalledWith("k1");

    p = makeProgram(); registerKillCommands(p, createClient);
    captureConsole();
    await p.parseAsync(["node", "ks", "--json", "kill", "status"]);
    expect(list).toHaveBeenCalled();
  });

  it("advance passes credentialId + humanApproval flag", async () => {
    advance.mockResolvedValue({ status: "in-progress", currentStep: 1, steps: [{ action: "snapshot" }] });
    const p = makeProgram(); registerKillCommands(p, createClient);
    captureConsole();
    await p.parseAsync(["node", "ks", "--json", "kill", "advance", "k1", "--credential-id", "c1", "--human-approval"]);
    expect(advance).toHaveBeenCalledWith("k1", { credentialId: "c1", humanApproval: true });
  });

  it("abort <id> calls database.abort", async () => {
    abort.mockResolvedValue({ aborted: true });
    const p = makeProgram(); registerKillCommands(p, createClient);
    const out = captureConsole();
    await p.parseAsync(["node", "ks", "--json", "kill", "abort", "k1"]);
    expect(abort).toHaveBeenCalledWith("k1");
    expect(parseJson(out)).toEqual({ aborted: true, id: "k1" });
  });
});

// ── auth status / logout ─────────────────────────────────────────────────────
describe("ks auth (status/logout)", () => {
  const me = vi.fn();
  const client: any = { account: { me } };
  const createClient: ClientFactory = () => client;

  it("status reports not authenticated with no key", async () => {
    vi.mocked(resolveApiKey).mockReturnValue(undefined);
    const p = makeProgram(); registerAuthCommands(p, createClient);
    const out = captureConsole();
    await p.parseAsync(["node", "ks", "--json", "auth", "status"]);
    expect(parseJson(out)).toEqual({ authenticated: false });
    expect(me).not.toHaveBeenCalled();
  });

  it("status reports authenticated when key + account resolve", async () => {
    vi.mocked(resolveApiKey).mockReturnValue("ks_live_abc");
    me.mockResolvedValue({ name: "Acme", tier: "team" });
    const p = makeProgram(); registerAuthCommands(p, createClient);
    const out = captureConsole();
    await p.parseAsync(["node", "ks", "--json", "auth", "status"]);
    const parsed = parseJson(out);
    expect(parsed.authenticated).toBe(true);
    expect(parsed.tier).toBe("team");
  });

  it("status reports invalid when the key is present but account.me throws", async () => {
    vi.mocked(resolveApiKey).mockReturnValue("ks_live_bad");
    me.mockRejectedValue(new Error("401"));
    const p = makeProgram(); registerAuthCommands(p, createClient);
    const out = captureConsole();
    await p.parseAsync(["node", "ks", "--json", "auth", "status"]);
    expect(parseJson(out)).toMatchObject({ authenticated: false, keyPresent: true });
  });

  it("logout clears credentials via deleteConfig", async () => {
    const p = makeProgram(); registerAuthCommands(p, createClient);
    const out = captureConsole();
    await p.parseAsync(["node", "ks", "--json", "auth", "logout"]);
    expect(deleteConfig).toHaveBeenCalled();
    expect(parseJson(out)).toEqual({ loggedOut: true });
  });
});

// ── shield ──────────────────────────────────────────────────────────────────
describe("ks shield", () => {
  const presets = vi.fn(), applyPreset = vi.fn();
  const client: any = { rules: { presets, applyPreset } };
  const createClient: ClientFactory = () => client;

  it("with a preset applies it via rules.applyPreset", async () => {
    applyPreset.mockResolvedValue({ id: "r1", name: "Cost Runaway" });
    const p = makeProgram(); registerShieldCommands(p, createClient);
    const out = captureConsole();
    await p.parseAsync(["node", "ks", "--json", "shield", "cost-runaway"]);
    expect(applyPreset).toHaveBeenCalledWith("cost-runaway");
    expect(parseJson(out).id).toBe("r1");
  });

  it("--list lists presets without applying", async () => {
    presets.mockResolvedValue([{ id: "ddos", name: "DDoS" }]);
    const p = makeProgram(); registerShieldCommands(p, createClient);
    const out = captureConsole();
    await p.parseAsync(["node", "ks", "--json", "shield", "--list"]);
    expect(presets).toHaveBeenCalled();
    expect(applyPreset).not.toHaveBeenCalled();
    expect(parseJson(out)[0].id).toBe("ddos");
  });

  it("--dry-run previews without applying", async () => {
    presets.mockResolvedValue([{ id: "cost-runaway", name: "Cost Runaway", category: "Cost" }]);
    const p = makeProgram(); registerShieldCommands(p, createClient);
    const out = captureConsole();
    await p.parseAsync(["node", "ks", "--json", "shield", "cost-runaway", "--dry-run"]);
    expect(applyPreset).not.toHaveBeenCalled();
    expect(parseJson(out)).toMatchObject({ dryRun: true, preset: "cost-runaway" });
  });

  it("unknown preset exits with an error", async () => {
    const exit = vi.spyOn(process, "exit").mockImplementation(((c: number) => { throw new Error("exit:" + c); }) as never);
    const p = makeProgram(); registerShieldCommands(p, createClient);
    captureConsole();
    await expect(
      p.parseAsync(["node", "ks", "--json", "shield", "not-a-shield"]),
    ).rejects.toThrow("exit:1");
    expect(applyPreset).not.toHaveBeenCalled();
    exit.mockRestore();
  });
});

// ── onboard (non-interactive flag path) ──────────────────────────────────────
describe("ks onboard", () => {
  const create = vi.fn(), applyPreset = vi.fn(), channels = vi.fn(), updateChannels = vi.fn(), update = vi.fn();
  const client: any = {
    accounts: { create },
    rules: { applyPreset },
    alerts: { channels, updateChannels },
    account: { update },
  };
  const createClient: ClientFactory = () => client;

  beforeEach(() => {
    create.mockResolvedValue({ id: "a1", name: "Production" });
    applyPreset.mockResolvedValue({});
    channels.mockResolvedValue([]);
    updateChannels.mockResolvedValue({});
    update.mockResolvedValue({});
  });

  it("--help-provider prints credential help without touching the API", async () => {
    const p = makeProgram(); registerOnboardCommands(p, createClient);
    const out = captureConsole();
    await p.parseAsync(["node", "ks", "--json", "onboard", "--help-provider", "cloudflare"]);
    expect(create).not.toHaveBeenCalled();
    expect(parseJson(out).provider).toBe("cloudflare");
  });

  it("connects, applies each shield, and configures the alert channel", async () => {
    const p = makeProgram(); registerOnboardCommands(p, createClient);
    const out = captureConsole();
    await p.parseAsync([
      "node", "ks", "--json", "onboard",
      "--provider", "cloudflare", "--name", "Production",
      "--account-id", "acc", "--token", "tok",
      "--shields", "cost-runaway,ddos",
      "--alert-pagerduty", "RK",
    ]);

    expect(create).toHaveBeenCalledWith({
      provider: "cloudflare",
      name: "Production",
      credential: { provider: "cloudflare", accountId: "acc", apiToken: "tok" },
    });
    expect(applyPreset).toHaveBeenCalledTimes(2);
    expect(applyPreset).toHaveBeenCalledWith("cost-runaway");
    expect(applyPreset).toHaveBeenCalledWith("ddos");
    expect(updateChannels).toHaveBeenCalledWith([
      { type: "pagerduty", name: "PagerDuty", config: { routingKey: "RK" }, enabled: true },
    ]);
    expect(update).toHaveBeenCalledWith({ onboardingCompleted: true });
    expect(parseJson(out)).toMatchObject({ success: true, provider: "cloudflare", accountId: "a1" });
  });

  it("--skip-shields and --skip-alerts connect only", async () => {
    const p = makeProgram(); registerOnboardCommands(p, createClient);
    captureConsole();
    await p.parseAsync([
      "node", "ks", "--json", "onboard",
      "--provider", "cloudflare", "--name", "P", "--account-id", "acc", "--token", "tok",
      "--skip-shields", "--skip-alerts",
    ]);
    expect(create).toHaveBeenCalled();
    expect(applyPreset).not.toHaveBeenCalled();
    expect(updateChannels).not.toHaveBeenCalled();
  });

  it("requires --provider in JSON mode", async () => {
    const exit = vi.spyOn(process, "exit").mockImplementation(((c: number) => { throw new Error("exit:" + c); }) as never);
    const p = makeProgram(); registerOnboardCommands(p, createClient);
    captureConsole();
    await expect(
      p.parseAsync(["node", "ks", "--json", "onboard"]),
    ).rejects.toThrow("exit:1");
    expect(create).not.toHaveBeenCalled();
    exit.mockRestore();
  });
});

// ── config (key masking, H-2) ────────────────────────────────────────────────
describe("ks config (apiKey masking)", () => {
  const FULL = "ks_live_secret1234567890";
  beforeEach(() => {
    vi.mocked(loadConfig).mockReturnValue({ apiKey: FULL, apiUrl: "https://api.kill-switch.net" } as never);
  });

  it("list --json masks the apiKey by default", async () => {
    const p = makeProgram(); registerConfigCommands(p);
    const out = captureConsole();
    await p.parseAsync(["node", "ks", "--json", "config", "list"]);
    const parsed = parseJson(out);
    expect(parsed.apiKey).not.toBe(FULL);
    expect(parsed.apiKey).toContain("…");
    expect(parsed.apiUrl).toBe("https://api.kill-switch.net"); // non-secret untouched
  });

  it("list --json --reveal shows the full apiKey", async () => {
    const p = makeProgram(); registerConfigCommands(p);
    const out = captureConsole();
    await p.parseAsync(["node", "ks", "--json", "config", "list", "--reveal"]);
    expect(parseJson(out).apiKey).toBe(FULL);
  });

  it("get apiKey masks by default and reveals with --reveal", async () => {
    let p = makeProgram(); registerConfigCommands(p);
    let out = captureConsole();
    await p.parseAsync(["node", "ks", "--json", "config", "get", "apiKey"]);
    expect(parseJson(out).apiKey).toContain("…");

    p = makeProgram(); registerConfigCommands(p);
    out = captureConsole();
    await p.parseAsync(["node", "ks", "--json", "config", "get", "apiKey", "--reveal"]);
    expect(parseJson(out).apiKey).toBe(FULL);
  });

  it("get on a non-secret key is never masked", async () => {
    const p = makeProgram(); registerConfigCommands(p);
    const out = captureConsole();
    await p.parseAsync(["node", "ks", "--json", "config", "get", "apiUrl"]);
    expect(parseJson(out).apiUrl).toBe("https://api.kill-switch.net");
  });
});
