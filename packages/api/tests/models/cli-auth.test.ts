/**
 * CLI Auth schema unit tests
 *
 * Locks in the device-flow state machine. The mongoose Model methods are
 * mocked via vi.spyOn — we're testing OUR helper logic, not Mongo's. The
 * critical invariants:
 *   - createCliCode generates well-formed codes in the expected alphabet
 *   - approveCliCode rejects expired / non-pending codes and mints exactly
 *     one API key on success
 *   - consumeCliCode is one-shot (atomic findOneAndUpdate semantics) and
 *     transitions cleanly between pending / approved / consumed / denied /
 *     expired / unknown
 *   - On approve, the plaintext key is $unset by the same atomic operation
 *     that sets polledOnceAt (no two-step race window)
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  CliAuthCodeModel,
  createCliCode,
  approveCliCode,
  denyCliCode,
  consumeCliCode,
} from "../../src/models/cli-auth/schema.js";

// Mock the API key creator so approveCliCode doesn't need a real DB
vi.mock("../../src/models/api-key/schema.js", () => ({
  createApiKey: vi.fn().mockResolvedValue({ id: "mock-key-id", key: "ks_live_mock_plaintext_value" }),
}));

// Helper to build a fake ICliAuthCode-shaped object used as the
// findOneAndUpdate "pre-update" return value.
function mkDoc(overrides: Partial<any> = {}) {
  return {
    _id: { toString: () => "doc-1" },
    code: "ABCD-1234",
    status: "pending",
    apiKeyId: null,
    apiKeyPlaintext: null,
    userId: null,
    guardianAccountId: null,
    expiresAt: new Date(Date.now() + 10 * 60 * 1000),
    createdAt: new Date(),
    approvedAt: null,
    polledOnceAt: null,
    save: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("createCliCode", () => {
  it("generates a code matching XXXX-XXXX from the ambiguous-free alphabet", async () => {
    const spy = vi.spyOn(CliAuthCodeModel, "create" as any).mockResolvedValue({} as any);

    const { code, expiresAt } = await createCliCode({ hostname: "test-host", cliVersion: "0.2.0" });

    // Format: 4 chars + dash + 4 chars
    expect(code).toMatch(/^[A-HJKMNPQRSTUVWXYZ2-9]{4}-[A-HJKMNPQRSTUVWXYZ2-9]{4}$/);
    // None of the ambiguous chars
    expect(code).not.toMatch(/[0OILa-z]/);
    // expiresAt is ~10 min in the future
    expect(expiresAt.getTime() - Date.now()).toBeGreaterThan(9 * 60 * 1000);
    expect(expiresAt.getTime() - Date.now()).toBeLessThanOrEqual(10 * 60 * 1000 + 1000);

    // Passes through metadata to the model
    expect(spy).toHaveBeenCalledWith(expect.objectContaining({
      code,
      status: "pending",
      hostname: "test-host",
      cliVersion: "0.2.0",
    }));
  });

  it("retries on duplicate-key collision before giving up", async () => {
    const dupErr: any = new Error("duplicate key");
    dupErr.code = 11000;
    const spy = vi.spyOn(CliAuthCodeModel, "create" as any)
      .mockRejectedValueOnce(dupErr)
      .mockRejectedValueOnce(dupErr)
      .mockResolvedValueOnce({} as any);

    const { code } = await createCliCode({});
    expect(code).toBeTruthy();
    expect(spy).toHaveBeenCalledTimes(3);
  });

  it("throws non-duplicate errors immediately", async () => {
    vi.spyOn(CliAuthCodeModel, "create" as any).mockRejectedValue(new Error("connection refused"));
    await expect(createCliCode({})).rejects.toThrow("connection refused");
  });
});

describe("approveCliCode", () => {
  it("rejects an unknown code", async () => {
    vi.spyOn(CliAuthCodeModel, "findOne" as any).mockResolvedValue(null);
    const result = await approveCliCode("UNKN-NOWN", "user-1", "acct-1", "test-key");
    expect(result).toEqual({ error: "not_found" });
  });

  it("rejects an expired code", async () => {
    vi.spyOn(CliAuthCodeModel, "findOne" as any).mockResolvedValue(
      mkDoc({ expiresAt: new Date(Date.now() - 1000) }),
    );
    const result = await approveCliCode("ABCD-1234", "user-1", "acct-1", "test-key");
    expect(result).toEqual({ error: "expired" });
  });

  it("rejects a code already approved/denied", async () => {
    vi.spyOn(CliAuthCodeModel, "findOne" as any).mockResolvedValue(
      mkDoc({ status: "approved" }),
    );
    const result = await approveCliCode("ABCD-1234", "user-1", "acct-1", "test-key");
    expect(result).toEqual({ error: "not_pending" });
  });

  it("mints a key and saves the doc on success", async () => {
    const doc = mkDoc({ status: "pending" });
    vi.spyOn(CliAuthCodeModel, "findOne" as any).mockResolvedValue(doc);

    const result = await approveCliCode("ABCD-1234", "user-1", "acct-1", "CLI (mike)");

    expect(result).toEqual({ apiKeyId: "mock-key-id" });
    expect(doc.status).toBe("approved");
    expect(doc.apiKeyId).toBe("mock-key-id");
    expect(doc.apiKeyPlaintext).toBe("ks_live_mock_plaintext_value");
    expect(doc.userId).toBe("user-1");
    expect(doc.guardianAccountId).toBe("acct-1");
    expect(doc.approvedAt).toBeInstanceOf(Date);
    expect(doc.save).toHaveBeenCalled();
  });
});

describe("denyCliCode", () => {
  it("transitions a pending code to denied", async () => {
    const spy = vi.spyOn(CliAuthCodeModel, "updateOne" as any)
      .mockResolvedValue({ modifiedCount: 1 } as any);
    const ok = await denyCliCode("ABCD-1234");
    expect(ok).toBe(true);
    expect(spy).toHaveBeenCalledWith(
      { code: "ABCD-1234", status: "pending" },
      { $set: { status: "denied" } },
    );
  });

  it("returns false when code isn't pending (already approved/denied/expired)", async () => {
    vi.spyOn(CliAuthCodeModel, "updateOne" as any)
      .mockResolvedValue({ modifiedCount: 0 } as any);
    const ok = await denyCliCode("ABCD-1234");
    expect(ok).toBe(false);
  });
});

describe("consumeCliCode (atomic claim + state machine)", () => {
  it("returns approved + apiKey when the atomic claim succeeds (first poll on approved code)", async () => {
    // findOneAndUpdate with new: false returns the doc as it was BEFORE the
    // update — including the plaintext we just $unset in the same operation.
    const preUpdateDoc = mkDoc({
      status: "approved",
      polledOnceAt: null,
      apiKeyPlaintext: "ks_live_winning_value",
    });
    const fnouSpy = vi.spyOn(CliAuthCodeModel, "findOneAndUpdate" as any)
      .mockResolvedValue(preUpdateDoc as any);

    const result = await consumeCliCode("ABCD-1234");

    expect(result).toEqual({ status: "approved", apiKey: "ks_live_winning_value" });
    // The atomic claim must filter on BOTH status and polledOnceAt
    expect(fnouSpy.mock.calls[0][0]).toEqual({
      code: "ABCD-1234",
      status: "approved",
      polledOnceAt: null,
    });
    // The same update both marks polled AND scrubs the plaintext
    expect(fnouSpy.mock.calls[0][1]).toEqual({
      $set: { polledOnceAt: expect.any(Date) },
      $unset: { apiKeyPlaintext: "" },
    });
    // new: false so we see the pre-update plaintext
    expect(fnouSpy.mock.calls[0][2]).toEqual({ new: false });
  });

  it("returns pending when the code exists but isn't yet approved", async () => {
    vi.spyOn(CliAuthCodeModel, "findOneAndUpdate" as any).mockResolvedValue(null);
    vi.spyOn(CliAuthCodeModel, "findOne" as any).mockResolvedValue(
      mkDoc({ status: "pending", polledOnceAt: null }),
    );
    const result = await consumeCliCode("ABCD-1234");
    expect(result).toEqual({ status: "pending" });
  });

  it("returns denied when the user clicked Deny", async () => {
    vi.spyOn(CliAuthCodeModel, "findOneAndUpdate" as any).mockResolvedValue(null);
    vi.spyOn(CliAuthCodeModel, "findOne" as any).mockResolvedValue(
      mkDoc({ status: "denied" }),
    );
    const result = await consumeCliCode("ABCD-1234");
    expect(result).toEqual({ status: "denied" });
  });

  it("returns expired when the code is past its TTL", async () => {
    vi.spyOn(CliAuthCodeModel, "findOneAndUpdate" as any).mockResolvedValue(null);
    vi.spyOn(CliAuthCodeModel, "findOne" as any).mockResolvedValue(
      mkDoc({ status: "approved", expiresAt: new Date(Date.now() - 1000) }),
    );
    const result = await consumeCliCode("ABCD-1234");
    expect(result).toEqual({ status: "expired" });
  });

  it("returns consumed when an approved code has already been polled once", async () => {
    // Second poll: findOneAndUpdate filter no longer matches because
    // polledOnceAt is set. We fall through to the consumed branch.
    vi.spyOn(CliAuthCodeModel, "findOneAndUpdate" as any).mockResolvedValue(null);
    vi.spyOn(CliAuthCodeModel, "findOne" as any).mockResolvedValue(
      mkDoc({ status: "approved", polledOnceAt: new Date(), apiKeyPlaintext: null }),
    );
    const result = await consumeCliCode("ABCD-1234");
    expect(result).toEqual({ status: "consumed" });
  });

  it("returns unknown when the code doesn't exist (never created, or TTL-swept)", async () => {
    vi.spyOn(CliAuthCodeModel, "findOneAndUpdate" as any).mockResolvedValue(null);
    vi.spyOn(CliAuthCodeModel, "findOne" as any).mockResolvedValue(null);
    const result = await consumeCliCode("ZZZZ-9999");
    expect(result).toEqual({ status: "unknown" });
  });

  it("a concurrent double-poll: only one call returns the apiKey", async () => {
    // Simulates the mongo-level atomicity: only the first findOneAndUpdate
    // that matches the filter returns the doc; subsequent ones get null.
    const preUpdateDoc = mkDoc({
      status: "approved",
      polledOnceAt: null,
      apiKeyPlaintext: "ks_live_winning_value",
    });
    let firstCall = true;
    vi.spyOn(CliAuthCodeModel, "findOneAndUpdate" as any).mockImplementation(async () => {
      if (firstCall) {
        firstCall = false;
        return preUpdateDoc;
      }
      return null;
    });
    // Second-call fallback: code is now in "consumed" state
    vi.spyOn(CliAuthCodeModel, "findOne" as any).mockResolvedValue(
      mkDoc({ status: "approved", polledOnceAt: new Date(), apiKeyPlaintext: null }),
    );

    const [a, b] = await Promise.all([
      consumeCliCode("ABCD-1234"),
      consumeCliCode("ABCD-1234"),
    ]);

    const winners = [a, b].filter(r => r.status === "approved");
    const losers = [a, b].filter(r => r.status === "consumed");
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);
    expect((winners[0] as any).apiKey).toBe("ks_live_winning_value");
  });
});
