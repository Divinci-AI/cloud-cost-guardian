/**
 * CLI Auth route tests
 *
 * Asserts the wire-level contract for /auth/cli/{start,poll,approve,deny}:
 *   - /start (anon) returns the device-flow shape
 *   - /poll (anon) maps each consume state to the right HTTP status
 *   - /approve and /deny require Clerk JWT (or dev-bypass headers in tests)
 *
 * The schema module is mocked so we don't need a real Mongo — this is a
 * route-handler contract test, not an end-to-end check. The state-machine
 * itself is verified by tests/models/cli-auth.test.ts.
 */

import { describe, it, expect, vi, beforeEach, beforeAll } from "vitest";
import request from "supertest";

// CLERK_ISSUER must be set BEFORE app import (the middleware throws otherwise)
process.env.CLERK_ISSUER = process.env.CLERK_ISSUER || "https://test.clerk.example/.well-known";
process.env.GUARDIAN_DEV_AUTH_BYPASS = "true";
process.env.ENVIRONMENT = "local"; // dev-bypass gate

// Mock the schema BEFORE importing the app
const mockCreateCliCode = vi.fn();
const mockApproveCliCode = vi.fn();
const mockDenyCliCode = vi.fn();
const mockConsumeCliCode = vi.fn();

vi.mock("../../src/models/cli-auth/schema.js", () => ({
  createCliCode: (...args: any[]) => mockCreateCliCode(...args),
  approveCliCode: (...args: any[]) => mockApproveCliCode(...args),
  denyCliCode: (...args: any[]) => mockDenyCliCode(...args),
  consumeCliCode: (...args: any[]) => mockConsumeCliCode(...args),
}));

// Skip activity logging (touches Postgres in real runtime)
vi.mock("../../src/services/activity-logger.js", () => ({
  logActivity: vi.fn(),
}));

let app: any;

beforeAll(async () => {
  const { createApp } = await import("../../src/app.js");
  app = createApp();
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe("POST /auth/cli/start (anonymous)", () => {
  it("returns code + verification_url + expires_in + polling_interval", async () => {
    mockCreateCliCode.mockResolvedValue({
      code: "ABCD-1234",
      expiresAt: new Date(Date.now() + 600_000),
    });

    const res = await request(app)
      .post("/auth/cli/start")
      .send({ hostname: "test-laptop", cliVersion: "0.2.0" });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      code: "ABCD-1234",
      verification_url: expect.stringContaining("?code=ABCD-1234"),
      polling_interval: 2,
    });
    expect(res.body.expires_in).toBeGreaterThan(595);
    expect(res.body.expires_in).toBeLessThanOrEqual(600);
    expect(mockCreateCliCode).toHaveBeenCalledWith({
      hostname: "test-laptop",
      cliVersion: "0.2.0",
    });
  });

  it("works with no body (anonymous endpoint, all fields optional)", async () => {
    mockCreateCliCode.mockResolvedValue({
      code: "WXYZ-9876",
      expiresAt: new Date(Date.now() + 600_000),
    });
    const res = await request(app).post("/auth/cli/start").send({});
    expect(res.status).toBe(201);
    expect(res.body.code).toBe("WXYZ-9876");
  });
});

describe("POST /auth/cli/poll (anonymous)", () => {
  it("400 when code missing", async () => {
    const res = await request(app).post("/auth/cli/poll").send({});
    expect(res.status).toBe(400);
  });

  it("approved → 200 with api_key", async () => {
    mockConsumeCliCode.mockResolvedValue({ status: "approved", apiKey: "ks_live_real" });
    const res = await request(app).post("/auth/cli/poll").send({ code: "ABCD-1234" });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "approved", api_key: "ks_live_real" });
  });

  it("pending → 202", async () => {
    mockConsumeCliCode.mockResolvedValue({ status: "pending" });
    const res = await request(app).post("/auth/cli/poll").send({ code: "ABCD-1234" });
    expect(res.status).toBe(202);
    expect(res.body).toEqual({ status: "pending" });
  });

  it("denied → 410", async () => {
    mockConsumeCliCode.mockResolvedValue({ status: "denied" });
    const res = await request(app).post("/auth/cli/poll").send({ code: "ABCD-1234" });
    expect(res.status).toBe(410);
    expect(res.body).toEqual({ status: "denied" });
  });

  it("expired → 410", async () => {
    mockConsumeCliCode.mockResolvedValue({ status: "expired" });
    const res = await request(app).post("/auth/cli/poll").send({ code: "ABCD-1234" });
    expect(res.status).toBe(410);
    expect(res.body).toEqual({ status: "expired" });
  });

  it("consumed (second poll) → 410", async () => {
    mockConsumeCliCode.mockResolvedValue({ status: "consumed" });
    const res = await request(app).post("/auth/cli/poll").send({ code: "ABCD-1234" });
    expect(res.status).toBe(410);
    expect(res.body).toEqual({ status: "consumed" });
  });

  it("unknown code → 404", async () => {
    mockConsumeCliCode.mockResolvedValue({ status: "unknown" });
    const res = await request(app).post("/auth/cli/poll").send({ code: "ZZZZ-9999" });
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ status: "unknown" });
  });
});

