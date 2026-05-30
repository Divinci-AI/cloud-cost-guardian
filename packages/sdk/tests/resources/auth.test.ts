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

describe("AuthResource", () => {
  it("createKey() POSTs /auth/api-keys and returns the new key", async () => {
    const fetch = mockFetch({ id: "key_1", key: "ks_live_secret", name: "CI" }, 201);
    const client = new KillSwitchClient({ apiKey: "ks_test", fetch, maxRetries: 0 });

    const result = await client.auth.createKey({ name: "CI" });
    expect(result.key).toBe("ks_live_secret");
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe("https://api.kill-switch.net/auth/api-keys");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({ name: "CI" });
  });

  it("listKeys() unwraps the { keys } envelope", async () => {
    const fetch = mockFetch({ keys: [{ id: "key_1", name: "CI" }, { id: "key_2", name: "Local" }] });
    const client = new KillSwitchClient({ apiKey: "ks_test", fetch, maxRetries: 0 });

    const result = await client.auth.listKeys();
    expect(result).toHaveLength(2);
    expect(result[0].id).toBe("key_1");
    expect(fetch.mock.calls[0][1].method).toBe("GET");
  });

  it("rollKey() POSTs to the /roll sub-path", async () => {
    const fetch = mockFetch({ id: "key_1", key: "ks_live_rolled" });
    const client = new KillSwitchClient({ apiKey: "ks_test", fetch, maxRetries: 0 });

    await client.auth.rollKey("key_1");
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe("https://api.kill-switch.net/auth/api-keys/key_1/roll");
    expect(init.method).toBe("POST");
  });

  it("revokeKey() DELETEs the key", async () => {
    const fetch = mockFetch({ deleted: true });
    const client = new KillSwitchClient({ apiKey: "ks_test", fetch, maxRetries: 0 });

    const result = await client.auth.revokeKey("key_1");
    expect(result.deleted).toBe(true);
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe("https://api.kill-switch.net/auth/api-keys/key_1");
    expect(init.method).toBe("DELETE");
  });
});
