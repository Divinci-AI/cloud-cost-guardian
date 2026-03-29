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

describe("ActivityResource", () => {
  it("list() returns paginated entries", async () => {
    const data = {
      entries: [{ id: "1", action: "cloud_account.create", resourceType: "cloud_account" }],
      page: 1,
      total: 1,
      limit: 50,
    };
    const fetch = mockFetch(data);
    const client = new KillSwitchClient({ apiKey: "ks_test", fetch, maxRetries: 0 });

    const result = await client.activity.list();
    expect(result.entries).toHaveLength(1);
    expect(result.page).toBe(1);
    expect(result.total).toBe(1);
  });

  it("list() builds query params from options", async () => {
    const fetch = mockFetch({ entries: [], page: 2, total: 0, limit: 10 });
    const client = new KillSwitchClient({ apiKey: "ks_test", fetch, maxRetries: 0 });

    await client.activity.list({
      page: 2,
      limit: 10,
      action: "rule.create",
      from: "2025-01-01",
    });

    const url = fetch.mock.calls[0][0] as string;
    expect(url).toContain("page=2");
    expect(url).toContain("limit=10");
    expect(url).toContain("action=rule.create");
    expect(url).toContain("from=2025-01-01");
  });
});
