/**
 * orgBanner formatting (dogfood feedback C1 — surface the active org so a
 * "missing" account that's really in another org is obvious).
 */
import { describe, it, expect } from "vitest";
import { orgBanner } from "../src/org-context.js";

describe("orgBanner", () => {
  it("returns empty string when context is unavailable", () => {
    expect(orgBanner(null)).toBe("");
  });

  it("shows the active org name + role for a single org, with no switch hint", () => {
    const out = orgBanner({ activeOrgId: "o1", activeOrgName: "divinci", activeRole: "owner", orgCount: 1 });
    expect(out).toContain("Org:");
    expect(out).toContain("divinci");
    expect(out).toContain("owner");
    expect(out).not.toContain("switch");
  });

  it("warns that accounts are scoped per org when the user has multiple orgs", () => {
    const out = orgBanner({ activeOrgId: "o1", activeOrgName: "divinci", activeRole: "admin", orgCount: 3 });
    expect(out).toContain("3 orgs");
    expect(out).toContain("scoped per org");
    expect(out).toContain("orgs switch");
  });

  it("falls back to the org id, then 'personal', when no name is present", () => {
    expect(orgBanner({ activeOrgId: "abc123", activeOrgName: null, activeRole: null, orgCount: 1 })).toContain("abc123");
    expect(orgBanner({ activeOrgId: null, activeOrgName: null, activeRole: null, orgCount: 1 })).toContain("personal");
  });
});
