/**
 * BIN reflects the bin the user actually invoked, so hints echo `ks` or
 * `kill-switch` to match (dogfood feedback C4 — hints used to always say
 * `kill-switch` even though the bin is `ks`).
 */
import { describe, it, expect, afterEach, vi } from "vitest";

const realArgv1 = process.argv[1];

afterEach(() => {
  process.argv[1] = realArgv1;
  vi.resetModules();
});

async function loadBin(argv1: string): Promise<string> {
  process.argv[1] = argv1;
  vi.resetModules();
  const mod = await import("../src/program-name.js");
  return mod.BIN;
}

describe("BIN program-name detection", () => {
  it("echoes kill-switch when invoked via the kill-switch bin", async () => {
    expect(await loadBin("/usr/local/bin/kill-switch")).toBe("kill-switch");
  });

  it("uses ks when invoked via the ks bin", async () => {
    expect(await loadBin("/usr/local/bin/ks")).toBe("ks");
  });

  it("defaults to ks for direct script invocation (node dist/index.js)", async () => {
    expect(await loadBin("/some/path/dist/index.js")).toBe("ks");
  });

  it("defaults to ks when argv[1] is missing", async () => {
    expect(await loadBin("")).toBe("ks");
  });
});
