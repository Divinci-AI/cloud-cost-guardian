/**
 * Alerting Service
 *
 * Sends alerts to configured channels (PagerDuty, Discord, Slack, email, webhook).
 * Reuses the same alerting logic from the open-source kill switch.
 */

import { Resend } from "resend";
import type { AlertChannel } from "../models/guardian-account/schema.js";

type Severity = "critical" | "error" | "warning" | "info";

const GITHUB_API_HOST = "api.github.com";

/** Base URL of the dashboard, used to build deep links in alerts. */
const APP_BASE_URL = (process.env.APP_BASE_URL || "https://app.kill-switch.net").replace(/\/$/, "");

/**
 * Escape the three characters Slack treats as control sequences in mrkdwn.
 * Without this, an attacker-influenced field (service/metric/account name) could
 * inject a clickable <url|phish> link or a <!here>/<!channel> mass-mention.
 * See: https://api.slack.com/reference/surfaces/formatting#escaping
 */
function escapeSlack(s: unknown): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * SSRF Protection: Validate webhook URLs are safe to call.
 * Blocks private/internal IPs and non-HTTPS URLs.
 * Explicitly allows api.github.com for the remediation channel.
 */
function isUrlSafe(urlString: string): boolean {
  try {
    const url = new URL(urlString);
    // Only allow HTTPS
    if (url.protocol !== "https:") return false;
    // Explicitly allow GitHub API
    if (url.hostname === GITHUB_API_HOST) return true;
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
      case "github":
        return alertGitHub(channel, summary, severity, details);
      case "email":
        return alertEmail(channel, summary, severity, details);
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
        source: "kill-switch",
        severity,
        component: "cloud-monitoring",
        class: "billing",
        custom_details: details,
      },
      client: "Kill Switch",
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
  const emoji = emojiMap[severity];

  // Deep link to where the responder can act. We don't have per-account routes
  // yet, so point at the accounts list (kill controls) or the alerts history.
  const cloudAccountId = details.cloudAccountId ? String(details.cloudAccountId) : "";
  const actionUrl = `${APP_BASE_URL}/accounts`;
  const historyUrl = `${APP_BASE_URL}/alerts`;

  // Header + summary. Every interpolated string is escaped so a hostile
  // service/metric/account name can't smuggle a link or @here mention.
  const blocks: Array<Record<string, unknown>> = [
    {
      type: "section",
      text: { type: "mrkdwn", text: `${emoji} *Cloud Cost Alert [${severity.toUpperCase()}]*\n${escapeSlack(summary)}` },
    },
  ];

  // Context line: provider / account / daily cost.
  const contextBits: string[] = [];
  if (details.provider) contextBits.push(`*Provider:* ${escapeSlack(details.provider)}`);
  if (details.accountName) contextBits.push(`*Account:* ${escapeSlack(details.accountName)}`);
  if (typeof details.totalEstimatedDailyCost === "number") {
    contextBits.push(`*Est. daily:* $${(details.totalEstimatedDailyCost as number).toFixed(2)}`);
  }
  if (contextBits.length > 0) {
    blocks.push({ type: "context", elements: [{ type: "mrkdwn", text: contextBits.join("  ·  ") }] });
  }

  // Per-violation breakdown (service / metric / value vs limit / ×over), capped.
  const violations = (details.violations as any[] | undefined) ?? [];
  const MAX_ROWS = 10;
  if (violations.length > 0) {
    const rows = violations.slice(0, MAX_ROWS).map((v: any) => {
      const mult = v.threshold > 0 ? ` _(${Math.round(v.currentValue / v.threshold)}×)_` : "";
      return `• *${escapeSlack(v.serviceName)}* — ${escapeSlack(v.metricName)}: ${escapeSlack(v.currentValue)} (limit ${escapeSlack(v.threshold)})${mult}`;
    });
    if (violations.length > MAX_ROWS) rows.push(`…and ${violations.length - MAX_ROWS} more`);
    blocks.push({ type: "section", text: { type: "mrkdwn", text: rows.join("\n") } });
  }

  // What the kill switch already did, if anything.
  const actionsTaken = (details.actionsTaken as string[] | undefined) ?? [];
  if (actionsTaken.length > 0) {
    blocks.push({
      type: "context",
      elements: [{ type: "mrkdwn", text: `:white_check_mark: *Action taken:* ${escapeSlack(actionsTaken.join(", "))}` }],
    });
  }

  // Action buttons — one-click into the dashboard.
  blocks.push({
    type: "actions",
    elements: [
      { type: "button", text: { type: "plain_text", text: "Open in Kill Switch" }, url: actionUrl, style: "primary" },
      { type: "button", text: { type: "plain_text", text: "Alert history" }, url: historyUrl },
    ],
  });

  await fetch(webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      // Plain-text fallback (notifications, screen readers, clients without Block Kit).
      text: `${emoji} Cloud Cost Alert [${severity.toUpperCase()}]\n${escapeSlack(summary)}`,
      blocks,
    }),
  });
}

