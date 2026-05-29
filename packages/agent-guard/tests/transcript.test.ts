import { describe, it, expect, afterEach } from "vitest";
import { writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parseTranscript } from "../src/transcript.js";

const path = join(tmpdir(), `agent-guard-transcript-${process.pid}.jsonl`);
afterEach(() => {
  try { rmSync(path); } catch { /* ignore */ }
});

describe("parseTranscript", () => {
  it("sums usage per model and tolerates junk lines", () => {
    const lines = [
      JSON.stringify({ type: "user", message: { role: "user" } }),
      "this is not json",
      JSON.stringify({
        message: {
          model: "claude-sonnet-4",
          usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 1000, cache_creation_input_tokens: 200 },
        },
      }),
      JSON.stringify({
        message: { model: "claude-sonnet-4", usage: { input_tokens: 10, output_tokens: 5 } },
      }),
      "",
    ];
    writeFileSync(path, lines.join("\n"));
    const { byModel } = parseTranscript(path);
    const u = byModel.get("claude-sonnet-4")!;
    expect(u.inputTokens).toBe(110);
    expect(u.outputTokens).toBe(55);
    expect(u.cacheReadTokens).toBe(1000);
    expect(u.cacheCreationTokens).toBe(200);
  });

  it("returns empty totals for a missing file", () => {
    const { byModel, lines } = parseTranscript("/no/such/file.jsonl");
    expect(byModel.size).toBe(0);
    expect(lines).toBe(0);
  });
});
