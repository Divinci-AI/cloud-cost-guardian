import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dispatchAlert, type AlertEvent } from "../src/alert.js";
import { DEFAULT_BUDGET, type GuardConfig } from "../src/config.js";

const evt: AlertEvent = {
  ts: 1_700_000_000_000,
  source: "proxy",
  sessionId: "sess_1",
  level: "block",
  sessionUSD: 31.5,
  dailyUSD: 152.0,
  reasons: ["session hard cap exceeded"],
  action: "deny",
  cwd: "/home/dev/project",
};

const baseCfg: GuardConfig = { budget: DEFAULT_BUDGET };

let prevHome: string | undefined;
let fetchSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
  // Redirect the local events.jsonl write into a throwaway dir.
  prevHome = process.env.HOME;
  process.env.HOME = mkdtempSync(join(tmpdir(), "ag-alert-"));
  fetchSpy = vi.fn().mockResolvedValue({ ok: true, status: 200, text: () => Promise.resolve("") });
  vi.stubGlobal("fetch", fetchSpy);
});

afterEach(() => {
  vi.unstubAllGlobals();
  if (prevHome === undefined) delete process.env.HOME;
  else process.env.HOME = prevHome;
});

describe("dispatchAlert", () => {
  it("posts only spend metadata to Slack — no API key, no prompt content", async () => {
    await dispatchAlert({ ...baseCfg, slackWebhook: "https://hooks.slack.com/services/T/B/X" }, evt);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe("https://hooks.slack.com/services/T/B/X");
    const payload = JSON.stringify(JSON.parse(init.body));
    expect(payload).toContain("$31.50");
    expect(payload).not.toMatch(/ks_live|authorization/i);
  });

  it("reports to the Guardian API with the key only when apiUrl is safe", async () => {
    await dispatchAlert({ ...baseCfg, apiKey: "ks_live_secret", apiUrl: "https://api.kill-switch.net" }, evt);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe("https://api.kill-switch.net/agent-guard/events");
    expect(init.headers.authorization).toBe("Bearer ks_live_secret");
    // body carries only the fixed AlertEvent fields — never prompts/transcripts
    expect(Object.keys(JSON.parse(init.body)).sort()).toEqual(
      ["action", "cwd", "dailyUSD", "level", "reasons", "sessionId", "sessionUSD", "source", "ts"],
    );
  });

  it("does NOT send the API key when apiUrl is an unsafe (non-https) host (M-1)", async () => {
    await dispatchAlert({ ...baseCfg, apiKey: "ks_live_secret", apiUrl: "http://evil.example.com" }, evt);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
