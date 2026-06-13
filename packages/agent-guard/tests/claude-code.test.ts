import { describe, it, expect } from "vitest";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mapRateLimitTier, detectPlanTier, tierLabel } from "../src/claude-code.js";

describe("mapRateLimitTier", () => {
  it("maps Claude Code tier strings to our tiers", () => {
    expect(mapRateLimitTier("default_claude_max_20x")).toBe("max20");
    expect(mapRateLimitTier("default_claude_max_5x")).toBe("max5");
    expect(mapRateLimitTier("default_claude_pro")).toBe("pro");
  });
  it("returns null for unknown / unmappable tiers", () => {
    expect(mapRateLimitTier("default_claude_free")).toBeNull();
    expect(mapRateLimitTier("enterprise_seat")).toBeNull();
    expect(mapRateLimitTier(null)).toBeNull();
    expect(mapRateLimitTier(undefined)).toBeNull();
  });
});

describe("detectPlanTier (reads ~/.claude.json)", () => {
  function writeClaudeJson(obj: object): string {
    const dir = mkdtempSync(join(tmpdir(), "ag-cc-"));
    const p = join(dir, ".claude.json");
    writeFileSync(p, JSON.stringify(obj));
    return p;
  }

  it("detects the org tier", () => {
    const p = writeClaudeJson({ oauthAccount: { organizationRateLimitTier: "default_claude_max_20x" } });
    expect(detectPlanTier(p)).toBe("max20");
  });

  it("prefers a per-user tier over the org tier", () => {
    const p = writeClaudeJson({
      oauthAccount: { userRateLimitTier: "default_claude_max_5x", organizationRateLimitTier: "default_claude_max_20x" },
    });
    expect(detectPlanTier(p)).toBe("max5");
  });

  it("returns null on a missing file or absent account (never throws)", () => {
    expect(detectPlanTier("/no/such/.claude.json")).toBeNull();
    const p = writeClaudeJson({ somethingElse: true });
    expect(detectPlanTier(p)).toBeNull();
  });
});

describe("tierLabel", () => {
  it("renders human labels", () => {
    expect(tierLabel("max20")).toBe("Max 20x");
    expect(tierLabel("max5")).toBe("Max 5x");
    expect(tierLabel("pro")).toBe("Pro");
  });
});
