import { describe, it, expect } from "vitest";
import { parseJsonUsage, parseStreamUsage } from "../src/proxy.js";

/**
 * The proxy meters real spend by parsing usage out of upstream responses. These
 * formats are owned by Anthropic/OpenAI, not us — so they're the highest
 * bug-risk surface in the package (the same class as the /v1 contract bug).
 * Lock the shapes down.
 */

describe("parseJsonUsage (non-streaming)", () => {
  it("parses an Anthropic Messages response incl. cache buckets", () => {
    const body = JSON.stringify({
      model: "claude-sonnet-4-20250101",
      usage: {
        input_tokens: 100,
        output_tokens: 250,
        cache_creation_input_tokens: 2000,
        cache_read_input_tokens: 8000,
      },
    });
    const r = parseJsonUsage("anthropic", body)!;
    expect(r.model).toBe("claude-sonnet-4-20250101");
    expect(r.usage).toEqual({
      inputTokens: 100,
      outputTokens: 250,
      cacheCreationTokens: 2000,
      cacheReadTokens: 8000,
    });
  });

  it("parses an OpenAI chat completion response", () => {
    const body = JSON.stringify({
      model: "gpt-4o",
      usage: { prompt_tokens: 500, completion_tokens: 120 },
    });
    const r = parseJsonUsage("openai", body)!;
    expect(r.model).toBe("gpt-4o");
    expect(r.usage.inputTokens).toBe(500);
    expect(r.usage.outputTokens).toBe(120);
  });

  it("returns null for a body without usage, and for malformed JSON", () => {
    expect(parseJsonUsage("anthropic", JSON.stringify({ model: "x" }))).toBeNull();
    expect(parseJsonUsage("anthropic", "not json{")).toBeNull();
    expect(parseJsonUsage("openai", "")).toBeNull();
  });

  it("defaults missing token fields to 0, not NaN", () => {
    const r = parseJsonUsage("anthropic", JSON.stringify({ usage: { input_tokens: 10 } }))!;
    expect(r.usage.outputTokens).toBe(0);
    expect(r.usage.cacheReadTokens).toBe(0);
    expect(r.model).toBe("unknown");
  });
});

describe("parseStreamUsage (SSE)", () => {
  it("accumulates Anthropic message_start (input/cache) + message_delta (output)", () => {
    // Real Anthropic streaming: input+cache land on message_start, output on message_delta.
    const sse = [
      `event: message_start`,
      `data: ${JSON.stringify({ type: "message_start", message: { model: "claude-opus-4", usage: { input_tokens: 40, cache_read_input_tokens: 5000, cache_creation_input_tokens: 100 } } })}`,
      ``,
      `event: content_block_delta`,
      `data: ${JSON.stringify({ type: "content_block_delta", delta: { text: "hi" } })}`,
      ``,
      `event: message_delta`,
      `data: ${JSON.stringify({ type: "message_delta", usage: { output_tokens: 300 } })}`,
      ``,
      `data: [DONE]`,
    ].join("\n");

    const r = parseStreamUsage("anthropic", sse)!;
    expect(r.model).toBe("claude-opus-4");
    expect(r.usage.inputTokens).toBe(40);
    expect(r.usage.cacheReadTokens).toBe(5000);
    expect(r.usage.cacheCreationTokens).toBe(100);
    expect(r.usage.outputTokens).toBe(300);
  });

  it("parses OpenAI streaming usage from the final chunk", () => {
    const sse = [
      `data: ${JSON.stringify({ model: "gpt-4o", choices: [{ delta: { content: "h" } }] })}`,
      `data: ${JSON.stringify({ model: "gpt-4o", usage: { prompt_tokens: 80, completion_tokens: 22 } })}`,
      `data: [DONE]`,
    ].join("\n");

    const r = parseStreamUsage("openai", sse)!;
    expect(r.model).toBe("gpt-4o");
    expect(r.usage.inputTokens).toBe(80);
    expect(r.usage.outputTokens).toBe(22);
  });

  it("tolerates malformed data lines and returns null when no usage seen", () => {
    const sse = [
      `data: not-json{`,
      `event: ping`,
      `data: ${JSON.stringify({ type: "content_block_delta", delta: { text: "x" } })}`,
    ].join("\n");
    expect(parseStreamUsage("anthropic", sse)).toBeNull();
  });

  it("returns null for empty SSE", () => {
    expect(parseStreamUsage("anthropic", "")).toBeNull();
    expect(parseStreamUsage("openai", "")).toBeNull();
  });
});
