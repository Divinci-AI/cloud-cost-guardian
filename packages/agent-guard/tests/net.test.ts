import { describe, it, expect } from "vitest";
import { isSafeEndpoint, assertSafeEndpoint } from "../src/net.js";

/**
 * Security (M-1): credential-bearing endpoints (proxy upstream, alert apiUrl)
 * must be https:// — http:// only for loopback. A poisoned config must not be
 * able to redirect the API key over an insecure or non-TLS channel.
 */
describe("isSafeEndpoint", () => {
  it("accepts https hosts", () => {
    expect(isSafeEndpoint("https://api.anthropic.com")).toBe(true);
    expect(isSafeEndpoint("https://attacker.example.com")).toBe(true); // host allowlist is out of scope; scheme is enforced
  });

  it("accepts http only for localhost", () => {
    expect(isSafeEndpoint("http://localhost:8787")).toBe(true);
    expect(isSafeEndpoint("http://127.0.0.1:9999")).toBe(true);
  });

  it("rejects plaintext http to non-loopback hosts", () => {
    expect(isSafeEndpoint("http://api.anthropic.com")).toBe(false);
    expect(isSafeEndpoint("http://evil.example.com")).toBe(false);
  });

  it("rejects non-http(s) and malformed schemes", () => {
    expect(isSafeEndpoint("file:///etc/passwd")).toBe(false);
    expect(isSafeEndpoint("javascript:alert(1)")).toBe(false);
    expect(isSafeEndpoint("not a url")).toBe(false);
    expect(isSafeEndpoint("")).toBe(false);
  });
});

describe("assertSafeEndpoint", () => {
  it("returns the url when safe", () => {
    expect(assertSafeEndpoint("https://api.openai.com", "upstream")).toBe("https://api.openai.com");
  });

  it("throws with a clear message when unsafe", () => {
    expect(() => assertSafeEndpoint("http://evil.example.com", "upstream")).toThrow(/upstream/);
  });
});
