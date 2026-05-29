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

describe("TeamsResource", () => {
  it("members() GETs /team/members", async () => {
    const fetch = mockFetch({ members: [{ userId: "u1", role: "owner" }], invitations: [] });
    const client = new KillSwitchClient({ apiKey: "ks_test", fetch, maxRetries: 0 });

    const result = await client.teams.members();
    expect(result.members).toHaveLength(1);
    expect(result.invitations).toEqual([]);
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe("https://api.kill-switch.net/team/members");
    expect(init.method).toBe("GET");
  });

  it("invite() POSTs /team/invite with email + role", async () => {
    const fetch = mockFetch({ invited: true, invitation: { id: "inv_1", email: "x@y.com" } }, 201);
    const client = new KillSwitchClient({ apiKey: "ks_test", fetch, maxRetries: 0 });

    await client.teams.invite({ email: "x@y.com", role: "member" });
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe("https://api.kill-switch.net/team/invite");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({ email: "x@y.com", role: "member" });
  });

  it("acceptInvite() POSTs /team/invite/accept", async () => {
    const fetch = mockFetch({ joined: true, member: { userId: "u2", role: "member" } });
    const client = new KillSwitchClient({ apiKey: "ks_test", fetch, maxRetries: 0 });

    const result = await client.teams.acceptInvite({ token: "tok_1" } as never);
    expect(result.joined).toBe(true);
    expect(fetch.mock.calls[0][0]).toBe("https://api.kill-switch.net/team/invite/accept");
  });

  it("updateMember() PATCHes /team/members/:id", async () => {
    const fetch = mockFetch({ updated: true, member: { userId: "u2", role: "admin" } });
    const client = new KillSwitchClient({ apiKey: "ks_test", fetch, maxRetries: 0 });

    await client.teams.updateMember("u2", { role: "admin" });
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe("https://api.kill-switch.net/team/members/u2");
    expect(init.method).toBe("PATCH");
  });

  it("removeMember() DELETEs /team/members/:id", async () => {
    const fetch = mockFetch({ removed: true, email: "x@y.com" });
    const client = new KillSwitchClient({ apiKey: "ks_test", fetch, maxRetries: 0 });

    const result = await client.teams.removeMember("u2");
    expect(result.removed).toBe(true);
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe("https://api.kill-switch.net/team/members/u2");
    expect(init.method).toBe("DELETE");
  });

  it("revokeInvitation() DELETEs /team/invitations/:id", async () => {
    const fetch = mockFetch({ revoked: true, email: "x@y.com" });
    const client = new KillSwitchClient({ apiKey: "ks_test", fetch, maxRetries: 0 });

    await client.teams.revokeInvitation("inv_1");
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe("https://api.kill-switch.net/team/invitations/inv_1");
    expect(init.method).toBe("DELETE");
  });
});
