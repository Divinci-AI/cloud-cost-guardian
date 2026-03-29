/**
 * Permissions Middleware Tests
 *
 * Tests the RBAC permission matrix for all roles and permissions.
 */

import { describe, it, expect, vi } from "vitest";
import { requirePermission } from "../../src/middleware/permissions.js";

// Helper to create mock req/res/next
function createMocks(role?: string) {
  const req: any = { teamRole: role, guardianAccountId: "test-account", userId: "test-user" };
  const res: any = {
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
  };
  const next = vi.fn();
  return { req, res, next };
}

describe("Permissions Middleware", () => {
  describe("requirePermission", () => {
    it("returns 500 for unknown permission", () => {
      const { req, res, next } = createMocks("owner");
      requirePermission("nonexistent:permission")(req, res, next);
      expect(res.status).toHaveBeenCalledWith(500);
      expect(next).not.toHaveBeenCalled();
    });

    it("returns 403 when no role is set", () => {
      const { req, res, next } = createMocks(undefined);
      requirePermission("cloud_accounts:read")(req, res, next);
      expect(res.status).toHaveBeenCalledWith(403);
      expect(next).not.toHaveBeenCalled();
    });
  });

  describe("owner role — full access", () => {
    const permissions = [
      "cloud_accounts:read", "cloud_accounts:write", "cloud_accounts:delete",
      "rules:read", "rules:write", "rules:delete",
      "kill_switch:trigger", "kill_switch:read",
      "alerts:read", "alerts:write",
      "team:read", "team:manage",
      "settings:read", "settings:write",
      "billing:read", "billing:manage",
      "api_keys:manage",
      "org:manage", "org:delete",
      "activity:read",
      "check:trigger",
    ];

    for (const perm of permissions) {
      it(`allows ${perm}`, () => {
        const { req, res, next } = createMocks("owner");
        requirePermission(perm)(req, res, next);
        expect(next).toHaveBeenCalled();
        expect(res.status).not.toHaveBeenCalled();
      });
    }
  });

  describe("admin role", () => {
    const allowed = [
      "cloud_accounts:read", "cloud_accounts:write", "cloud_accounts:delete",
      "rules:read", "rules:write", "rules:delete",
      "kill_switch:trigger", "kill_switch:read",
      "alerts:read", "alerts:write",
      "team:read", "team:manage",
      "settings:read", "settings:write",
      "billing:read",
      "api_keys:manage",
      "activity:read",
      "check:trigger",
    ];
    const denied = ["billing:manage", "org:manage", "org:delete"];

    for (const perm of allowed) {
      it(`allows ${perm}`, () => {
        const { req, res, next } = createMocks("admin");
        requirePermission(perm)(req, res, next);
        expect(next).toHaveBeenCalled();
      });
    }

    for (const perm of denied) {
      it(`denies ${perm}`, () => {
        const { req, res, next } = createMocks("admin");
        requirePermission(perm)(req, res, next);
        expect(res.status).toHaveBeenCalledWith(403);
        expect(next).not.toHaveBeenCalled();
      });
    }
  });

  describe("member role", () => {
    const allowed = [
      "cloud_accounts:read", "cloud_accounts:write", "cloud_accounts:delete",
      "rules:read", "rules:write", "rules:delete",
      "kill_switch:trigger", "kill_switch:read",
      "alerts:read",
      "team:read",
      "settings:read",
      "billing:read",
      "api_keys:manage",
      "check:trigger",
    ];
    const denied = [
      "alerts:write", "team:manage", "settings:write",
      "billing:manage", "org:manage", "org:delete", "activity:read",
    ];

    for (const perm of allowed) {
      it(`allows ${perm}`, () => {
        const { req, res, next } = createMocks("member");
        requirePermission(perm)(req, res, next);
        expect(next).toHaveBeenCalled();
      });
    }

    for (const perm of denied) {
      it(`denies ${perm}`, () => {
        const { req, res, next } = createMocks("member");
        requirePermission(perm)(req, res, next);
        expect(res.status).toHaveBeenCalledWith(403);
        expect(next).not.toHaveBeenCalled();
      });
    }
  });

  describe("viewer role — read-only", () => {
    const allowed = [
      "cloud_accounts:read", "rules:read", "kill_switch:read",
      "alerts:read", "team:read", "settings:read", "billing:read",
    ];
    const denied = [
      "cloud_accounts:write", "cloud_accounts:delete",
      "rules:write", "rules:delete",
      "kill_switch:trigger",
      "alerts:write",
      "team:manage",
      "settings:write",
      "billing:manage",
      "api_keys:manage",
      "org:manage", "org:delete",
      "activity:read",
      "check:trigger",
    ];

    for (const perm of allowed) {
      it(`allows ${perm}`, () => {
        const { req, res, next } = createMocks("viewer");
        requirePermission(perm)(req, res, next);
        expect(next).toHaveBeenCalled();
      });
    }

    for (const perm of denied) {
      it(`denies ${perm}`, () => {
        const { req, res, next } = createMocks("viewer");
        requirePermission(perm)(req, res, next);
        expect(res.status).toHaveBeenCalledWith(403);
        expect(next).not.toHaveBeenCalled();
      });
    }
  });
});
