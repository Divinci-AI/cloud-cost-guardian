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

describe("AlertsResource", () => {
  it("channels() returns channel list", async () => {
    const channels = [{ type: "email", name: "Email", enabled: true }];
    const fetch = mockFetch({ channels });
    const client = new KillSwitchClient({ apiKey: "ks_test", fetch, maxRetries: 0 });

    const result = await client.alerts.channels();
    expect(result).toEqual(channels);
    expect(fetch).toHaveBeenCalledWith(
      expect.stringContaining("/alerts/channels"),
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("updateChannels() sends PUT", async () => {
    const fetch = mockFetch({ updated: true, channelCount: 2 });
    const client = new KillSwitchClient({ apiKey: "ks_test", fetch, maxRetries: 0 });

    const result = await client.alerts.updateChannels([
      { type: "email", name: "Email", enabled: true, config: { email: "a@b.com" } },
    ] as any);
    expect(result.updated).toBe(true);
    expect(fetch).toHaveBeenCalledWith(
      expect.stringContaining("/alerts/channels"),
      expect.objectContaining({ method: "PUT" }),
    );
  });

  it("test() sends POST", async () => {
    const fetch = mockFetch({ status: "sent", channelsSent: 2 });
    const client = new KillSwitchClient({ apiKey: "ks_test", fetch, maxRetries: 0 });

    const result = await client.alerts.test();
    expect(result.status).toBe("sent");
    expect(result.channelsSent).toBe(2);
  });
});
