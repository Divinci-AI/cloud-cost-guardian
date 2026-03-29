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

describe("ProvidersResource", () => {
  it("list() returns providers", async () => {
    const providers = [
      { id: "cloudflare", name: "Cloudflare" },
      { id: "aws", name: "AWS" },
    ];
    const fetch = mockFetch({ providers });
    const client = new KillSwitchClient({ apiKey: "ks_test", fetch, maxRetries: 0 });

    const result = await client.providers.list();
    expect(result).toHaveLength(2);
    expect(result[0].id).toBe("cloudflare");
  });

  it("validate() sends POST to /providers/:id/validate", async () => {
    const fetch = mockFetch({ valid: true, accountId: "acct_123", accountName: "My Account" });
    const client = new KillSwitchClient({ apiKey: "ks_test", fetch, maxRetries: 0 });

    const result = await client.providers.validate("cloudflare", {
      apiToken: "tok",
      accountId: "acct",
    });
    expect(result.valid).toBe(true);
    expect(result.accountId).toBe("acct_123");
    expect(fetch).toHaveBeenCalledWith(
      expect.stringContaining("/providers/cloudflare/validate"),
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("validate() returns error when invalid", async () => {
    const fetch = mockFetch({ valid: false, error: "Invalid token" });
    const client = new KillSwitchClient({ apiKey: "ks_test", fetch, maxRetries: 0 });

    const result = await client.providers.validate("cloudflare", { apiToken: "bad" });
    expect(result.valid).toBe(false);
    expect(result.error).toBe("Invalid token");
  });
});
