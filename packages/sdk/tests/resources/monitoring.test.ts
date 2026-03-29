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

describe("MonitoringResource", () => {
  it("checkAll() sends POST to /check", async () => {
    const data = {
      status: "checked",
      results: [{ cloudAccountId: "1", provider: "cloudflare", violations: [] }],
      timestamp: "2025-01-01T00:00:00Z",
    };
    const fetch = mockFetch(data);
    const client = new KillSwitchClient({ apiKey: "ks_test", fetch, maxRetries: 0 });

    const result = await client.monitoring.checkAll();
    expect(result.status).toBe("checked");
    expect(result.results).toHaveLength(1);
    expect(fetch).toHaveBeenCalledWith(
      expect.stringContaining("/check"),
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("check() sends POST to /cloud-accounts/:id/check", async () => {
    const fetch = mockFetch({ status: "ok", violations: [] });
    const client = new KillSwitchClient({ apiKey: "ks_test", fetch, maxRetries: 0 });

    await client.monitoring.check("acct_1");
    expect(fetch).toHaveBeenCalledWith(
      expect.stringContaining("/cloud-accounts/acct_1/check"),
      expect.objectContaining({ method: "POST" }),
    );
  });
});
