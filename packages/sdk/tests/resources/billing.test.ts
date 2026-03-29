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

describe("BillingResource", () => {
  it("plans() returns plan list", async () => {
    const plans = [{ tier: "free", name: "Free" }, { tier: "pro", name: "Pro" }];
    const fetch = mockFetch({ plans });
    const client = new KillSwitchClient({ apiKey: "ks_test", fetch, maxRetries: 0 });

    const result = await client.billing.plans();
    expect(result).toHaveLength(2);
    expect(result[0].tier).toBe("free");
  });

  it("status() returns billing status", async () => {
    const fetch = mockFetch({ tier: "pro", limits: { cloudAccounts: 3 }, subscription: null });
    const client = new KillSwitchClient({ apiKey: "ks_test", fetch, maxRetries: 0 });

    const result = await client.billing.status();
    expect(result.tier).toBe("pro");
  });

  it("checkout() sends POST", async () => {
    const fetch = mockFetch({ checkoutUrl: "https://checkout.stripe.com/...", sessionId: "sess_1" });
    const client = new KillSwitchClient({ apiKey: "ks_test", fetch, maxRetries: 0 });

    const result = await client.billing.checkout({ planKey: "guardian_pro_monthly" });
    expect(result.checkoutUrl).toContain("stripe");
    expect(result.sessionId).toBe("sess_1");
  });

  it("portal() sends POST", async () => {
    const fetch = mockFetch({ portalUrl: "https://billing.stripe.com/..." });
    const client = new KillSwitchClient({ apiKey: "ks_test", fetch, maxRetries: 0 });

    const result = await client.billing.portal();
    expect(result.portalUrl).toContain("stripe");
  });
});
