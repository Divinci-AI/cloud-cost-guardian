/**
 * requireTier middleware tests
 *
 * Validates the audit H1 fix: tier-gated features (e.g. the Activity Log) must be
 * enforced server-side, not just in the UI. Tier is read from the DB account record.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const { findById } = vi.hoisted(() => ({ findById: vi.fn() }));
vi.mock("../../src/models/guardian-account/schema.js", () => ({
  GuardianAccountModel: { findById },
}));

import { requireTier } from "../../src/middleware/tier.js";

function mocks() {
  const req: any = { guardianAccountId: "acct-1" };
  const res: any = { status: vi.fn().mockReturnThis(), json: vi.fn().mockReturnThis() };
  const next = vi.fn();
  return { req, res, next };
}

describe("requireTier", () => {
  beforeEach(() => findById.mockReset());

  it("allows an account on an allowed tier and attaches it", async () => {
    findById.mockResolvedValue({ tier: "team" });
    const { req, res, next } = mocks();
    await requireTier("team", "enterprise")(req, res, next);
    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
    expect(req.guardianAccount).toEqual({ tier: "team" });
  });

  it("allows enterprise when team/enterprise is required", async () => {
    findById.mockResolvedValue({ tier: "enterprise" });
    const { req, res, next } = mocks();
    await requireTier("team", "enterprise")(req, res, next);
    expect(next).toHaveBeenCalled();
  });

  it("403s a free account (closes the Activity-log bypass)", async () => {
    findById.mockResolvedValue({ tier: "free" });
    const { req, res, next } = mocks();
    await requireTier("team", "enterprise")(req, res, next);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });

  it("403s a pro account for team-only features", async () => {
    findById.mockResolvedValue({ tier: "pro" });
    const { req, res, next } = mocks();
    await requireTier("team", "enterprise")(req, res, next);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });

  it("404s when the account is missing", async () => {
    findById.mockResolvedValue(null);
    const { req, res, next } = mocks();
    await requireTier("team")(req, res, next);
    expect(res.status).toHaveBeenCalledWith(404);
    expect(next).not.toHaveBeenCalled();
  });
});