async function alertWebhook(channel: AlertChannel, summary: string, severity: Severity, details: Record<string, unknown>): Promise<void> {
  const webhookUrl = channel.config.webhookUrl;
  if (!webhookUrl || !isUrlSafe(webhookUrl)) return;

  await fetch(webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ summary, severity, details, timestamp: new Date().toISOString(), source: "kill-switch" }),
  });
}

/**
 * Email Channel (Resend)
 *
 * Sends a plain-text + HTML alert email to the configured address.
 * Requires RESEND_API_KEY env var and a verified sender domain.
 * From address: RESEND_FROM env var (default: "Kill Switch <alerts@kill-switch.net>")
 */
async function alertEmail(channel: AlertChannel, summary: string, severity: Severity, details: Record<string, unknown>): Promise<void> {
  const toEmail = channel.config.email;
  if (!toEmail) {
    console.warn("[guardian] Email channel misconfigured — missing email address");
    return;
  }

  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    console.warn("[guardian] RESEND_API_KEY not configured — skipping email alert");
    return;
  }

  const from = process.env.RESEND_FROM || "Kill Switch <alerts@kill-switch.net>";
  const severityEmoji = { critical: "🚨", error: "⚠️", warning: "🟡", info: "ℹ️" }[severity] ?? "🔔";
  const subject = `${severityEmoji} Kill Switch [${severity.toUpperCase()}]: ${summary}`;

  // Build HTML body
  const violations = (details.violations as any[] | undefined) ?? [];
  const violationRows = violations.map((v: any) => {
    const multiplier = v.threshold > 0 ? `${Math.round(v.currentValue / v.threshold)}×` : "";
    return `<tr>
      <td style="padding:6px 12px;border-bottom:1px solid #2a2f4a;">${v.serviceName ?? ""}</td>
      <td style="padding:6px 12px;border-bottom:1px solid #2a2f4a;">${v.metricName ?? ""}</td>
      <td style="padding:6px 12px;border-bottom:1px solid #2a2f4a;color:#ff6b6b;">${v.currentValue ?? ""}</td>
      <td style="padding:6px 12px;border-bottom:1px solid #2a2f4a;">${v.threshold ?? ""}</td>
      <td style="padding:6px 12px;border-bottom:1px solid #2a2f4a;font-weight:bold;color:#ff6b6b;">${multiplier}</td>
    </tr>`;
  }).join("");

  const actionsTaken = (details.actionsTaken as string[] | undefined) ?? [];
  const actionsHtml = actionsTaken.length > 0
    ? `<p style="color:#4ade80;"><strong>Kill Switch action taken:</strong> ${actionsTaken.join(", ")}</p>`
    : "";

  const html = `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="font-family:sans-serif;background:#0c1229;color:#c4c5ca;margin:0;padding:0;">
  <div style="max-width:600px;margin:32px auto;padding:32px;background:#111827;border-radius:12px;border:1px solid rgba(255,255,255,0.08);">
    <h1 style="font-size:22px;color:#fff;margin:0 0 8px;">
      ${severityEmoji} Kill Switch Alert
    </h1>
    <p style="color:#9ca3af;margin:0 0 24px;font-size:13px;">
      ${new Date().toUTCString()}
    </p>

    <div style="background:rgba(255,107,107,0.08);border:1px solid rgba(255,107,107,0.2);border-radius:8px;padding:16px;margin-bottom:24px;">
      <p style="color:#fff;font-size:15px;font-weight:600;margin:0 0 4px;">${summary}</p>
      <p style="color:#9ca3af;font-size:13px;margin:0;">
        Provider: <strong style="color:#fff;">${String(details.provider ?? "")}</strong> ·
        Account: <strong style="color:#fff;">${String(details.accountName ?? "")}</strong> ·
        Severity: <strong style="color:#ff6b6b;">${severity}</strong>
      </p>
    </div>

    ${actionsHtml}

    ${violations.length > 0 ? `
    <h2 style="font-size:15px;color:#fff;margin:0 0 12px;">Threshold Violations</h2>
    <table style="width:100%;border-collapse:collapse;font-size:13px;margin-bottom:24px;">
      <thead>
        <tr style="background:rgba(255,255,255,0.05);">
          <th style="padding:8px 12px;text-align:left;color:#9ca3af;">Service</th>
          <th style="padding:8px 12px;text-align:left;color:#9ca3af;">Metric</th>
          <th style="padding:8px 12px;text-align:left;color:#9ca3af;">Value</th>
          <th style="padding:8px 12px;text-align:left;color:#9ca3af;">Limit</th>
          <th style="padding:8px 12px;text-align:left;color:#9ca3af;">Over</th>
        </tr>
      </thead>
      <tbody>${violationRows}</tbody>
    </table>` : ""}

    <p style="font-size:12px;color:#6b7280;margin:24px 0 0;border-top:1px solid rgba(255,255,255,0.06);padding-top:16px;">
      Sent by <a href="https://kill-switch.net" style="color:#5ce2e7;text-decoration:none;">Kill Switch</a>.
      Manage your alert channels at
      <a href="https://app.kill-switch.net/settings" style="color:#5ce2e7;text-decoration:none;">app.kill-switch.net/settings</a>.
    </p>
  </div>
</body>
</html>`;

  // Plain-text fallback
  const text = [
    `Kill Switch Alert [${severity.toUpperCase()}]`,
    ``,
    summary,
    ``,
    `Provider: ${details.provider ?? ""}`,
    `Account: ${details.accountName ?? ""}`,
    actionsTaken.length > 0 ? `Action taken: ${actionsTaken.join(", ")}` : "",
    ``,
    violations.length > 0 ? "Violations:" : "",
    ...violations.map((v: any) => {
      const mult = v.threshold > 0 ? ` (${Math.round(v.currentValue / v.threshold)}×)` : "";
      return `  ${v.serviceName}: ${v.metricName} = ${v.currentValue} (limit: ${v.threshold})${mult}`;
    }),
    ``,
    `Manage alerts: https://app.kill-switch.net/settings`,
  ].filter(l => l !== undefined).join("\n");

  const resend = new Resend(apiKey);
  const { error } = await resend.emails.send({ from, to: [toEmail], subject, html, text });

  if (error) {
    console.error(`[guardian] Email alert failed: ${error.message}`);
  } else {
    console.log(`[guardian] Email alert sent to ${toEmail}`);
  }
}

