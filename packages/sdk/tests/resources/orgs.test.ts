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

describe("OrgsResource", () => {
  it("list() returns orgs and activeOrgId", async () => {
    const data = {
      orgs: [{ id: "org_1", name: "My Org", type: "personal", tier: "free", role: "owner" }],
      activeOrgId: "org_1",
    };
    const fetch = mockFetch(data);
    const client = new KillSwitchClient({ apiKey: "ks_test", fetch, maxRetries: 0 });

    const result = await client.orgs.list();
    expect(result.orgs).toHaveLength(1);
    expect(result.activeOrgId).toBe("org_1");
  });

  it("create() sends POST", async () => {
    const fetch = mockFetch({ id: "org_2", name: "New Org", slug: "new-org", type: "organization", tier: "team" }, 201);
    const client = new KillSwitchClient({ apiKey: "ks_test", fetch, maxRetries: 0 });

    const result = await client.orgs.create({ name: "New Org" });
    expect(result.id).toBe("org_2");
    expect(result.name).toBe("New Org");
  });

  it("switch() sends POST", async () => {
    const fetch = mockFetch({ switched: true, activeOrgId: "org_2" });
    const client = new KillSwitchClient({ apiKey: "ks_test", fetch, maxRetries: 0 });

    const result = await client.orgs.switch("org_2");
    expect(result.switched).toBe(true);
  });

  it("delete() sends DELETE", async () => {
    const fetch = mockFetch({ deleted: true });
    const client = new KillSwitchClient({ apiKey: "ks_test", fetch, maxRetries: 0 });

    const result = await client.orgs.delete("org_2");
    expect(result.deleted).toBe(true);
  });
});
