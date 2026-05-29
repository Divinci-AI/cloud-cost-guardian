import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * isPaused/writePause/clearPause key off HOME (guardDir = ~/.kill-switch/agent-guard).
 * Point HOME at a temp dir so the test never touches the real sentinel.
 */
let home: string;
let mod: typeof import("../src/config.js");

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), "ag-pause-"));
  process.env.HOME = home;
  mod = await import("../src/config.js");
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

describe("pause escape hatch", () => {
  it("is not paused by default", () => {
    expect(mod.isPaused(Date.now())).toBe(false);
  });

  it("pauses indefinitely with an empty sentinel", () => {
    mod.writePause();
    expect(mod.isPaused(Date.now())).toBe(true);
    expect(mod.pauseExpiry()).toBeNull();
  });

  it("auto-expires a timed pause", () => {
    const now = 1_000_000_000_000;
    mod.writePause(now + 60_000);
    expect(mod.isPaused(now)).toBe(true);          // before expiry
    expect(mod.isPaused(now + 120_000)).toBe(false); // after expiry
    expect(mod.pauseExpiry()).toBe(now + 60_000);
  });

  it("resume clears the pause", () => {
    mod.writePause();
    expect(mod.isPaused(Date.now())).toBe(true);
    mod.clearPause();
    expect(mod.isPaused(Date.now())).toBe(false);
  });
});
