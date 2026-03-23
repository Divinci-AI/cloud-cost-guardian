/**
 * Alerting Service
 *
 * Sends alerts to configured channels (PagerDuty, Discord, Slack, email, webhook).
 * Reuses the same alerting logic from the open-source kill switch.
 */

import type { AlertChannel } from "../models/guardian-account/schema.js";

type Severity = "critical" | "error" | "warning" | "info";

/**
 * SSRF Protection: Validate webhook URLs are safe to call.
 * Blocks private/internal IPs and non-HTTPS URLs.
 */
function isUrlSafe(urlString: string): boolean {
  try {
    const url = new URL(urlString);
    // Only allow HTTPS
    if (url.protocol !== "https:") return false;
    // Block known internal hostnames
    const blocked = ["localhost", "127.0.0.1", "0.0.0.0", "169.254.169.254", "[::1]", "metadata.google.internal"];
    if (blocked.includes(url.hostname)) return false;
    // Block private IP ranges
    const parts = url.hostname.split(".");
    if (parts.length === 4) {
      const first = parseInt(parts[0]);
      const second = parseInt(parts[1]);
      if (first === 10) return false;
      if (first === 172 && second >= 16 && second <= 31) return false;
      if (first === 192 && second === 168) return false;
      if (first === 127) return false;
      if (first === 169 && second === 254) return false;
    }
    return true;
  } catch {
    return false;
  }
}

export async function sendAlerts(
  channels: AlertChannel[],
  summary: string,
  severity: Severity,
  details: Record<string, unknown>
): Promise<void> {
  const enabledChannels = channels.filter(c => c.enabled);

  if (enabledChannels.length === 0) {
    console.warn("[guardian] No enabled alert channels configured");
    return;
  }

  const promises = enabledChannels.map(channel => {
    switch (channel.type) {
      case "pagerduty":
        return alertPagerDuty(channel, summary, severity, details);
      case "discord":
        return alertDiscord(channel, summary, severity, details);
      case "slack":
        return alertSlack(channel, summary, severity, details);
      case "webhook":
        return alertWebhook(channel, summary, severity, details);
      case "email":
        // TODO: implement email alerting (SendGrid/Resend)
        console.warn("[guardian] Email alerting not yet implemented");
        return Promise.resolve();
    }
  });

  await Promise.allSettled(promises);
}

async function alertPagerDuty(channel: AlertChannel, summary: string, severity: Severity, details: Record<string, unknown>): Promise<void> {
  const routingKey = channel.config.routingKey;
  if (!routingKey) return;

  const dedup = `guardian-${new Date().toISOString().split("T")[0]}`;
  const res = await fetch("https://events.pagerduty.com/v2/enqueue", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      routing_key: routingKey,
      event_action: "trigger",
      dedup_key: dedup,
      payload: {
        summary,
        source: "cloud-cost-guardian",
        severity,
        component: "cloud-monitoring",
        class: "billing",
        custom_details: details,
      },
      client: "Cloud Cost Guardian",
    }),
  });

  if (!res.ok) {
    console.error(`[guardian] PagerDuty error: ${res.status}`);
  }
}

async function alertDiscord(channel: AlertChannel, summary: string, severity: Severity, details: Record<string, unknown>): Promise<void> {
  const webhookUrl = channel.config.webhookUrl;
  if (!webhookUrl || !isUrlSafe(webhookUrl)) return;

  const colorMap = { critical: 0xFF0000, error: 0xFF6600, warning: 0xFFCC00, info: 0x0099FF };

  await fetch(webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      embeds: [{
        title: `Cloud Cost Alert [${severity.toUpperCase()}]`,
        description: summary,
        color: colorMap[severity],
        fields: Object.entries(details).slice(0, 8).map(([key, value]) => ({
          name: key,
          value: typeof value === "string" ? value : JSON.stringify(value).substring(0, 200),
          inline: false,
        })),
        timestamp: new Date().toISOString(),
      }],
    }),
  });
}

async function alertSlack(channel: AlertChannel, summary: string, severity: Severity, details: Record<string, unknown>): Promise<void> {
  const webhookUrl = channel.config.webhookUrl;
  if (!webhookUrl || !isUrlSafe(webhookUrl)) return;

  const emojiMap = { critical: ":rotating_light:", error: ":warning:", warning: ":large_yellow_circle:", info: ":information_source:" };

  await fetch(webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      text: `${emojiMap[severity]} *Cloud Cost Alert [${severity.toUpperCase()}]*\n${summary}`,
    }),
  });
}

async function alertWebhook(channel: AlertChannel, summary: string, severity: Severity, details: Record<string, unknown>): Promise<void> {
  const webhookUrl = channel.config.webhookUrl;
  if (!webhookUrl || !isUrlSafe(webhookUrl)) return;

  await fetch(webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ summary, severity, details, timestamp: new Date().toISOString(), source: "cloud-cost-guardian" }),
  });
}
