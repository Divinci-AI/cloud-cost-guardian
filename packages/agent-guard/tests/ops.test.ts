import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installHook, setBudget, resetLedger } from "../src/ops.js";
import { configPath } from "../src/config.js";
import { loadLedger, saveLedger, emptyLedger, setSessionCost } from "../src/ledger.js";

let prevHome: string | undefined;
let home: string;

beforeEach(() => {
  prevHome = process.env.HOME;
  home = mkdtempSync(join(tmpdir(), "ag-ops-"));
  process.env.HOME = home; // guardDir()/configPath() read homedir() at call time
});
afterEach(() => {
  if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
});

describe("installHook", () => {
  it("wires PreToolUse, UserPromptSubmit, and Stop into a project settings.json", () => {
    const cwd = mkdtempSync(join(tmpdir(), "ag-proj-"));
    const result = installHook("/x/cli.js", "/usr/bin/node", { cwd, command: '"node" "agent-guard" hook' });

    expect(result.added.sort()).toEqual(["PreToolUse", "Stop", "UserPromptSubmit"].sort());
    expect(result.settingsPath).toBe(join(cwd, ".claude", "settings.json"));

    const settings = JSON.parse(readFileSync(result.settingsPath, "utf8"));
    expect(Object.keys(settings.hooks).sort()).toEqual(["PreToolUse", "Stop", "UserPromptSubmit"].sort());
    // PreToolUse uses a "*" matcher; the others don't
    expect(settings.hooks.PreToolUse[0].matcher).toBe("*");
    expect(settings.hooks.UserPromptSubmit[0].matcher).toBeUndefined();
    expect(settings.hooks.PreToolUse[0].hooks[0].command).toContain("agent-guard");
  });

  it("is idempotent — re-running adds nothing", () => {
    const cwd = mkdtempSync(join(tmpdir(), "ag-proj-"));
    installHook("/x/cli.js", "/usr/bin/node", { cwd });
    const second = installHook("/x/cli.js", "/usr/bin/node", { cwd });
    expect(second.added).toEqual([]);
  });
});

describe("setBudget", () => {
  it("merges caps onto defaults and persists them to the config file", () => {
    const budget = setBudget({ sessionHardUSD: 30, dailyHardUSD: 150 });
    expect(budget.sessionHardUSD).toBe(30);
    expect(budget.dailyHardUSD).toBe(150);

    const onDisk = JSON.parse(readFileSync(configPath(), "utf8"));
    expect(onDisk.budget.sessionHardUSD).toBe(30);
    expect(onDisk.budget.dailyHardUSD).toBe(150);
  });

  it("ignores non-finite values and saves the slack webhook", () => {
    const budget = setBudget({ sessionHardUSD: Number.NaN, slackWebhook: "https://hooks.slack.com/x" });
    expect(Number.isFinite(budget.sessionHardUSD)).toBe(true); // untouched default, not NaN
    const onDisk = JSON.parse(readFileSync(configPath(), "utf8"));
    expect(onDisk.slackWebhook).toBe("https://hooks.slack.com/x");
  });
});

describe("resetLedger", () => {
  function seed() {
    const led = emptyLedger();
    setSessionCost(led, "s-old", 2, 10, 5, Date.now() - 10 * 24 * 60 * 60 * 1000); // 10 days ago (still within prune window)
    setSessionCost(led, "s-today", 3, 10, 5, Date.now());
    saveLedger(led);
  }

  it("all wipes the entire ledger", () => {
    seed();
    const msg = resetLedger({ all: true });
    expect(msg).toMatch(/wiped/i);
    expect(Object.keys(loadLedger().sessions)).toEqual([]);
  });

  it("session <id> clears just that session", () => {
    seed();
    resetLedger({ session: "s-old" });
    const sessions = loadLedger().sessions;
    expect(sessions["s-old"]).toBeUndefined();
    expect(sessions["s-today"]).toBeDefined();
  });

  it("today clears only sessions last active today", () => {
    seed();
    resetLedger({ today: true });
    const sessions = loadLedger().sessions;
    expect(sessions["s-today"]).toBeUndefined();
    expect(sessions["s-old"]).toBeDefined();
  });

  it("with no scope returns guidance and changes nothing", () => {
    seed();
    const msg = resetLedger({});
    expect(msg).toMatch(/specify/i);
    expect(Object.keys(loadLedger().sessions).sort()).toEqual(["s-old", "s-today"]);
  });
});
