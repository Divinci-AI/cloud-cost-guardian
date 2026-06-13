import { describe, it, expect } from "vitest";
import {
  parseUtilization,
  parseReset,
  parseUnifiedHeaders,
  recordHeaders,
  limitNotifyKey,
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

describe("limitNotifyKey", () => {
  it("re-keys per window+level+reset so a new window re-alerts", () => {
    expect(limitNotifyKey("weekly", "danger", 111)).toBe("weekly:danger:111");
    expect(limitNotifyKey("weekly", "danger", 222)).not.toBe(limitNotifyKey("weekly", "danger", 111));
  });
});
