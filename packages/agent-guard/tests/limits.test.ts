import { describe, it, expect } from "vitest";
import {
  parseUtilization,
  parseReset,
  parseUnifiedHeaders,
  parseStatuslineRateLimits,
  recordHeaders,
  limitNotifyKey,
  unifiedHeaderDump,
} from "../src/limits.js";

/**
 * The `anthropic-ratelimit-unified-*` headers are owned by Anthropic and aren't
 * fully contract-documented, so the parser is deliberately format-tolerant.
 * Lock the tolerated shapes down here.
 */

describe("parseUtilization", () => {
  it("accepts a 0–1 fraction", () => {
    expect(parseUtilization("0.62")).toBeCloseTo(0.62);
  });
  it("treats values >1.5 as percentages", () => {
    expect(parseUtilization("62")).toBeCloseTo(0.62);
    expect(parseUtilization("62%")).toBeCloseTo(0.62);
    expect(parseUtilization("100")).toBeCloseTo(1);
  });
  it("clamps and rejects garbage", () => {
    expect(parseUtilization("150")).toBe(1);
    expect(parseUtilization("-5")).toBeNull();
    expect(parseUtilization("nope")).toBeNull();
    expect(parseUtilization(undefined)).toBeNull();
  });
});

describe("parseReset", () => {
  const now = 1_700_000_000_000; // fixed anchor (epoch ms)
  it("parses ISO 8601 timestamps", () => {
    expect(parseReset("2026-06-13T18:00:00Z", now)).toBe(Date.parse("2026-06-13T18:00:00Z"));
  });
  it("parses epoch seconds and epoch ms", () => {
    expect(parseReset("1700000600", now)).toBe(1_700_000_600_000);
    expect(parseReset("1700000600000", now)).toBe(1_700_000_600_000);
  });
  it("treats small numbers as relative seconds-until-reset", () => {
    expect(parseReset("300", now)).toBe(now + 300_000);
  });
  it("returns null for empty/garbage", () => {
    expect(parseReset("", now)).toBeNull();
    expect(parseReset("soon", now)).toBeNull();
    expect(parseReset(undefined, now)).toBeNull();
  });
});

describe("parseUnifiedHeaders", () => {
  const now = 1_700_000_000_000;

  it("reads both windows + overall status", () => {
    const h = recordHeaders({
      "anthropic-ratelimit-unified-status": "allowed",
      "anthropic-ratelimit-unified-5h-utilization": "0.34",
      "anthropic-ratelimit-unified-5h-reset": "1700001000",
      "anthropic-ratelimit-unified-7d-utilization": "58",
      "anthropic-ratelimit-unified-7d-reset": "2026-06-20T01:00:00Z",
      "anthropic-ratelimit-unified-7d-status": "warning",
    });
    const snap = parseUnifiedHeaders(h, now)!;
    expect(snap.status).toBe("allowed");
    expect(snap.fiveHour!.utilization).toBeCloseTo(0.34);
    expect(snap.fiveHour!.resetAt).toBe(1_700_001_000_000);
    expect(snap.weekly!.utilization).toBeCloseTo(0.58);
    expect(snap.weekly!.status).toBe("warning");
    expect(snap.observedAt).toBe(now);
  });

  it("returns null when no unified headers are present (stay in dollar mode)", () => {
    const h = recordHeaders({ "content-type": "application/json", "anthropic-ratelimit-requests-remaining": "10" });
    expect(parseUnifiedHeaders(h, now)).toBeNull();
  });

  it("is case-insensitive over header names", () => {
    const h = recordHeaders({ "ANTHROPIC-RateLimit-Unified-7d-Utilization": "0.9" });
    const snap = parseUnifiedHeaders(h, now)!;
    expect(snap.weekly!.utilization).toBeCloseTo(0.9);
  });
});

