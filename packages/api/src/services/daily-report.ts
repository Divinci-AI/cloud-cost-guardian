/**
 * Daily Report Service
 *
 * Sends a 24-hour usage summary email to all guardian accounts that have
 * dailyReportEnabled: true. Runs once per day (see index.ts cron).
 *
 * Report includes:
 *   - 24h spend total and per-account breakdown
 *   - Kill switch actions taken
 *   - Alerts fired
 *   - Account health summary
 */

import { Resend } from "resend";
import { GuardianAccountModel } from "../models/guardian-account/schema.js";
import { CloudAccountModel } from "../models/cloud-account/schema.js";
import { getAnalyticsOverview, getAlertHistory } from "../globals/index.js";

export async function sendDailyReports(): Promise<void> {
  const accounts = await GuardianAccountModel.find({ "settings.dailyReportEnabled": true });

  if (accounts.length === 0) {
    console.error("[guardian] Daily report: no accounts with dailyReportEnabled");
    return;
  }

  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    console.warn("[guardian] Daily report: RESEND_API_KEY not configured — skipping");
    return;
  }

  console.error(`[guardian] Daily report: sending to ${accounts.length} account(s)`);

  const resend = new Resend(apiKey);
  const from = process.env.RESEND_FROM || "Kill Switch <alerts@kill-switch.net>";

  for (const account of accounts) {
    try {
      await sendReportForAccount(account as any, resend, from);
    } catch (err: any) {
      console.error(`[guardian] Daily report failed for ${account.name}:`, err.message);
    }
  }
}