describe("POST /auth/cli/approve", () => {
  it("401 without Authorization header", async () => {
    const res = await request(app).post("/auth/cli/approve").send({ code: "ABCD-1234" });
    expect(res.status).toBe(401);
  });

  it("400 with auth but missing code", async () => {
    const res = await request(app)
      .post("/auth/cli/approve")
      .set("Authorization", "Bearer dev-token")
      .set("x-guardian-account-id", "acct-1")
      .set("x-guardian-user-id", "user-1")
      .set("x-guardian-role", "owner")
      .send({});
    expect(res.status).toBe(400);
  });

  it("403 when the role can't manage api_keys (viewer)", async () => {
    const res = await request(app)
      .post("/auth/cli/approve")
      .set("Authorization", "Bearer dev-token")
      .set("x-guardian-account-id", "acct-1")
      .set("x-guardian-user-id", "user-1")
      .set("x-guardian-role", "viewer")
      .send({ code: "ABCD-1234" });
    expect(res.status).toBe(403);
  });

  it("200 on success — passes userId + accountId from the auth context", async () => {
    mockApproveCliCode.mockResolvedValue({ apiKeyId: "key-id-1" });
    const res = await request(app)
      .post("/auth/cli/approve")
      .set("Authorization", "Bearer dev-token")
      .set("x-guardian-account-id", "acct-1")
      .set("x-guardian-user-id", "user-1")
      .set("x-guardian-role", "owner")
      .send({ code: "ABCD-1234", keyName: "Test CLI" });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ approved: true });
    expect(mockApproveCliCode).toHaveBeenCalledWith(
      "ABCD-1234",
      "user-1",
      "acct-1",
      "Test CLI",
    );
  });

  it("maps approveCliCode error states to HTTP correctly", async () => {
    mockApproveCliCode.mockResolvedValueOnce({ error: "not_found" });
    const r1 = await request(app)
      .post("/auth/cli/approve")
      .set("Authorization", "Bearer dev-token")
      .set("x-guardian-account-id", "acct-1")
      .set("x-guardian-user-id", "user-1")
      .set("x-guardian-role", "owner")
      .send({ code: "MISS-CODE" });
    expect(r1.status).toBe(404);

    mockApproveCliCode.mockResolvedValueOnce({ error: "expired" });
    const r2 = await request(app)
      .post("/auth/cli/approve")
      .set("Authorization", "Bearer dev-token")
      .set("x-guardian-account-id", "acct-1")
      .set("x-guardian-user-id", "user-1")
      .set("x-guardian-role", "owner")
      .send({ code: "EXPI-RED1" });
    expect(r2.status).toBe(410);

    mockApproveCliCode.mockResolvedValueOnce({ error: "not_pending" });
    const r3 = await request(app)
      .post("/auth/cli/approve")
      .set("Authorization", "Bearer dev-token")
      .set("x-guardian-account-id", "acct-1")
      .set("x-guardian-user-id", "user-1")
      .set("x-guardian-role", "owner")
      .send({ code: "USED-CODE" });
    expect(r3.status).toBe(410);
  });
});

describe("POST /auth/cli/deny", () => {
  it("401 without Authorization header", async () => {
    const res = await request(app).post("/auth/cli/deny").send({ code: "ABCD-1234" });
    expect(res.status).toBe(401);
  });

  it("200 when denying a pending code", async () => {
    mockDenyCliCode.mockResolvedValue(true);
    const res = await request(app)
      .post("/auth/cli/deny")
      .set("Authorization", "Bearer dev-token")
      .set("x-guardian-account-id", "acct-1")
      .set("x-guardian-user-id", "user-1")
      .set("x-guardian-role", "owner")
      .send({ code: "ABCD-1234" });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ denied: true });
  });

  it("410 when the code is no longer pending", async () => {
    mockDenyCliCode.mockResolvedValue(false);
    const res = await request(app)
      .post("/auth/cli/deny")
      .set("Authorization", "Bearer dev-token")
      .set("x-guardian-account-id", "acct-1")
      .set("x-guardian-user-id", "user-1")
      .set("x-guardian-role", "owner")
      .send({ code: "USED-CODE" });
    expect(res.status).toBe(410);
  });
});
