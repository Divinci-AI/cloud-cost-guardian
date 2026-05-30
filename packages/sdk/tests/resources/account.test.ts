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

describe("AccountResource", () => {
  it("me() GETs /accounts/me", async () => {
    const fetch = mockFetch({ id: "acct_1", email: "a@b.com", tier: "pro" });
    const client = new KillSwitchClient({ apiKey: "ks_test", fetch, maxRetries: 0 });

    const result = await client.account.me();
    expect(result.id).toBe("acct_1");
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe("https://api.kill-switch.net/accounts/me");
    expect(init.method).toBe("GET");
  });

  it("update() PATCHes /accounts/me with the body", async () => {
    const fetch = mockFetch({ id: "acct_1", email: "a@b.com", tier: "pro" });
    const client = new KillSwitchClient({ apiKey: "ks_test", fetch, maxRetries: 0 });

    await client.account.update({ settings: { defaultTimezone: "UTC" } } as never);
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe("https://api.kill-switch.net/accounts/me");
    expect(init.method).toBe("PATCH");
    expect(JSON.parse(init.body)).toMatchObject({ settings: { defaultTimezone: "UTC" } });
  });
});
