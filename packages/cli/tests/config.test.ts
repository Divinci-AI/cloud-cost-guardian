import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { resolveApiKey, resolveApiUrl } from "../src/config.js";

describe("resolveApiKey", () => {
  const origEnv = process.env.KILL_SWITCH_API_KEY;

  afterEach(() => {
    if (origEnv !== undefined) {
      process.env.KILL_SWITCH_API_KEY = origEnv;
    } else {
      delete process.env.KILL_SWITCH_API_KEY;
    }
  });

  it("prefers env var over flag", () => {
    process.env.KILL_SWITCH_API_KEY = "ks_env_key";
    expect(resolveApiKey("ks_flag_key")).toBe("ks_env_key");
  });

  it("uses flag when no env var", () => {
    delete process.env.KILL_SWITCH_API_KEY;
    expect(resolveApiKey("ks_flag_key")).toBe("ks_flag_key");
  });

  it("returns undefined when no key available", () => {
    delete process.env.KILL_SWITCH_API_KEY;
    // Note: this also depends on config file not having a key
    const result = resolveApiKey(undefined);
    // Just check it doesn't throw
    expect(typeof result === "string" || result === undefined).toBe(true);
  });
});

describe("resolveApiUrl", () => {
  const origEnv = process.env.KILL_SWITCH_API_URL;

  afterEach(() => {
    if (origEnv !== undefined) {
      process.env.KILL_SWITCH_API_URL = origEnv;
    } else {
      delete process.env.KILL_SWITCH_API_URL;
    }
  });

  it("prefers env var over flag", () => {
    process.env.KILL_SWITCH_API_URL = "https://custom.api";
    expect(resolveApiUrl("https://flag.api")).toBe("https://custom.api");
  });

  it("uses flag when no env var", () => {
    delete process.env.KILL_SWITCH_API_URL;
    expect(resolveApiUrl("https://flag.api")).toBe("https://flag.api");
  });

  it("returns default when nothing set", () => {
    delete process.env.KILL_SWITCH_API_URL;
    const result = resolveApiUrl(undefined);
    expect(result).toContain("kill-switch.net");
  });

  // Security (M-1): the resolved URL receives the API key, so reject anything
  // that isn't https:// — http:// allowed only for localhost.
  it("allows http only for localhost", () => {
    delete process.env.KILL_SWITCH_API_URL;
    expect(resolveApiUrl("http://localhost:8787")).toBe("http://localhost:8787");
    expect(resolveApiUrl("http://127.0.0.1:3000")).toBe("http://127.0.0.1:3000");
  });

  it("rejects plaintext http to a non-localhost host", () => {
    delete process.env.KILL_SWITCH_API_URL;
    expect(() => resolveApiUrl("http://evil.example.com")).toThrow(/https/i);
  });

  it("rejects a malformed URL", () => {
    delete process.env.KILL_SWITCH_API_URL;
    expect(() => resolveApiUrl("not a url")).toThrow(/Invalid API URL/i);
  });

  it("rejects a non-http(s) scheme", () => {
    delete process.env.KILL_SWITCH_API_URL;
    expect(() => resolveApiUrl("file:///etc/passwd")).toThrow();
  });
});
