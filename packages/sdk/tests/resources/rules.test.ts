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

describe("RulesResource", () => {
  it("list() returns rules", async () => {
    const rules = [{ id: "r1", name: "DDoS", enabled: true }];
    const fetch = mockFetch({ rules });
    const client = new KillSwitchClient({ apiKey: "ks_test", fetch, maxRetries: 0 });

    const result = await client.rules.list();
    expect(result).toEqual(rules);
  });

  it("presets() returns preset list", async () => {
    const presets = [{ id: "ddos", name: "DDoS Protection", description: "...", category: "security" }];
    const fetch = mockFetch({ presets });
    const client = new KillSwitchClient({ apiKey: "ks_test", fetch, maxRetries: 0 });

    const result = await client.rules.presets();
    expect(result).toEqual(presets);
  });

  it("applyPreset() sends POST", async () => {
    const rule = { id: "ddos-1", name: "DDoS", enabled: true };
    const fetch = mockFetch({ rule }, 201);
    const client = new KillSwitchClient({ apiKey: "ks_test", fetch, maxRetries: 0 });

    const result = await client.rules.applyPreset("ddos", { requestsPerMinute: 5000 });
    expect(result).toEqual(rule);
    expect(fetch).toHaveBeenCalledWith(
      expect.stringContaining("/rules/presets/ddos"),
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("toggle() sends POST", async () => {
    const rule = { id: "r1", enabled: false };
    const fetch = mockFetch({ rule });
    const client = new KillSwitchClient({ apiKey: "ks_test", fetch, maxRetries: 0 });

    const result = await client.rules.toggle("r1");
    expect(result).toEqual(rule);
  });

  it("agentTrigger() sends POST to agent endpoint", async () => {
    const response = { ruleId: "agent-1", status: "pending_approval", message: "Created" };
    const fetch = mockFetch(response, 201);
    const client = new KillSwitchClient({ apiKey: "ks_test", fetch, maxRetries: 0 });

    const result = await client.rules.agentTrigger({
      threatDescription: "Cost spike detected",
      recommendedActions: [{ type: "disconnect", target: "*" }],
    });

    expect(result.ruleId).toBe("agent-1");
    expect(fetch).toHaveBeenCalledWith(
      expect.stringContaining("/rules/agent/trigger"),
      expect.objectContaining({ method: "POST" }),
    );
  });
});
