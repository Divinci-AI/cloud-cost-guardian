/**
 * runDeviceFlow unit tests
 *
 * Verifies the start → poll → return-key loop:
 *   - /start failure → typed error (no polling)
 *   - happy path → returns api_key after first 200
 *   - 410 / 404 / unknown → typed error
 *   - times out cleanly at expires_in
 *   - polling_interval honored (and floored at 1s for server-bug safety)
 *   - spinner start/stop pairing under both success and failure
 *
 * All side-effect deps (fetch, sleep, openBrowser, hostname, log, spinner, now)
 * are injected via the deps parameter, so the test runs synchronously and
 * deterministically.
 */

import { describe, it, expect, vi } from "vitest";
import { runDeviceFlow, type DeviceFlowDeps } from "../src/device-flow.js";

function mkResp(status: number, body: any) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
    json: async () => body,
  } as any;
}

interface TestHarness {
  deps: DeviceFlowDeps;
  fetchMock: ReturnType<typeof vi.fn>;
  sleepCalls: number[];
  spinnerEvents: string[];
  logLines: string[];
  openedUrls: string[];
  setNow: (value: number) => void;
  advanceNow: (deltaMs: number) => void;
}

function makeHarness(): TestHarness {
  const fetchMock = vi.fn();
  const sleepCalls: number[] = [];
  const spinnerEvents: string[] = [];
  const logLines: string[] = [];
  const openedUrls: string[] = [];
  let nowVal = 1_000_000;

  // Mirror ora's real semantics: stop() on a never-started (or already
  // stopped) spinner is a no-op. Without this, the test treats every
  // defensive stop() in error paths as a separate event and assertions
  // count phantom stops.
  let spinnerStarted = false;

  const deps: DeviceFlowDeps = {
    fetch: fetchMock as any,
    sleep: async (ms) => { sleepCalls.push(ms); },
    openBrowser: (url) => { openedUrls.push(url); },
    hostname: () => "test-host",
    log: (line) => { logLines.push(line); },
    spinnerStart: (label) => {
      spinnerStarted = true;
      spinnerEvents.push(`start:${label}`);
    },
    spinnerStop: () => {
      if (spinnerStarted) {
        spinnerEvents.push("stop");
        spinnerStarted = false;
      }
    },
    now: () => nowVal,
  };

  return {
    deps,
    fetchMock,
    sleepCalls,
    spinnerEvents,
    logLines,
    openedUrls,
    setNow: (v) => { nowVal = v; },
    advanceNow: (delta) => { nowVal += delta; },
  };
}

describe("runDeviceFlow — /start failure", () => {
  it("throws with status when /start returns non-2xx (no polling)", async () => {
    const h = makeHarness();
    h.fetchMock.mockResolvedValueOnce(mkResp(500, "boom"));

    await expect(runDeviceFlow("https://api.test", "0.2.0", true, h.deps))
      .rejects.toThrow(/Failed to start CLI auth \(500\): boom/);

    expect(h.fetchMock).toHaveBeenCalledTimes(1);
    expect(h.fetchMock.mock.calls[0][0]).toBe("https://api.test/auth/cli/start");
    // No spinner because /start happens before the poll loop
    expect(h.spinnerEvents).toEqual([]);
    expect(h.openedUrls).toEqual([]);
  });
});

describe("runDeviceFlow — happy path", () => {
  it("returns the api_key after a 200 on the first poll", async () => {
    const h = makeHarness();
    h.fetchMock
      .mockResolvedValueOnce(mkResp(201, {
        code: "ABCD-1234",
        verification_url: "https://app.test/cli-auth?code=ABCD-1234",
        expires_in: 600,
        polling_interval: 2,
      }))
      .mockResolvedValueOnce(mkResp(200, { status: "approved", api_key: "ks_live_returned" }));

    const result = await runDeviceFlow("https://api.test", "0.2.0", false, h.deps);

    expect(result).toBe("ks_live_returned");
    // /start + one /poll
    expect(h.fetchMock).toHaveBeenCalledTimes(2);
    expect(h.fetchMock.mock.calls[1][0]).toBe("https://api.test/auth/cli/poll");
    // sleep called once at polling_interval (2 * 1000ms)
    expect(h.sleepCalls).toEqual([2000]);
    // Browser opened to the verification URL
    expect(h.openedUrls).toEqual(["https://app.test/cli-auth?code=ABCD-1234"]);
    // Spinner started exactly once and stopped exactly once on success
    expect(h.spinnerEvents).toEqual([
      "start:Waiting for browser authorization...",
      "stop",
    ]);
    // Verification code printed to user
    expect(h.logLines.some(l => l.includes("ABCD-1234"))).toBe(true);
  });

  it("loops on 202 pending until 200 approved", async () => {
    const h = makeHarness();
    h.fetchMock
      .mockResolvedValueOnce(mkResp(201, {
        code: "ABCD-1234",
        verification_url: "https://app.test/cli-auth?code=ABCD-1234",
        expires_in: 600,
        polling_interval: 2,
      }))
      .mockResolvedValueOnce(mkResp(202, { status: "pending" }))
      .mockResolvedValueOnce(mkResp(202, { status: "pending" }))
      .mockResolvedValueOnce(mkResp(200, { status: "approved", api_key: "ks_live_returned" }));

    const result = await runDeviceFlow("https://api.test", "0.2.0", true, h.deps);
    expect(result).toBe("ks_live_returned");
    // 3 polls (2 pending + 1 approved)
    expect(h.fetchMock).toHaveBeenCalledTimes(4);
    expect(h.sleepCalls).toEqual([2000, 2000, 2000]);
  });

  it("does NOT print user-facing lines or start spinner when json=true", async () => {
    const h = makeHarness();
    h.fetchMock
      .mockResolvedValueOnce(mkResp(201, { code: "X", verification_url: "u", expires_in: 600, polling_interval: 2 }))
      .mockResolvedValueOnce(mkResp(200, { status: "approved", api_key: "ks_live_x" }));

    await runDeviceFlow("https://api.test", "0.2.0", true, h.deps);
    expect(h.logLines).toEqual([]);
    expect(h.spinnerEvents).toEqual([]);
  });
});

