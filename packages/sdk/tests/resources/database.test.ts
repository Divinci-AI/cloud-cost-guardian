import { describe, it, expect, vi } from "vitest";
import { KillSwitchClient } from "../../src/index.js";

function mockFetch(body: unknown, status = 200) {
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(),
    text: () => Promise.resolve(JSON.stringify(body)),
  });
}

describe("DatabaseResource", () => {
  it("storeCredentials() sends POST", async () => {
    const fetch = mockFetch({ credentialId: "cred_123" }, 201);
    const client = new KillSwitchClient({ apiKey: "ks_test", fetch, maxRetries: 0 });

    const result = await client.database.storeCredentials({
      provider: "mongodb-atlas",
      atlasPublicKey: "pub",
      atlasPrivateKey: "priv",
    });
    expect(result.credentialId).toBe("cred_123");
  });

  it("initiate() sends POST to /database/kill", async () => {
    const fetch = mockFetch({
      id: "seq_1", status: "initiated",
      steps: [{ action: "snapshot", status: "pending" }],
      message: "Kill sequence initiated.",
    }, 201);
    const client = new KillSwitchClient({ apiKey: "ks_test", fetch, maxRetries: 0 });

    const result = await client.database.initiate({
      credentialId: "cred_123",
      trigger: "cost spike",
    });
    expect(result.id).toBe("seq_1");
    expect(result.status).toBe("initiated");
  });

  it("advance() sends POST with credential", async () => {
    const fetch = mockFetch({
      id: "seq_1", status: "in_progress", currentStep: 1,
      steps: [{ action: "snapshot", status: "completed" }],
    });
    const client = new KillSwitchClient({ apiKey: "ks_test", fetch, maxRetries: 0 });

    const result = await client.database.advance("seq_1", {
      credentialId: "cred_123",
      humanApproval: true,
    });
    expect(result.currentStep).toBe(1);
  });

  it("abort() sends POST", async () => {
    const fetch = mockFetch({ id: "seq_1", status: "aborted", message: "Aborted" });
    const client = new KillSwitchClient({ apiKey: "ks_test", fetch, maxRetries: 0 });

    const result = await client.database.abort("seq_1");
    expect(result.status).toBe("aborted");
  });

  it("list() returns sequences", async () => {
    const fetch = mockFetch({ sequences: [{ id: "seq_1", status: "initiated" }] });
    const client = new KillSwitchClient({ apiKey: "ks_test", fetch, maxRetries: 0 });

    const result = await client.database.list();
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("seq_1");
  });

  it("get() fetches single sequence", async () => {
    const seq = { id: "seq_1", status: "in_progress", steps: [] };
    const fetch = mockFetch(seq);
    const client = new KillSwitchClient({ apiKey: "ks_test", fetch, maxRetries: 0 });

    const result = await client.database.get("seq_1");
    expect(result.id).toBe("seq_1");
  });
});
