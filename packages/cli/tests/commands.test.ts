/**
 * CLI Command Tests: check, analytics, status
 *
 * Each test creates a fresh Commander program, injects a mock SDK client,
 * invokes the command via parseAsync, and asserts on console output.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { Command } from "commander";
import { registerCheckCommands } from "../src/commands/check.js";
import { registerAnalyticsCommands } from "../src/commands/analytics.js";
import { registerStatusCommand } from "../src/commands/status.js";
import type { ClientFactory } from "../src/types.js";

// ── Helpers ─────────────────────────────────────────────────────────────────

function makeProgram() {
  return new Command()
    .name("ks")
    .option("--json", "JSON output")
    .option("--api-key <key>")
    .exitOverride(); // prevent process.exit in tests
}

function captureConsole() {
  const lines: string[] = [];
  const spy = vi.spyOn(console, "log").mockImplementation((...args) => {
    lines.push(args.join(" "));
  });
  vi.spyOn(console, "error").mockImplementation(() => {});
  return { lines, spy };
}

// ── check ────────────────────────────────────────────────────────────────────

describe("ks check", () => {
  const checkAllMock = vi.fn();
  const mockClient: any = { monitoring: { checkAll: checkAllMock } };
  const createClient: ClientFactory = () => mockClient;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("prints all-clear summary when no violations", async () => {
    checkAllMock.mockResolvedValue({
      results: [
        { cloudAccountId: "acc-1", provider: "cloudflare", name: "Prod", status: "ok", violations: [] },
      ],
    });
    const program = makeProgram();
    registerCheckCommands(program, createClient);
    const { lines } = captureConsole();
    await program.parseAsync(["node", "ks", "check"]);
    const output = lines.join("\n");
    expect(output).toContain("1");       // 1 account checked
    expect(output).toContain("all clear");
  });

  it("prints violation table with multiplier column", async () => {
    checkAllMock.mockResolvedValue({
      results: [
        {
          cloudAccountId: "acc-2",
          provider: "cloudflare",
          name: "Workers",
          status: "violation",
          violations: [
            {
              serviceName: "my-worker",
              metricName: "requests",
              currentValue: 120000,
              threshold: 2000,
              severity: "critical",
            },
          ],
          actionsTaken: ["killed"],
        },
      ],
    });
    const program = makeProgram();
    registerCheckCommands(program, createClient);
    const { lines } = captureConsole();
    await program.parseAsync(["node", "ks", "check"]);
    const output = lines.join("\n");
    expect(output).toContain("my-worker");
    expect(output).toContain("requests");
    expect(output).toContain("60x");          // 120000 / 2000
    expect(output).toContain("critical");
    expect(output).toContain("killed");       // actionsTaken
  });

  it("outputs raw JSON with --json flag", async () => {
    const data = { results: [{ cloudAccountId: "acc-3", status: "ok", violations: [] }] };
    checkAllMock.mockResolvedValue(data);
    const program = makeProgram();
    registerCheckCommands(program, createClient);
    const { lines } = captureConsole();
    await program.parseAsync(["node", "ks", "--json", "check"]);
    const parsed = JSON.parse(lines.join(""));
    expect(parsed.results[0].cloudAccountId).toBe("acc-3");
  });

  it("shows error status mark (✗) for violation accounts", async () => {
    checkAllMock.mockResolvedValue({
      results: [
        {
          cloudAccountId: "acc-4",
          provider: "aws",
          name: "Lambda",
          status: "violation",
          violations: [
            { serviceName: "fn", metricName: "cost", currentValue: 500, threshold: 10, severity: "high" },
          ],
        },
      ],
    });
    const program = makeProgram();
    registerCheckCommands(program, createClient);
    const { lines } = captureConsole();
    await program.parseAsync(["node", "ks", "check"]);
    const output = lines.join("\n");
    expect(output).toContain("✗");
    expect(output).toContain("50x");   // 500 / 10
  });

  it("shows warning mark (⚠) for error status accounts", async () => {
    checkAllMock.mockResolvedValue({
      results: [
        { cloudAccountId: "acc-5", provider: "gcp", name: "BigQuery", status: "error", violations: [] },
      ],
    });
    const program = makeProgram();
    registerCheckCommands(program, createClient);
    const { lines } = captureConsole();
    await program.parseAsync(["node", "ks", "check"]);
    const output = lines.join("\n");
    expect(output).toContain("⚠");
  });

  it("handles empty results gracefully", async () => {
    checkAllMock.mockResolvedValue({ results: [] });
    const program = makeProgram();
    registerCheckCommands(program, createClient);
    const { lines } = captureConsole();
    await program.parseAsync(["node", "ks", "check"]);
    const output = lines.join("\n");
    expect(output).toContain("0");
    expect(output).toContain("all clear");
  });

  it("multiplier is — when threshold is zero", async () => {
    checkAllMock.mockResolvedValue({
      results: [
        {
          cloudAccountId: "acc-6",
          provider: "cloudflare",
          name: "R2",
          status: "violation",
          violations: [
            { serviceName: "bucket", metricName: "ops", currentValue: 100, threshold: 0, severity: "low" },
          ],
        },
      ],
    });
    const program = makeProgram();
    registerCheckCommands(program, createClient);
    const { lines } = captureConsole();
    await program.parseAsync(["node", "ks", "check"]);
    const output = lines.join("\n");
    expect(output).toContain("—");
  });
});

// ── analytics ────────────────────────────────────────────────────────────────

describe("ks analytics", () => {
  const overviewMock = vi.fn();
  const mockClient: any = { analytics: { overview: overviewMock } };
  const createClient: ClientFactory = () => mockClient;

  const sampleOverview = {
    totalSpendPeriod: 123.45,
    avgDailyCost: 4.11,
    projectedMonthlyCost: 127.0,
    savingsEstimate: 38.2,
    killSwitchActions: 3,
    dailyCosts: [
      { date: "2026-03-30", cost: 3.5, services: 5, violations: 0 },
      { date: "2026-03-31", cost: 5.2, services: 6, violations: 1 },
      { date: "2026-04-01", cost: 4.0, services: 5, violations: 0 },
    ],
    accountBreakdown: [
      { cloudAccountId: "acc-1", provider: "cloudflare", totalCost: 80.0, avgDailyCost: 2.67 },
      { cloudAccountId: "acc-2", provider: "aws",        totalCost: 43.45, avgDailyCost: 1.44 },
    ],
  };

  beforeEach(() => {
    vi.clearAllMocks();
    overviewMock.mockResolvedValue(sampleOverview);
  });

  it("shows summary stats section", async () => {
    const program = makeProgram();
    registerAnalyticsCommands(program, createClient);
    const { lines } = captureConsole();
    await program.parseAsync(["node", "ks", "analytics"]);
    const output = lines.join("\n");
    expect(output).toContain("123.45");       // totalSpendPeriod
    expect(output).toContain("4.11");         // avgDailyCost
    expect(output).toContain("127.00");       // projectedMonthlyCost
    expect(output).toContain("38.20");        // savingsEstimate
    expect(output).toContain("3");            // killSwitchActions
  });

  it("shows last 7 days table with correct columns", async () => {
    const program = makeProgram();
    registerAnalyticsCommands(program, createClient);
    const { lines } = captureConsole();
    await program.parseAsync(["node", "ks", "analytics"]);
    const output = lines.join("\n");
    expect(output).toContain("Date");
    expect(output).toContain("Cost (USD)");
    expect(output).toContain("Services");
    expect(output).toContain("Violations");
    expect(output).toContain("2026-03-30");
    expect(output).toContain("3.5");
  });

  it("shows account breakdown table", async () => {
    const program = makeProgram();
    registerAnalyticsCommands(program, createClient);
    const { lines } = captureConsole();
    await program.parseAsync(["node", "ks", "analytics"]);
    const output = lines.join("\n");
    expect(output).toContain("cloudflare");
    expect(output).toContain("aws");
    expect(output).toContain("80");
  });

  it("outputs raw JSON with --json flag", async () => {
    const program = makeProgram();
    registerAnalyticsCommands(program, createClient);
    const { lines } = captureConsole();
    await program.parseAsync(["node", "ks", "--json", "analytics"]);
    const parsed = JSON.parse(lines.join(""));
    expect(parsed.totalSpendPeriod).toBe(123.45);
    expect(parsed.killSwitchActions).toBe(3);
  });

  it("handles missing optional fields gracefully (defaults to 0)", async () => {
    overviewMock.mockResolvedValue({ dailyCosts: [], accountBreakdown: [] });
    const program = makeProgram();
    registerAnalyticsCommands(program, createClient);
    const { lines } = captureConsole();
    await program.parseAsync(["node", "ks", "analytics"]);
    const output = lines.join("\n");
    expect(output).toContain("0.00");
  });
});

// ── status ───────────────────────────────────────────────────────────────────

describe("ks status", () => {
  const billingMock    = vi.fn();
  const accountsMock   = vi.fn();
  const rulesMock      = vi.fn();
  const databaseMock   = vi.fn();
  const channelsMock   = vi.fn();
  const overviewMock   = vi.fn();

  const mockClient: any = {
    billing:   { status: billingMock },
    accounts:  { list: accountsMock },
    rules:     { list: rulesMock },
    database:  { list: databaseMock },
    alerts:    { channels: channelsMock },
    analytics: { overview: overviewMock },
  };
  const createClient: ClientFactory = () => mockClient;

  beforeEach(() => {
    vi.clearAllMocks();
    billingMock.mockResolvedValue({ tier: "pro", limits: { cloudAccounts: 10 } });
    accountsMock.mockResolvedValue([
      { provider: "cloudflare", name: "Prod CF", status: "active", lastCheckStatus: "ok" },
      { provider: "aws",        name: "AWS Dev",  status: "active", lastCheckStatus: "ok" },
    ]);
    rulesMock.mockResolvedValue([
      { enabled: true, name: "cost-runaway" },
      { enabled: false, name: "old-rule" },
    ]);
    databaseMock.mockResolvedValue([]);
    channelsMock.mockResolvedValue([
      { type: "pagerduty", name: "On-Call", enabled: true, configPreview: "pd-key-***" },
    ]);
    overviewMock.mockResolvedValue({
      totalSpendPeriod: 55.0,
      savingsEstimate: 12.0,
      killSwitchActions: 2,
    });
  });

  it("shows plan, account count, rules summary", async () => {
    const program = makeProgram();
    registerStatusCommand(program, createClient);
    const { lines } = captureConsole();
    await program.parseAsync(["node", "ks", "status"]);
    const output = lines.join("\n");
    expect(output).toContain("pro");
    expect(output).toContain("2 active");
    expect(output).toContain("1 enabled");
  });

  it("shows alert channels inline summary", async () => {
    const program = makeProgram();
    registerStatusCommand(program, createClient);
    const { lines } = captureConsole();
    await program.parseAsync(["node", "ks", "status"]);
    const output = lines.join("\n");
    expect(output).toContain("pagerduty");
  });

  it("shows spend summary with savings and action count", async () => {
    const program = makeProgram();
    registerStatusCommand(program, createClient);
    const { lines } = captureConsole();
    await program.parseAsync(["node", "ks", "status"]);
    const output = lines.join("\n");
    expect(output).toContain("55.00");
    expect(output).toContain("12.00");
    expect(output).toContain("2");
  });

  it("shows connected accounts table with provider and name", async () => {
    const program = makeProgram();
    registerStatusCommand(program, createClient);
    const { lines } = captureConsole();
    await program.parseAsync(["node", "ks", "status"]);
    const output = lines.join("\n");
    expect(output).toContain("cloudflare");
    expect(output).toContain("Prod CF");
    expect(output).toContain("aws");
  });

  it("shows alert channels detail table", async () => {
    const program = makeProgram();
    registerStatusCommand(program, createClient);
    const { lines } = captureConsole();
    await program.parseAsync(["node", "ks", "status"]);
    const output = lines.join("\n");
    expect(output).toContain("On-Call");
    expect(output).toContain("pd-key-***");
  });

  it("shows setup hint when no channels configured", async () => {
    channelsMock.mockResolvedValue([]);
    const program = makeProgram();
    registerStatusCommand(program, createClient);
    const { lines } = captureConsole();
    await program.parseAsync(["node", "ks", "status"]);
    const output = lines.join("\n");
    expect(output).toContain("ks alerts add");
  });

  it("shows no-accounts hint when list is empty", async () => {
    accountsMock.mockResolvedValue([]);
    const program = makeProgram();
    registerStatusCommand(program, createClient);
    const { lines } = captureConsole();
    await program.parseAsync(["node", "ks", "status"]);
    const output = lines.join("\n");
    expect(output).toContain("ks onboard");
  });

  it("outputs JSON with tier, accounts, channels, spend", async () => {
    const program = makeProgram();
    registerStatusCommand(program, createClient);
    const { lines } = captureConsole();
    await program.parseAsync(["node", "ks", "--json", "status"]);
    const parsed = JSON.parse(lines.join(""));
    expect(parsed.tier).toBe("pro");
    expect(parsed.accounts).toBe(2);
    expect(parsed.alertChannels).toBe(1);
    expect(parsed.totalSpendPeriod).toBe(55.0);
    expect(parsed.killSwitchActions).toBe(2);
  });

  it("continues gracefully if analytics fetch fails", async () => {
    overviewMock.mockRejectedValue(new Error("Analytics unavailable"));
    const program = makeProgram();
    registerStatusCommand(program, createClient);
    const { lines } = captureConsole();
    // Should not throw
    await program.parseAsync(["node", "ks", "status"]);
    const output = lines.join("\n");
    // Still shows plan and accounts
    expect(output).toContain("pro");
    expect(output).toContain("2 active");
  });

  it("continues gracefully if alert channels fetch fails", async () => {
    channelsMock.mockRejectedValue(new Error("Alerts unavailable"));
    const program = makeProgram();
    registerStatusCommand(program, createClient);
    const { lines } = captureConsole();
    await program.parseAsync(["node", "ks", "status"]);
    const output = lines.join("\n");
    expect(output).toContain("pro");
  });

  it("highlights active kill sequences with warning", async () => {
    databaseMock.mockResolvedValue([{ name: "emergency-shutdown" }]);
    const program = makeProgram();
    registerStatusCommand(program, createClient);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { lines } = captureConsole();
    await program.parseAsync(["node", "ks", "status"]);
    // warn() OR console.log — either is fine, just check output contains "1"
    const allOutput = [...lines, ...warnSpy.mock.calls.map((c) => c.join(" "))].join("\n");
    expect(allOutput).toMatch(/1.*active|active.*1/);
    warnSpy.mockRestore();
  });
});
