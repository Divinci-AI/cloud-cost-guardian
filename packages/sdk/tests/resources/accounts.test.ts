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

describe("AccountsResource", () => {
  it("list() returns accounts array", async () => {
    const accounts = [{ id: "1", provider: "cloudflare", name: "Prod" }];
    const fetch = mockFetch({ accounts });
    const client = new KillSwitchClient({ apiKey: "ks_test", fetch, maxRetries: 0 });

    const result = await client.accounts.list();
    expect(result).toEqual(accounts);
    expect(fetch).toHaveBeenCalledWith(
      expect.stringContaining("/cloud-accounts"),
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("get() fetches single account", async () => {
    const account = { id: "1", provider: "aws", name: "Staging" };
    const fetch = mockFetch(account);
    const client = new KillSwitchClient({ apiKey: "ks_test", fetch, maxRetries: 0 });

    const result = await client.accounts.get("1");
    expect(result).toEqual(account);
    expect(fetch).toHaveBeenCalledWith(
      expect.stringContaining("/cloud-accounts/1"),
      expect.any(Object),
    );
  });

  it("create() sends POST with credential", async () => {
    const created = { id: "2", provider: "cloudflare", name: "New" };
    const fetch = mockFetch(created, 201);
    const client = new KillSwitchClient({ apiKey: "ks_test", fetch, maxRetries: 0 });

    const result = await client.accounts.create({
      provider: "cloudflare",
      name: "New",
      credential: { apiToken: "tok", accountId: "acct" },
    });

    expect(result).toEqual(created);
    expect(fetch).toHaveBeenCalledWith(
      expect.stringContaining("/cloud-accounts"),
      expect.objectContaining({
        method: "POST",
        body: expect.stringContaining('"provider":"cloudflare"'),
      }),
    );
  });

  it("delete() sends DELETE", async () => {
    const fetch = mockFetch({ deleted: true });
    const client = new KillSwitchClient({ apiKey: "ks_test", fetch, maxRetries: 0 });

    const result = await client.accounts.delete("1");
    expect(result).toEqual({ deleted: true });
    expect(fetch).toHaveBeenCalledWith(
      expect.stringContaining("/cloud-accounts/1"),
      expect.objectContaining({ method: "DELETE" }),
    );
  });

  it("check() sends POST to check endpoint", async () => {
    const fetch = mockFetch({ status: "ok", violations: [] });
    const client = new KillSwitchClient({ apiKey: "ks_test", fetch, maxRetries: 0 });

    await client.accounts.check("1");
    expect(fetch).toHaveBeenCalledWith(
      expect.stringContaining("/cloud-accounts/1/check"),
      expect.objectContaining({ method: "POST" }),
    );
  });
});
