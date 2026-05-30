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

describe("AnalyticsResource", () => {
  it("overview() GETs /analytics/overview", async () => {
    const data = { totalSpend: 123.45, avgDailyCost: 4.11, projectedMonthly: 127, killSwitchActions: 3 };
    const fetch = mockFetch(data);
    const client = new KillSwitchClient({ apiKey: "ks_test", fetch, maxRetries: 0 });

    const result = await client.analytics.overview();
    expect(result.totalSpend).toBe(123.45);
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe("https://api.kill-switch.net/analytics/overview");
    expect(init.method).toBe("GET");
  });
});
