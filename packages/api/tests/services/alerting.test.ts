import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { sendAlerts } from "../../src/services/alerting.js";
import type { AlertChannel } from "../../src/models/guardian-account/schema.js";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

// Mock the Resend SDK so email tests don't make real HTTP calls
const mockResendSend = vi.fn();
vi.mock("resend", () => ({
  Resend: vi.fn().mockImplementation(() => ({
    emails: { send: mockResendSend },
  })),
}));

describe("Alerting Service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFetch.mockResolvedValue({ ok: true, text: async () => "{}" });
  });

  it("sends to PagerDuty with correct payload format", async () => {
    const channels: AlertChannel[] = [{
      type: "pagerduty",
      name: "On-Call",
      config: { routingKey: "test-routing-key" },
      enabled: true,
    }];

    await sendAlerts(channels, "Test alert", "critical", { cost: 91000 });

    expect(mockFetch).toHaveBeenCalledWith(
      "https://events.pagerduty.com/v2/enqueue",
      expect.objectContaining({
        method: "POST",
        body: expect.stringContaining("test-routing-key"),
      })
    );

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.routing_key).toBe("test-routing-key");
    expect(body.event_action).toBe("trigger");
    expect(body.payload.summary).toBe("Test alert");
    expect(body.payload.severity).toBe("critical");
    expect(body.payload.custom_details.cost).toBe(91000);
  });

  it("sends to Discord with embed format", async () => {
    const channels: AlertChannel[] = [{
      type: "discord",
      name: "Alerts",
      config: { webhookUrl: "https://discord.com/api/webhooks/123/abc" },
      enabled: true,
    }];

    await sendAlerts(channels, "Cost spike detected", "warning", { service: "my-worker" });

    expect(mockFetch).toHaveBeenCalledWith(
      "https://discord.com/api/webhooks/123/abc",
      expect.objectContaining({ method: "POST" })
    );

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.embeds).toHaveLength(1);
    expect(body.embeds[0].title).toContain("WARNING");
    expect(body.embeds[0].description).toBe("Cost spike detected");
    expect(body.embeds[0].color).toBe(0xFFCC00); // warning = yellow
  });

  it("sends to Slack with block format", async () => {
    const channels: AlertChannel[] = [{
      type: "slack",
      name: "Ops",
      config: { webhookUrl: "https://hooks.slack.com/services/T00/B00/xxx" },
      enabled: true,
    }];

    await sendAlerts(channels, "Server overloaded", "error", {});

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.text).toContain("ERROR");
    expect(body.text).toContain("Server overloaded");
  });

  it("sends to custom webhook with standard payload", async () => {
    const channels: AlertChannel[] = [{
      type: "webhook",
      name: "Custom",
      config: { webhookUrl: "https://my-api.com/alerts" },
      enabled: true,
    }];

    await sendAlerts(channels, "Alert!", "info", { foo: "bar" });

    expect(mockFetch).toHaveBeenCalledWith(
      "https://my-api.com/alerts",
      expect.objectContaining({ method: "POST" })
    );

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.summary).toBe("Alert!");
    expect(body.severity).toBe("info");
    expect(body.source).toBe("kill-switch");
    expect(body.details.foo).toBe("bar");
  });

  it("sends to multiple channels in parallel", async () => {
    const channels: AlertChannel[] = [
      { type: "pagerduty", name: "PD", config: { routingKey: "key1" }, enabled: true },
      { type: "discord", name: "Discord", config: { webhookUrl: "https://discord.com/wh" }, enabled: true },
      { type: "slack", name: "Slack", config: { webhookUrl: "https://hooks.slack.com/x" }, enabled: true },
    ];

    await sendAlerts(channels, "Multi-channel test", "critical", {});

    expect(mockFetch).toHaveBeenCalledTimes(3);
  });

  it("skips disabled channels", async () => {
    const channels: AlertChannel[] = [
      { type: "pagerduty", name: "PD", config: { routingKey: "key1" }, enabled: false },
      { type: "discord", name: "Discord", config: { webhookUrl: "https://discord.com/wh" }, enabled: true },
    ];

    await sendAlerts(channels, "Test", "info", {});

    expect(mockFetch).toHaveBeenCalledTimes(1); // Only Discord
    expect(mockFetch.mock.calls[0][0]).toContain("discord.com");
  });

  it("handles fetch failure gracefully (does not throw)", async () => {
    mockFetch.mockRejectedValue(new Error("Network error"));

    const channels: AlertChannel[] = [{
      type: "pagerduty",
      name: "PD",
      config: { routingKey: "key1" },
      enabled: true,
    }];

    // Should not throw
    await expect(sendAlerts(channels, "Test", "critical", {})).resolves.not.toThrow();
  });

  it("skips channels without required config", async () => {
    const channels: AlertChannel[] = [
      { type: "pagerduty", name: "PD", config: {}, enabled: true }, // No routingKey
      { type: "discord", name: "Discord", config: {}, enabled: true }, // No webhookUrl
    ];

    await sendAlerts(channels, "Test", "info", {});

    // Both should be called but return early internally
    // (the functions check for config before sending)
    expect(mockFetch).not.toHaveBeenCalled();
  });

  describe("GitHub Remediation Channel", () => {
    const githubChannel = (): AlertChannel => ({
      type: "github",
      name: "Auto-Remediation",
      config: {
        githubToken: "ghp_test1234567890",
        repoOwner: "acme-corp",
        repoName: "my-app",
        workflowFile: "kill-switch-remediate.yml",
        branchRef: "main",
      },
      enabled: true,
    });

    const violations = [
      { serviceName: "d1-chunks-abc", metricName: "D1 Rows Read", currentValue: 302_100_000, threshold: 5_000_000, unit: "rows", severity: "critical" },
      { serviceName: "d1-chunks-def", metricName: "D1 Rows Read", currentValue: 315_200_000, threshold: 5_000_000, unit: "rows", severity: "critical" },
    ];

    it("dispatches workflow_dispatch to the correct GitHub API URL", async () => {
      await sendAlerts([githubChannel()], "D1 overage", "critical", {
        provider: "cloudflare", accountName: "zombay-cf", cloudAccountId: "acc-123",
        violations, actionsTaken: ["Disconnected d1-chunks-abc"],
      });

      expect(mockFetch).toHaveBeenCalledWith(
        "https://api.github.com/repos/acme-corp/my-app/actions/workflows/kill-switch-remediate.yml/dispatches",
        expect.objectContaining({ method: "POST" })
      );
    });

    it("sends correct Authorization header and GitHub API version", async () => {
      await sendAlerts([githubChannel()], "D1 overage", "critical", {
        provider: "cloudflare", accountName: "zombay-cf", cloudAccountId: "acc-123",
        violations, actionsTaken: [],
      });

      const [, opts] = mockFetch.mock.calls[0];
      expect(opts.headers["Authorization"]).toBe("Bearer ghp_test1234567890");
      expect(opts.headers["X-GitHub-Api-Version"]).toBe("2022-11-28");
      expect(opts.headers["Accept"]).toBe("application/vnd.github+json");
    });

    it("dispatches on the configured branchRef, not hardcoded main", async () => {
      const channel = githubChannel();
      channel.config.branchRef = "develop";

      await sendAlerts([channel], "D1 overage", "critical", {
        provider: "cloudflare", accountName: "zombay-cf", cloudAccountId: "acc-123",
        violations, actionsTaken: [],
      });

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.ref).toBe("develop");
    });

    it("defaults to main when branchRef is not set", async () => {
      const channel = githubChannel();
      delete channel.config.branchRef;

      await sendAlerts([channel], "D1 overage", "critical", {
        provider: "cloudflare", accountName: "zombay-cf", cloudAccountId: "acc-123",
        violations, actionsTaken: [],
      });

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.ref).toBe("main");
    });

    it("passes all violation context as string inputs", async () => {
      await sendAlerts([githubChannel()], "D1 overage", "critical", {
        provider: "cloudflare", accountName: "zombay-cf", cloudAccountId: "acc-123",
        violations, actionsTaken: ["Disconnected d1-chunks-abc"],
      });

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      const inputs = body.inputs;

      expect(inputs.provider).toBe("cloudflare");
      expect(inputs.account_name).toBe("zombay-cf");
      expect(inputs.severity).toBe("critical");
      expect(inputs.violation_count).toBe("2");
      expect(inputs.kill_switch_action).toBe("Disconnected d1-chunks-abc");

      // All inputs must be strings (GitHub Actions requirement)
      for (const [key, val] of Object.entries(inputs)) {
        expect(typeof val).toBe("string", `input "${key}" must be a string`);
      }
    });

    it("calculates multiplier correctly in violations_json (60x overage)", async () => {
      await sendAlerts([githubChannel()], "D1 overage", "critical", {
        provider: "cloudflare", accountName: "zombay-cf", cloudAccountId: "acc-123",
        violations, actionsTaken: [],
      });

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      const parsed = JSON.parse(body.inputs.violations_json);

      expect(parsed[0].multiplier).toBe("60x"); // 302_100_000 / 5_000_000 = 60.42 → "60x"
      expect(parsed[1].multiplier).toBe("63x"); // 315_200_000 / 5_000_000 = 63.04 → "63x"
      expect(parsed[0].serviceName).toBe("d1-chunks-abc");
      expect(parsed[0].metricName).toBe("D1 Rows Read");
    });

    it("scopes dedup_key to cloudAccountId and calendar date", async () => {
      await sendAlerts([githubChannel()], "D1 overage", "critical", {
        provider: "cloudflare", accountName: "zombay-cf", cloudAccountId: "acc-123",
        violations, actionsTaken: [],
      });

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      const today = new Date().toISOString().split("T")[0];
      expect(body.inputs.dedup_key).toBe(`acc-123:${today}`);
    });

    it("falls back to accountName in dedup_key when cloudAccountId is absent", async () => {
      await sendAlerts([githubChannel()], "D1 overage", "critical", {
        provider: "cloudflare", accountName: "zombay-cf",
        violations, actionsTaken: [],
        // No cloudAccountId
      });

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      const today = new Date().toISOString().split("T")[0];
      expect(body.inputs.dedup_key).toBe(`zombay-cf:${today}`);
    });

    it("skips dispatch and logs warning when required config fields are missing", async () => {
      const incomplete: AlertChannel = {
        type: "github",
        name: "Broken",
        config: { githubToken: "tok" }, // missing repoOwner, repoName, workflowFile
        enabled: true,
      };

      await sendAlerts([incomplete], "alert", "critical", { violations: [] });

      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("logs error but does not throw when GitHub API returns non-200", async () => {
      mockFetch.mockResolvedValueOnce({ ok: false, status: 422, text: async () => '{"message":"Reference not found"}' });

      await expect(
        sendAlerts([githubChannel()], "D1 overage", "critical", {
          provider: "cloudflare", accountName: "zombay-cf", cloudAccountId: "acc-123",
          violations, actionsTaken: [],
        })
      ).resolves.not.toThrow();
    });

    it("handles empty violations array gracefully (e.g. test alert)", async () => {
      await sendAlerts([githubChannel()], "Test alert", "info", {
        test: true, message: "Integration check", cloudAccountId: "acc-123",
        violations: [],
      });

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.inputs.violation_count).toBe("0");
      expect(body.inputs.violations_json).toBe("[]");
    });

    it("disabled GitHub channel is not dispatched", async () => {
      const channel = githubChannel();
      channel.enabled = false;

      await sendAlerts([channel], "D1 overage", "critical", {
        provider: "cloudflare", accountName: "zombay-cf", cloudAccountId: "acc-123",
        violations, actionsTaken: [],
      });

      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("GitHub channel fires alongside PagerDuty in the same sendAlerts call", async () => {
      const pdChannel: AlertChannel = {
        type: "pagerduty",
        name: "On-Call",
        config: { routingKey: "pd-routing-key" },
        enabled: true,
      };
      mockFetch.mockResolvedValue({ ok: true, text: async () => "{}" });

      await sendAlerts([pdChannel, githubChannel()], "D1 overage", "critical", {
        provider: "cloudflare", accountName: "zombay-cf", cloudAccountId: "acc-123",
        violations, actionsTaken: ["Disconnected d1-chunks-abc"],
      });

      // Both channels should have fired — fetch called twice
      expect(mockFetch).toHaveBeenCalledTimes(2);
      const urls = mockFetch.mock.calls.map((c: any[]) => c[0]);
      expect(urls).toContain("https://events.pagerduty.com/v2/enqueue");
      expect(urls).toContain(
        "https://api.github.com/repos/acme-corp/my-app/actions/workflows/kill-switch-remediate.yml/dispatches"
      );
    });

    it("uses N/A multiplier when threshold is zero", async () => {
      const zeroThresholdViolations = [
        { serviceName: "svc:x", metricName: "Cost", currentValue: 50, threshold: 0, unit: "USD", severity: "warning" },
      ];

      await sendAlerts([githubChannel()], "Cost alert", "warning", {
        provider: "neon", accountName: "neon-db", cloudAccountId: "acc-999",
        violations: zeroThresholdViolations, actionsTaken: [],
      });

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      const parsed = JSON.parse(body.inputs.violations_json);
      expect(parsed[0].multiplier).toBe("N/A");
    });

    it("violations_json input is always parseable JSON", async () => {
      await sendAlerts([githubChannel()], "D1 overage", "critical", {
        provider: "cloudflare", accountName: "zombay-cf", cloudAccountId: "acc-123",
        violations, actionsTaken: [],
      });

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(() => JSON.parse(body.inputs.violations_json)).not.toThrow();
    });

    it("success path does not log to console.error", async () => {
      const errorSpy = vi.spyOn(console, "error");

      await sendAlerts([githubChannel()], "D1 overage", "critical", {
        provider: "cloudflare", accountName: "zombay-cf", cloudAccountId: "acc-123",
        violations, actionsTaken: ["Disconnected d1-chunks-abc"],
      });

      expect(errorSpy).not.toHaveBeenCalled();
      errorSpy.mockRestore();
    });

    it("SSRF — GitHub API host is explicitly allowed through isUrlSafe", async () => {
      // Verify the fetch call goes through on the correct GitHub API host.
      // If isUrlSafe blocked api.github.com, no fetch would be made.
      await sendAlerts([githubChannel()], "D1 overage", "critical", {
        provider: "cloudflare", accountName: "zombay-cf", cloudAccountId: "acc-123",
        violations, actionsTaken: [],
      });

      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining("https://api.github.com/"),
        expect.any(Object)
      );
    });
  });

  describe("Email Channel (Resend)", () => {
    const emailChannel = (): AlertChannel => ({
      type: "email",
      name: "Email Alerts",
      config: { email: "oncall@example.com" },
      enabled: true,
    });

    const violations = [
      { serviceName: "my-worker", metricName: "CPU Time", currentValue: 60_000, threshold: 10_000, unit: "ms", severity: "critical" },
    ];

    beforeEach(() => {
      process.env.RESEND_API_KEY = "re_test_key";
      mockResendSend.mockResolvedValue({ data: { id: "email-123" }, error: null });
    });

    afterEach(() => {
      delete process.env.RESEND_API_KEY;
      delete process.env.RESEND_FROM;
    });

    it("sends email with correct to, subject, html, and text fields", async () => {
      await sendAlerts([emailChannel()], "CPU spike detected", "critical", {
        provider: "cloudflare", accountName: "zombay-cf", violations,
      });

      expect(mockResendSend).toHaveBeenCalledOnce();
      const [payload] = mockResendSend.mock.calls[0];
      expect(payload.to).toEqual(["oncall@example.com"]);
      expect(payload.subject).toContain("CPU spike detected");
      expect(payload.html).toBeDefined();
      expect(payload.text).toBeDefined();
    });

    it("subject includes severity emoji and uppercased severity", async () => {
      await sendAlerts([emailChannel()], "Cost runaway", "critical", {
        provider: "cloudflare", accountName: "zombay-cf", violations,
      });

      const [payload] = mockResendSend.mock.calls[0];
      expect(payload.subject).toContain("🚨");
      expect(payload.subject).toContain("CRITICAL");
      expect(payload.subject).toContain("Cost runaway");
    });

    it("uses RESEND_FROM env var when set", async () => {
      process.env.RESEND_FROM = "Alerts <noreply@myapp.com>";

      await sendAlerts([emailChannel()], "test", "info", { violations: [] });

      const [payload] = mockResendSend.mock.calls[0];
      expect(payload.from).toBe("Alerts <noreply@myapp.com>");
    });

    it("defaults from address to Kill Switch branding", async () => {
      await sendAlerts([emailChannel()], "test", "info", { violations: [] });

      const [payload] = mockResendSend.mock.calls[0];
      expect(payload.from).toBe("Kill Switch <alerts@kill-switch.net>");
    });

    it("HTML body contains violation table rows for each violation", async () => {
      await sendAlerts([emailChannel()], "CPU spike", "critical", {
        provider: "cloudflare", accountName: "zombay-cf", violations,
      });

      const [payload] = mockResendSend.mock.calls[0];
      expect(payload.html).toContain("my-worker");
      expect(payload.html).toContain("CPU Time");
      expect(payload.html).toContain("60000");
      expect(payload.html).toContain("10000");
      expect(payload.html).toContain("6×"); // 60000 / 10000 = 6
    });

    it("plain-text fallback includes provider, account, and violations", async () => {
      await sendAlerts([emailChannel()], "CPU spike", "critical", {
        provider: "cloudflare", accountName: "zombay-cf", violations,
      });

      const [payload] = mockResendSend.mock.calls[0];
      expect(payload.text).toContain("cloudflare");
      expect(payload.text).toContain("zombay-cf");
      expect(payload.text).toContain("my-worker");
    });

    it("skips sending when RESEND_API_KEY is not set", async () => {
      delete process.env.RESEND_API_KEY;

      await sendAlerts([emailChannel()], "test", "info", { violations: [] });

      expect(mockResendSend).not.toHaveBeenCalled();
    });

    it("skips sending when email address is missing from config", async () => {
      const channel: AlertChannel = {
        type: "email",
        name: "Email Alerts",
        config: {}, // no email
        enabled: true,
      };

      await sendAlerts([channel], "test", "info", { violations: [] });

      expect(mockResendSend).not.toHaveBeenCalled();
    });

    it("logs error but does not throw when Resend returns an error", async () => {
      mockResendSend.mockResolvedValueOnce({ data: null, error: { message: "Invalid API key" } });

      await expect(
        sendAlerts([emailChannel()], "test", "critical", { violations: [] })
      ).resolves.not.toThrow();
    });

    it("HTML includes actionsTaken when provided", async () => {
      await sendAlerts([emailChannel()], "CPU spike", "critical", {
        provider: "cloudflare", accountName: "zombay-cf", violations,
        actionsTaken: ["Stopped worker my-worker"],
      });

      const [payload] = mockResendSend.mock.calls[0];
      expect(payload.html).toContain("Stopped worker my-worker");
    });

    it("still sends email when violations array is empty", async () => {
      await sendAlerts([emailChannel()], "Test alert", "info", {
        provider: "cloudflare", accountName: "zombay-cf", violations: [],
      });

      expect(mockResendSend).toHaveBeenCalledOnce();
      const [payload] = mockResendSend.mock.calls[0];
      expect(payload.html).not.toContain("<tbody><tr>"); // no violation rows
    });
  });

  it("uses correct color codes for Discord severity", async () => {
    const makeChannel = (): AlertChannel[] => [{
      type: "discord",
      name: "Test",
      config: { webhookUrl: "https://discord.com/wh" },
      enabled: true,
    }];

    await sendAlerts(makeChannel(), "Critical", "critical", {});
    expect(JSON.parse(mockFetch.mock.calls[0][1].body).embeds[0].color).toBe(0xFF0000);

    mockFetch.mockClear();
    await sendAlerts(makeChannel(), "Error", "error", {});
    expect(JSON.parse(mockFetch.mock.calls[0][1].body).embeds[0].color).toBe(0xFF6600);

    mockFetch.mockClear();
    await sendAlerts(makeChannel(), "Warning", "warning", {});
    expect(JSON.parse(mockFetch.mock.calls[0][1].body).embeds[0].color).toBe(0xFFCC00);

    mockFetch.mockClear();
    await sendAlerts(makeChannel(), "Info", "info", {});
    expect(JSON.parse(mockFetch.mock.calls[0][1].body).embeds[0].color).toBe(0x0099FF);
  });
});