describe("unifiedHeaderDump (security: allowlist + truncation)", () => {
  it("captures only anthropic-ratelimit-unified-* headers — never credentials", () => {
    const dump = unifiedHeaderDump({
      authorization: "Bearer sk-ant-SECRET",
      "x-api-key": "sk-ant-SECRET2",
      cookie: "session=SECRET3",
      "anthropic-ratelimit-unified-status": "allowed",
      "anthropic-ratelimit-unified-7d-utilization": "0.62",
      "content-type": "text/event-stream",
    });
    expect(Object.keys(dump).sort()).toEqual([
      "anthropic-ratelimit-unified-7d-utilization",
      "anthropic-ratelimit-unified-status",
    ]);
    // No credential material leaks in, by key or by value.
    const serialized = JSON.stringify(dump);
    expect(serialized).not.toMatch(/SECRET|authorization|x-api-key|cookie/i);
  });

  it("truncates an over-long header value (hostile-upstream bloat)", () => {
    const dump = unifiedHeaderDump({ "anthropic-ratelimit-unified-status": "x".repeat(5000) });
    expect(dump["anthropic-ratelimit-unified-status"].length).toBeLessThan(300);
    expect(dump["anthropic-ratelimit-unified-status"]).toMatch(/truncated/);
  });
});

describe("limitNotifyKey", () => {
  it("re-keys per window+level+reset so a new window re-alerts", () => {
    expect(limitNotifyKey("weekly", "danger", 111)).toBe("weekly:danger:111");
    expect(limitNotifyKey("weekly", "danger", 222)).not.toBe(limitNotifyKey("weekly", "danger", 111));
  });
});

/**
 * Claude Code's statusLine stdin `rate_limits` — the documented, zero-network
 * source that replaced polling the (undocumented, rate-limited) usage endpoint.
 * Docs: used_percentage is 0–100; resets_at is Unix epoch SECONDS; the object is
 * absent for non-subscribers and before the session's first API response, and
 * each window may be independently absent.
 */
describe("parseStatuslineRateLimits — Claude Code statusLine stdin", () => {
  const now = 1_700_000_000_000;

  it("maps used_percentage (0–100) and epoch-SECONDS resets_at", () => {
    const resetSecs = Math.floor(now / 1000) + 3600; // 1h out, in seconds
    const s = parseStatuslineRateLimits(
      { rate_limits: { five_hour: { used_percentage: 50, resets_at: resetSecs }, seven_day: { used_percentage: 25, resets_at: resetSecs } } },
      now,
    )!;
    expect(s.fiveHour!.utilization).toBeCloseTo(0.5);
    expect(s.weekly!.utilization).toBeCloseTo(0.25);
    // Seconds must be scaled to ms — not read as a 1970 timestamp.
    expect(s.fiveHour!.resetAt).toBe(resetSecs * 1000);
    expect(s.status).toBe("statusline");
    expect(s.observedAt).toBe(now);
  });

  it("reads a 1% window as 0.01, not 1.0", () => {
    const s = parseStatuslineRateLimits({ rate_limits: { seven_day: { used_percentage: 1 } } }, now)!;
    expect(s.weekly!.utilization).toBeCloseTo(0.01);
  });

  it("handles each window being independently absent", () => {
    const s = parseStatuslineRateLimits({ rate_limits: { five_hour: { used_percentage: 12 } } }, now)!;
    expect(s.fiveHour!.utilization).toBeCloseTo(0.12);
    expect(s.weekly).toBeNull();
    expect(s.fiveHour!.resetAt).toBeNull(); // no resets_at given
  });

  it("returns null when rate_limits is missing → caller falls back to the endpoint", () => {
    // Non-subscriber, or before the first API response of a session.
    expect(parseStatuslineRateLimits({ model: { display_name: "Opus" } }, now)).toBeNull();
    expect(parseStatuslineRateLimits({ rate_limits: {} }, now)).toBeNull();
    expect(parseStatuslineRateLimits({}, now)).toBeNull();
    expect(parseStatuslineRateLimits(null, now)).toBeNull();
  });

  it("ignores malformed window values rather than inventing a number", () => {
    const s = parseStatuslineRateLimits(
      { rate_limits: { five_hour: { used_percentage: "nope" as any }, seven_day: { used_percentage: 30 } } },
      now,
    )!;
    expect(s.fiveHour).toBeNull();
    expect(s.weekly!.utilization).toBeCloseTo(0.3);
  });

  it("clamps out-of-range percentages into 0–1", () => {
    const s = parseStatuslineRateLimits({ rate_limits: { five_hour: { used_percentage: 140 }, seven_day: { used_percentage: -5 } } }, now)!;
    expect(s.fiveHour!.utilization).toBe(1);
    expect(s.weekly!.utilization).toBe(0);
  });
});