async function sendReportForAccount(account: any, resend: Resend, from: string): Promise<void> {
  const orgId = account._id.toString();
  const timezone = account.settings?.timezone ?? "UTC";

  // Collect data
  const [analytics, cloudAccounts, recentAlerts] = await Promise.all([
    getAnalyticsOverview(orgId, 1).catch(() => null),
    CloudAccountModel.find({ guardianAccountId: orgId, status: "active" }),
    getAlertHistory(orgId, 10).catch(() => []),
  ]);

  const totalCost24h = analytics?.dailyCosts?.[0]?.cost ?? 0;
  const violations24h = analytics?.dailyCosts?.[0]?.violations ?? 0;
  const killActions = analytics?.killSwitchActions ?? 0;
  const breakdown = analytics?.accountBreakdown ?? [];

  // Determine recipient emails — all enabled email channels
  const emailChannels = account.alertChannels.filter(
    (c: any) => c.type === "email" && c.enabled && c.config?.email
  );

  if (emailChannels.length === 0) {
    console.warn(`[guardian] Daily report: no email channels for ${account.name} — skipping`);
    return;
  }

  const recipients = emailChannels.map((c: any) => c.config.email as string);
  const now = new Date();
  const dateStr = now.toLocaleDateString("en-US", { timeZone: timezone, year: "numeric", month: "long", day: "numeric" });

  // Build account rows
  const accountRowsHtml = cloudAccounts.length > 0
    ? cloudAccounts.map((ca: any) => {
        const acctBreakdown = breakdown.find(b => b.cloudAccountId === ca._id.toString());
        const cost = acctBreakdown ? `$${acctBreakdown.avgDailyCost.toFixed(2)}` : "—";
        const statusColor = ca.lastCheckStatus === "ok" ? "#4ade80" : ca.lastCheckStatus === "violation" ? "#ff6b6b" : "#9ca3af";
        const statusLabel = ca.lastCheckStatus ?? "unknown";
        return `<tr>
          <td style="padding:8px 12px;border-bottom:1px solid #1e2540;">${ca.name}</td>
          <td style="padding:8px 12px;border-bottom:1px solid #1e2540;text-transform:capitalize;">${ca.provider}</td>
          <td style="padding:8px 12px;border-bottom:1px solid #1e2540;color:${statusColor};font-weight:600;">${statusLabel}</td>
          <td style="padding:8px 12px;border-bottom:1px solid #1e2540;">${cost}</td>
        </tr>`;
      }).join("")
    : `<tr><td colspan="4" style="padding:12px;text-align:center;color:#6b7280;">No active cloud accounts</td></tr>`;

  // Recent alerts rows
  const alertRowsHtml = recentAlerts.slice(0, 5).map((a: any) => {
    const ts = new Date(a.created_at).toLocaleTimeString("en-US", { timeZone: timezone, hour: "2-digit", minute: "2-digit" });
    const sevColor = a.severity === "critical" ? "#ff6b6b" : a.severity === "warning" ? "#facc15" : "#9ca3af";
    return `<tr>
      <td style="padding:6px 12px;border-bottom:1px solid #1e2540;font-size:12px;color:#9ca3af;">${ts}</td>
      <td style="padding:6px 12px;border-bottom:1px solid #1e2540;font-size:12px;color:${sevColor};text-transform:uppercase;">${a.severity}</td>
      <td style="padding:6px 12px;border-bottom:1px solid #1e2540;font-size:12px;">${String(a.summary ?? "").substring(0, 80)}</td>
    </tr>`;
  }).join("");

  const statusSummary = violations24h > 0
    ? `<div style="background:rgba(255,107,107,0.08);border:1px solid rgba(255,107,107,0.2);border-radius:8px;padding:16px;margin-bottom:24px;">
        <p style="margin:0;color:#ff6b6b;font-weight:600;">⚠️ ${violations24h} threshold violation(s) detected in the last 24 hours</p>
        ${killActions > 0 ? `<p style="margin:8px 0 0;color:#9ca3af;font-size:13px;">Kill switch fired ${killActions} action(s) automatically.</p>` : ""}
      </div>`
    : `<div style="background:rgba(74,222,128,0.06);border:1px solid rgba(74,222,128,0.15);border-radius:8px;padding:16px;margin-bottom:24px;">
        <p style="margin:0;color:#4ade80;font-weight:600;">✓ All systems normal — no violations in the last 24 hours</p>
      </div>`;

  const html = `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="font-family:sans-serif;background:#0c1229;color:#c4c5ca;margin:0;padding:0;">
  <div style="max-width:600px;margin:32px auto;padding:32px;background:#111827;border-radius:12px;border:1px solid rgba(255,255,255,0.08);">

    <div style="display:flex;align-items:center;margin-bottom:24px;">
      <div>
        <h1 style="font-size:20px;color:#fff;margin:0 0 4px;">Kill Switch — Daily Report</h1>
        <p style="color:#9ca3af;font-size:13px;margin:0;">${dateStr} · ${account.name}</p>
      </div>
    </div>

    ${statusSummary}

    <!-- Spend overview -->
    <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px;margin-bottom:24px;">
      <div style="background:rgba(255,255,255,0.04);border-radius:8px;padding:16px;text-align:center;">
        <p style="color:#9ca3af;font-size:11px;text-transform:uppercase;margin:0 0 4px;">24h Spend</p>
        <p style="color:#fff;font-size:22px;font-weight:700;margin:0;">$${totalCost24h.toFixed(2)}</p>
      </div>
      <div style="background:rgba(255,255,255,0.04);border-radius:8px;padding:16px;text-align:center;">
        <p style="color:#9ca3af;font-size:11px;text-transform:uppercase;margin:0 0 4px;">Violations</p>
        <p style="color:${violations24h > 0 ? "#ff6b6b" : "#4ade80"};font-size:22px;font-weight:700;margin:0;">${violations24h}</p>
      </div>
      <div style="background:rgba(255,255,255,0.04);border-radius:8px;padding:16px;text-align:center;">
        <p style="color:#9ca3af;font-size:11px;text-transform:uppercase;margin:0 0 4px;">Kill Actions</p>
        <p style="color:#5ce2e7;font-size:22px;font-weight:700;margin:0;">${killActions}</p>
      </div>
    </div>

    <!-- Account table -->
    <h2 style="font-size:14px;color:#fff;margin:0 0 12px;text-transform:uppercase;letter-spacing:0.05em;">Cloud Accounts</h2>
    <table style="width:100%;border-collapse:collapse;font-size:13px;margin-bottom:24px;">
      <thead>
        <tr style="background:rgba(255,255,255,0.04);">
          <th style="padding:8px 12px;text-align:left;color:#6b7280;font-weight:500;">Account</th>
          <th style="padding:8px 12px;text-align:left;color:#6b7280;font-weight:500;">Provider</th>
          <th style="padding:8px 12px;text-align:left;color:#6b7280;font-weight:500;">Status</th>
          <th style="padding:8px 12px;text-align:left;color:#6b7280;font-weight:500;">Daily Cost</th>
        </tr>
      </thead>
      <tbody>${accountRowsHtml}</tbody>
    </table>

    ${recentAlerts.length > 0 ? `
    <!-- Recent alerts -->
    <h2 style="font-size:14px;color:#fff;margin:0 0 12px;text-transform:uppercase;letter-spacing:0.05em;">Recent Alerts</h2>
    <table style="width:100%;border-collapse:collapse;margin-bottom:24px;">
      <thead>
        <tr style="background:rgba(255,255,255,0.04);">
          <th style="padding:6px 12px;text-align:left;color:#6b7280;font-size:12px;font-weight:500;">Time</th>
          <th style="padding:6px 12px;text-align:left;color:#6b7280;font-size:12px;font-weight:500;">Severity</th>
          <th style="padding:6px 12px;text-align:left;color:#6b7280;font-size:12px;font-weight:500;">Summary</th>
        </tr>
      </thead>
      <tbody>${alertRowsHtml}</tbody>
    </table>` : ""}

    <!-- Footer -->
    <div style="border-top:1px solid rgba(255,255,255,0.06);padding-top:16px;display:flex;justify-content:space-between;align-items:center;">
      <p style="font-size:12px;color:#6b7280;margin:0;">
        <a href="https://app.kill-switch.net" style="color:#5ce2e7;text-decoration:none;">Open Dashboard</a> ·
        <a href="https://app.kill-switch.net/settings" style="color:#5ce2e7;text-decoration:none;">Manage Alerts</a>
      </p>
      <p style="font-size:12px;color:#4b5563;margin:0;">
        <a href="https://app.kill-switch.net/settings" style="color:#4b5563;text-decoration:none;">Unsubscribe</a>
      </p>
    </div>
  </div>
</body>
</html>`;

  const text = [
    `Kill Switch — Daily Report`,
    `${dateStr} · ${account.name}`,
    ``,
    `24h Spend: $${totalCost24h.toFixed(2)}`,
    `Violations: ${violations24h}`,
    `Kill Switch Actions: ${killActions}`,
    ``,
    `CLOUD ACCOUNTS`,
    ...cloudAccounts.map((ca: any) => {
      const b = breakdown.find(b => b.cloudAccountId === ca._id.toString());
      const cost = b ? `$${b.avgDailyCost.toFixed(2)}/day` : "—";
      return `  ${ca.name} (${ca.provider}) — ${ca.lastCheckStatus ?? "unknown"} — ${cost}`;
    }),
    ``,
    recentAlerts.length > 0 ? `RECENT ALERTS` : "",
    ...recentAlerts.slice(0, 5).map((a: any) => `  [${a.severity.toUpperCase()}] ${a.summary}`),
    ``,
    `Dashboard: https://app.kill-switch.net`,
    `Unsubscribe: https://app.kill-switch.net/settings`,
  ].filter(Boolean).join("\n");

  const subject = violations24h > 0
    ? `⚠️ Kill Switch Daily Report — ${violations24h} violation(s) · $${totalCost24h.toFixed(2)} spent`
    : `✓ Kill Switch Daily Report — All clear · $${totalCost24h.toFixed(2)} spent`;

  const { error } = await resend.emails.send({ from, to: recipients, subject, html, text });

  if (error) {
    console.error(`[guardian] Daily report email failed for ${account.name}:`, error.message);
  } else {
    console.error(`[guardian] Daily report sent for ${account.name} → ${recipients.join(", ")}`);
  }
}