/**
 * GitHub Remediation Channel
 *
 * Triggers a workflow_dispatch on the user's repository so Claude Code can
 * analyze the codebase and open a PR fixing the root cause of the violation.
 *
 * Required PAT scopes: repo + workflow
 * (Fine-grained: Actions:write, Contents:write, Pull-requests:write)
 */
async function alertGitHub(channel: AlertChannel, summary: string, severity: Severity, details: Record<string, unknown>): Promise<void> {
  const { githubToken, repoOwner, repoName, workflowFile, branchRef = "main" } = channel.config;
  if (!githubToken || !repoOwner || !repoName || !workflowFile) {
    console.warn("[guardian] GitHub remediation channel misconfigured — skipping");
    return;
  }

  // Build structured violation list from details
  const violations = (details.violations as any[] | undefined) ?? [];
  const violationsSummary = violations.map((v: any) => ({
    serviceName: String(v.serviceName ?? ""),
    metricName: String(v.metricName ?? ""),
    currentValue: v.currentValue,
    threshold: v.threshold,
    multiplier: v.threshold > 0 ? `${Math.round(v.currentValue / v.threshold)}x` : "N/A",
    severity: v.severity,
  }));

  // Dedup key scoped to cloud account + calendar day so callers can guard
  // against duplicate runs if the same violation fires across multiple checks.
  const today = new Date().toISOString().split("T")[0];
  const cloudAccountId = String(details.cloudAccountId ?? details.accountName ?? "unknown");
  const dedupKey = `${cloudAccountId}:${today}`;

  // GitHub Actions workflow_dispatch inputs must all be strings
  const inputs: Record<string, string> = {
    provider:             String(details.provider ?? ""),
    account_name:         String(details.accountName ?? ""),
    severity,
    violation_count:      String(violations.length),
    violations_json:      JSON.stringify(violationsSummary),
    kill_switch_action:   String((details.actionsTaken as string[] | undefined)?.[0] ?? "none"),
    dedup_key:            dedupKey,
  };

  const url = `https://${GITHUB_API_HOST}/repos/${repoOwner}/${repoName}/actions/workflows/${workflowFile}/dispatches`;

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Accept": "application/vnd.github+json",
      "Authorization": `Bearer ${githubToken}`,
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ ref: branchRef, inputs }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    console.error(`[guardian] GitHub remediation dispatch failed: ${res.status} ${body}`);
  } else {
    console.log(`[guardian] GitHub remediation triggered: ${repoOwner}/${repoName} @ ${workflowFile} (dedup: ${dedupKey})`);
  }
}