describe("runDeviceFlow — terminal poll responses", () => {
  it("throws on 410 denied", async () => {
    const h = makeHarness();
    h.fetchMock
      .mockResolvedValueOnce(mkResp(201, { code: "X", verification_url: "u", expires_in: 600, polling_interval: 2 }))
      .mockResolvedValueOnce(mkResp(410, { status: "denied" }));

    await expect(runDeviceFlow("https://api.test", "0.2.0", false, h.deps))
      .rejects.toThrow(/CLI login denied/);

    expect(h.spinnerEvents).toEqual([
      "start:Waiting for browser authorization...",
      "stop",
    ]);
  });

  it("throws on 410 expired", async () => {
    const h = makeHarness();
    h.fetchMock
      .mockResolvedValueOnce(mkResp(201, { code: "X", verification_url: "u", expires_in: 600, polling_interval: 2 }))
      .mockResolvedValueOnce(mkResp(410, { status: "expired" }));

    await expect(runDeviceFlow("https://api.test", "0.2.0", false, h.deps))
      .rejects.toThrow(/CLI login expired/);
  });

  it("throws on 410 consumed", async () => {
    const h = makeHarness();
    h.fetchMock
      .mockResolvedValueOnce(mkResp(201, { code: "X", verification_url: "u", expires_in: 600, polling_interval: 2 }))
      .mockResolvedValueOnce(mkResp(410, { status: "consumed" }));

    await expect(runDeviceFlow("https://api.test", "0.2.0", false, h.deps))
      .rejects.toThrow(/CLI login consumed/);
  });

  it("throws on 404 (code already swept)", async () => {
    const h = makeHarness();
    h.fetchMock
      .mockResolvedValueOnce(mkResp(201, { code: "X", verification_url: "u", expires_in: 600, polling_interval: 2 }))
      .mockResolvedValueOnce(mkResp(404, { status: "unknown" }));

    await expect(runDeviceFlow("https://api.test", "0.2.0", false, h.deps))
      .rejects.toThrow(/expired before any response/);
  });
});

describe("runDeviceFlow — timeout", () => {
  it("throws after deadline (expires_in seconds elapsed) without ever getting 200", async () => {
    const h = makeHarness();
    h.fetchMock
      .mockResolvedValueOnce(mkResp(201, {
        code: "X",
        verification_url: "u",
        expires_in: 6,    // 6s for fast test
        polling_interval: 2,
      }))
      // Always pending; deadline advance comes from our sleep mock
      .mockResolvedValue(mkResp(202, { status: "pending" }));

    // Each `sleep` call inside the loop is observable — we'll advance our
    // mock clock past the deadline after a few iterations
    let calls = 0;
    h.deps.sleep = async (ms) => {
      calls++;
      h.advanceNow(ms);
      // Belt-and-suspenders: also bail if we somehow exceed 10 iterations
      if (calls > 10) throw new Error("test loop runaway");
    };

    await expect(runDeviceFlow("https://api.test", "0.2.0", true, h.deps))
      .rejects.toThrow(/timed out after 10 minutes/);

    // Should have polled at most a few times before hitting deadline
    expect(calls).toBeLessThanOrEqual(4);
  });
});

describe("runDeviceFlow — polling_interval safety", () => {
  it("floors polling_interval at 1s when the server returns 0 or negative", async () => {
    const h = makeHarness();
    h.fetchMock
      .mockResolvedValueOnce(mkResp(201, {
        code: "X", verification_url: "u", expires_in: 600,
        polling_interval: 0,  // server bug — would be a busy loop
      }))
      .mockResolvedValueOnce(mkResp(200, { status: "approved", api_key: "ks_live_x" }));

    await runDeviceFlow("https://api.test", "0.2.0", true, h.deps);
    // Math.max(1, 0) * 1000 = 1000
    expect(h.sleepCalls).toEqual([1000]);
  });
});
