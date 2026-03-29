import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import {
  AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, ReferenceLine, BarChart, Bar, Cell,
} from "recharts";
import { api } from "../../api/client";
import { useOrg } from "../../context/OrgContext";

// ─── Types ──────────────────────────────────────────────────────────────────

interface CloudAccount {
  id: string;
  provider: string;
  name: string;
  status: string;
  lastCheckAt?: number;
  lastCheckStatus?: string;
  lastViolations?: string[];
}

export interface DailyCost {
  date: string;
  cost: number;
  services: number;
  violations: number;
}

interface AccountBreakdown {
  cloudAccountId: string;
  provider: string;
  totalCost: number;
  avgDailyCost: number;
}

interface AnalyticsOverview {
  dailyCosts: DailyCost[];
  totalSpendPeriod: number;
  avgDailyCost: number;
  projectedMonthlyCost: number;
  savingsEstimate: number;
  killSwitchActions: number;
  accountBreakdown: AccountBreakdown[];
}

// ─── Helpers ────────────────────────────────────────────────────────────────

export const fmt = (n: number) =>
  n >= 1000 ? `$${(n / 1000).toFixed(1)}k` : `$${n.toFixed(2)}`;

export const fmtFull = (n: number) =>
  `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export const shortDate = (d: string) => {
  const dt = new Date(d);
  return `${dt.getMonth() + 1}/${dt.getDate()}`;
};

const statusColor = (status?: string) => {
  if (status === "violation") return "#ff6b6b";
  if (status === "error") return "#ffa07a";
  if (status === "ok") return "#5ce2e7";
  return "#6b7280";
};

const timeAgo = (ts?: number) => {
  if (!ts) return "Never";
  const mins = Math.round((Date.now() - ts) / 60000);
  if (mins < 1) return "Just now";
  if (mins < 60) return `${mins}m ago`;
  if (mins < 1440) return `${Math.round(mins / 60)}h ago`;
  return `${Math.round(mins / 1440)}d ago`;
};

const providerLabel = (p: string) =>
  p === "cloudflare" ? "Cloudflare" : p === "gcp" ? "GCP" : p === "aws" ? "AWS" : p;

// Detect anomaly: cost > 2x the rolling average of previous 5 days
export function detectAnomalies(dailyCosts: DailyCost[]): Set<string> {
  const anomalies = new Set<string>();
  for (let i = 5; i < dailyCosts.length; i++) {
    const window = dailyCosts.slice(i - 5, i);
    const avg = window.reduce((s, d) => s + d.cost, 0) / window.length;
    if (avg > 0 && dailyCosts[i].cost > avg * 2) {
      anomalies.add(dailyCosts[i].date);
    }
  }
  return anomalies;
}

// ─── Stat Card ──────────────────────────────────────────────────────────────

function StatCard({ label, value, sub, accent }: { label: string; value: string; sub?: string; accent?: string }) {
  return (
    <div style={{
      padding: "20px 24px",
      background: "rgba(255,255,255,0.03)",
      border: "1px solid rgba(255,255,255,0.06)",
      borderRadius: "12px",
      flex: 1,
      minWidth: "200px",
    }}>
      <p style={{ color: "#6b7280", fontSize: "12px", textTransform: "uppercase", letterSpacing: "0.5px", margin: "0 0 8px" }}>{label}</p>
      <p style={{ color: accent || "#fff", fontSize: "28px", fontWeight: "700", fontFamily: "Outfit, sans-serif", margin: 0 }}>{value}</p>
      {sub && <p style={{ color: "#6b7280", fontSize: "12px", margin: "4px 0 0" }}>{sub}</p>}
    </div>
  );
}

// ─── Custom Tooltip ─────────────────────────────────────────────────────────

function ChartTooltip({ active, payload }: any) {
  if (!active || !payload?.length) return null;
  const data = payload[0].payload;
  const isForecast = data.isForecast;
  return (
    <div style={{
      background: "#1a1f3a",
      border: "1px solid rgba(255,255,255,0.12)",
      borderRadius: "8px",
      padding: "12px 16px",
      fontSize: "13px",
    }}>
      <p style={{ color: "#fff", fontWeight: "600", margin: "0 0 6px" }}>{new Date(data.date).toLocaleDateString()}</p>
      {isForecast ? (
        <p style={{ color: "#c25800", margin: "2px 0" }}>Projected: {fmtFull(data.forecast)}/day</p>
      ) : (
        <>
          <p style={{ color: "#5ce2e7", margin: "2px 0" }}>Cost: {fmtFull(data.cost)}</p>
          <p style={{ color: "#6b7280", margin: "2px 0" }}>Services: {data.services}</p>
          {data.violations > 0 && (
            <p style={{ color: "#ff6b6b", margin: "2px 0" }}>Violations: {data.violations}</p>
          )}
        </>
      )}
    </div>
  );
}

// ─── Main Dashboard ─────────────────────────────────────────────────────────

export function DashboardPage() {
  const { orgVersion } = useOrg();
  const [accounts, setAccounts] = useState<CloudAccount[]>([]);
  const [analytics, setAnalytics] = useState<AnalyticsOverview | null>(null);
  const [loading, setLoading] = useState(true);
  const [checking, setChecking] = useState(false);
  const [days, setDays] = useState(30);

  useEffect(() => {
    Promise.all([
      api.listCloudAccounts().catch(() => ({ accounts: [] })),
      api.getAnalyticsOverview(days).catch(() => null),
    ]).then(([accountsData, analyticsData]) => {
      setAccounts(accountsData.accounts || []);
      setAnalytics(analyticsData);
    }).finally(() => setLoading(false));
  }, [days, orgVersion]);

  const runManualCheck = async () => {
    setChecking(true);
    try {
      await api.runCheck();
      const [accountsData, analyticsData] = await Promise.all([
        api.listCloudAccounts(),
        api.getAnalyticsOverview(days),
      ]);
      setAccounts(accountsData.accounts || []);
      setAnalytics(analyticsData);
    } catch (e) {
      console.error(e);
    }
    setChecking(false);
  };

  if (loading) {
    return (
      <div style={{ display: "flex", justifyContent: "center", padding: "80px" }}>
        <p style={{ color: "#6b7280" }}>Loading dashboard...</p>
      </div>
    );
  }

  const anomalies = analytics ? detectAnomalies(analytics.dailyCosts) : new Set<string>();

  // Build chart data with forecast extension
  const chartData: any[] = analytics?.dailyCosts.map(d => ({
    ...d,
    dateLabel: shortDate(d.date),
    isAnomaly: anomalies.has(d.date),
  })) || [];

  const forecastDays = 7;
  if (analytics && analytics.dailyCosts.length >= 3) {
    const recent = analytics.dailyCosts.slice(-7);
    const avgRecent = recent.reduce((s, d) => s + d.cost, 0) / recent.length;

    // Bridge: add forecast value to last actual point so the lines connect
    if (chartData.length > 0) {
      chartData[chartData.length - 1].forecast = chartData[chartData.length - 1].cost;
    }

    const lastDate = new Date(analytics.dailyCosts[analytics.dailyCosts.length - 1].date);
    for (let i = 1; i <= forecastDays; i++) {
      const d = new Date(lastDate);
      d.setDate(d.getDate() + i);
      chartData.push({
        date: d.toISOString().split("T")[0],
        // cost is undefined so the actual area doesn't draw to zero
        services: 0,
        violations: 0,
        dateLabel: shortDate(d.toISOString()),
        isAnomaly: false,
        forecast: avgRecent,
        isForecast: true,
      });
    }
  }

  const hasData = analytics && analytics.dailyCosts.length > 0;

  return (
    <div>
      {/* Header */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "28px" }}>
        <div>
          <h1 style={{ fontFamily: "Outfit, sans-serif", fontSize: "28px", fontWeight: "700", color: "#fff", margin: 0 }}>
            Cost Dashboard
          </h1>
          <p style={{ color: "#6b7280", marginTop: "4px", fontSize: "14px" }}>
            {accounts.length} cloud account{accounts.length !== 1 ? "s" : ""} monitored
          </p>
        </div>
        <div style={{ display: "flex", gap: "12px", alignItems: "center" }}>
          {/* Period selector */}
          <select
            value={days}
            onChange={e => setDays(Number(e.target.value))}
            style={{
              background: "rgba(255,255,255,0.08)",
              color: "#fff",
              border: "1px solid rgba(255,255,255,0.15)",
              padding: "8px 12px",
              borderRadius: "8px",
              fontSize: "14px",
              cursor: "pointer",
            }}
          >
            <option value={7}>7 days</option>
            <option value={14}>14 days</option>
            <option value={30}>30 days</option>
            <option value={90}>90 days</option>
          </select>
          <button
            onClick={runManualCheck}
            disabled={checking}
            style={{
              background: "rgba(255,255,255,0.08)",
              color: "#fff",
              border: "1px solid rgba(255,255,255,0.15)",
              padding: "8px 20px",
              borderRadius: "8px",
              cursor: "pointer",
              fontSize: "14px",
            }}
          >
            {checking ? "Checking..." : "Run Check"}
          </button>
          <Link
            to="/accounts/connect/cloudflare"
            style={{
              background: "#c25800",
              color: "#fff",
              padding: "8px 20px",
              borderRadius: "8px",
              textDecoration: "none",
              fontSize: "14px",
              fontWeight: "600",
              display: "flex",
              alignItems: "center",
            }}
          >
            + Connect Account
          </Link>
        </div>
      </div>

      {/* ─── Stat Cards ──────────────────────────────────────────────── */}
      {hasData ? (
        <>
          <div style={{ display: "flex", gap: "16px", marginBottom: "28px", flexWrap: "wrap" }}>
            <StatCard
              label="Total Spend"
              value={fmtFull(analytics.totalSpendPeriod)}
              sub={`Last ${days} days`}
            />
            <StatCard
              label="Projected Monthly"
              value={fmtFull(analytics.projectedMonthlyCost)}
              sub={`Based on ${fmtFull(analytics.avgDailyCost)}/day avg`}
              accent={analytics.projectedMonthlyCost > 100 ? "#ffa07a" : "#5ce2e7"}
            />
            <StatCard
              label="Savings from Kill Switch"
              value={analytics.savingsEstimate > 0 ? fmtFull(analytics.savingsEstimate) : "--"}
              sub={analytics.killSwitchActions > 0
                ? `${analytics.killSwitchActions} runaway service${analytics.killSwitchActions !== 1 ? "s" : ""} stopped`
                : "No actions taken yet"}
              accent="#4ade80"
            />
            <StatCard
              label="Active Accounts"
              value={String(accounts.length)}
              sub={`${accounts.filter(a => a.lastCheckStatus === "ok").length} healthy`}
            />
          </div>

          {/* ─── Cost Trend Chart ──────────────────────────────────────── */}
          <div style={{
            background: "rgba(255,255,255,0.03)",
            border: "1px solid rgba(255,255,255,0.06)",
            borderRadius: "12px",
            padding: "24px",
            marginBottom: "28px",
          }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "20px" }}>
              <h2 style={{ fontFamily: "Outfit, sans-serif", fontSize: "18px", fontWeight: "600", color: "#fff", margin: 0 }}>
                Daily Spend
              </h2>
              {anomalies.size > 0 && (
                <span style={{
                  fontSize: "12px",
                  padding: "4px 10px",
                  borderRadius: "4px",
                  background: "rgba(255,107,107,0.12)",
                  color: "#ff6b6b",
                  fontWeight: "600",
                }}>
                  {anomalies.size} anomal{anomalies.size === 1 ? "y" : "ies"} detected
                </span>
              )}
            </div>

            <ResponsiveContainer width="100%" height={300}>
              <AreaChart data={chartData} margin={{ top: 5, right: 20, bottom: 5, left: 10 }}>
                <defs>
                  <linearGradient id="costGradient" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="#5ce2e7" stopOpacity={0.3} />
                    <stop offset="100%" stopColor="#5ce2e7" stopOpacity={0} />
                  </linearGradient>
                  <linearGradient id="forecastGradient" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="#c25800" stopOpacity={0.2} />
                    <stop offset="100%" stopColor="#c25800" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
                <XAxis
                  dataKey="dateLabel"
                  stroke="#6b7280"
                  fontSize={11}
                  tickLine={false}
                  axisLine={false}
                />
                <YAxis
                  stroke="#6b7280"
                  fontSize={11}
                  tickLine={false}
                  axisLine={false}
                  tickFormatter={(v: number) => fmt(v)}
                />
                <Tooltip content={<ChartTooltip />} />
                {/* Average line */}
                <ReferenceLine
                  y={analytics.avgDailyCost}
                  stroke="#6b7280"
                  strokeDasharray="4 4"
                  label={{ value: `avg ${fmt(analytics.avgDailyCost)}`, position: "right", fill: "#6b7280", fontSize: 11 }}
                />
                {/* Anomaly markers */}
                {Array.from(anomalies).map(date => (
                  <ReferenceLine
                    key={date}
                    x={shortDate(date)}
                    stroke="#ff6b6b"
                    strokeDasharray="2 2"
                    strokeOpacity={0.5}
                  />
                ))}
                {/* Actual cost area */}
                <Area
                  type="monotone"
                  dataKey="cost"
                  stroke="#5ce2e7"
                  strokeWidth={2}
                  fill="url(#costGradient)"
                  dot={false}
                  activeDot={{ r: 4, fill: "#5ce2e7" }}
                />
                {/* Forecast area */}
                <Area
                  type="monotone"
                  dataKey="forecast"
                  stroke="#c25800"
                  strokeWidth={2}
                  strokeDasharray="6 3"
                  fill="url(#forecastGradient)"
                  dot={false}
                  connectNulls={false}
                />
              </AreaChart>
            </ResponsiveContainer>

            <div style={{ display: "flex", gap: "24px", justifyContent: "center", marginTop: "12px", fontSize: "12px", color: "#6b7280" }}>
              <span><span style={{ display: "inline-block", width: "12px", height: "3px", background: "#5ce2e7", borderRadius: "2px", marginRight: "6px", verticalAlign: "middle" }} />Actual</span>
              <span><span style={{ display: "inline-block", width: "12px", height: "3px", background: "#c25800", borderRadius: "2px", marginRight: "6px", verticalAlign: "middle", borderTop: "1px dashed #c25800" }} />Forecast</span>
              <span><span style={{ display: "inline-block", width: "12px", height: "3px", background: "#6b7280", borderRadius: "2px", marginRight: "6px", verticalAlign: "middle" }} />Average</span>
              {anomalies.size > 0 && (
                <span><span style={{ display: "inline-block", width: "8px", height: "8px", background: "rgba(255,107,107,0.3)", border: "1px solid #ff6b6b", borderRadius: "2px", marginRight: "6px", verticalAlign: "middle" }} />Anomaly</span>
              )}
            </div>
          </div>

          {/* ─── Forecast Banner ───────────────────────────────────────── */}
          <div style={{
            background: "linear-gradient(135deg, rgba(194,88,0,0.12), rgba(92,226,231,0.06))",
            border: "1px solid rgba(194,88,0,0.25)",
            borderRadius: "12px",
            padding: "20px 24px",
            marginBottom: "28px",
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
          }}>
            <div>
              <p style={{ color: "#fff", fontSize: "16px", fontWeight: "600", margin: "0 0 4px", fontFamily: "Outfit, sans-serif" }}>
                On track to spend {fmtFull(analytics.projectedMonthlyCost)} this month
              </p>
              <p style={{ color: "#6b7280", fontSize: "13px", margin: 0 }}>
                Based on {fmtFull(analytics.avgDailyCost)}/day average over {analytics.dailyCosts.length} day{analytics.dailyCosts.length !== 1 ? "s" : ""} of data
              </p>
            </div>
            {analytics.savingsEstimate > 0 && (
              <div style={{ textAlign: "right" }}>
                <p style={{ color: "#4ade80", fontSize: "14px", fontWeight: "600", margin: "0 0 2px" }}>
                  {fmtFull(analytics.savingsEstimate)} saved
                </p>
                <p style={{ color: "#6b7280", fontSize: "12px", margin: 0 }}>by Kill Switch actions</p>
              </div>
            )}
          </div>

          {/* ─── Account Breakdown ─────────────────────────────────────── */}
          {analytics.accountBreakdown.length > 0 && (
            <div style={{
              background: "rgba(255,255,255,0.03)",
              border: "1px solid rgba(255,255,255,0.06)",
              borderRadius: "12px",
              padding: "24px",
              marginBottom: "28px",
            }}>
              <h2 style={{ fontFamily: "Outfit, sans-serif", fontSize: "18px", fontWeight: "600", color: "#fff", margin: "0 0 16px" }}>
                Spend by Account
              </h2>
              <ResponsiveContainer width="100%" height={Math.max(120, analytics.accountBreakdown.length * 48)}>
                <BarChart
                  data={analytics.accountBreakdown.map(a => ({
                    ...a,
                    name: accounts.find(acc => acc.id === a.cloudAccountId)?.name || a.cloudAccountId.slice(0, 8),
                    label: `${providerLabel(a.provider)} — ${fmtFull(a.totalCost)}`,
                  }))}
                  layout="vertical"
                  margin={{ top: 0, right: 20, bottom: 0, left: 120 }}
                >
                  <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" horizontal={false} />
                  <XAxis type="number" stroke="#6b7280" fontSize={11} tickFormatter={(v: number) => fmt(v)} />
                  <YAxis type="category" dataKey="name" stroke="#6b7280" fontSize={12} width={110} />
                  <Tooltip
                    formatter={(value: number) => [fmtFull(value), "Total Spend"]}
                    contentStyle={{ background: "#1a1f3a", border: "1px solid rgba(255,255,255,0.12)", borderRadius: "8px", fontSize: "13px" }}
                  />
                  <Bar dataKey="totalCost" radius={[0, 4, 4, 0]}>
                    {analytics.accountBreakdown.map((entry, i) => (
                      <Cell key={i} fill={entry.provider === "cloudflare" ? "#f6821f" : entry.provider === "gcp" ? "#4285f4" : "#ff9900"} fillOpacity={0.8} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}
        </>
      ) : (
        /* ─── No Data State ──────────────────────────────────────────── */
        accounts.length === 0 ? (
        <div style={{
          background: "rgba(255,255,255,0.03)",
          border: "1px solid rgba(255,255,255,0.06)",
          borderRadius: "12px",
          padding: "48px 32px",
          textAlign: "center",
          marginBottom: "28px",
        }}>
          <div style={{ fontSize: "48px", marginBottom: "16px" }}>&#9889;</div>
          <h2 style={{ fontFamily: "Outfit, sans-serif", color: "#fff", marginBottom: "8px", fontSize: "22px" }}>
            Connect your first cloud account
          </h2>
          <p style={{ color: "#6b7280", marginBottom: "28px", maxWidth: "440px", margin: "0 auto 28px", fontSize: "15px", lineHeight: "1.6" }}>
            Kill Switch monitors your cloud spending and auto-kills runaway services before the bill arrives.
          </p>
          <div style={{ display: "flex", gap: "12px", justifyContent: "center", flexWrap: "wrap", marginBottom: "28px" }}>
            {[
              { id: "cloudflare", name: "Cloudflare", color: "#f6821f" },
              { id: "gcp", name: "Google Cloud", color: "#4285f4" },
              { id: "aws", name: "AWS", color: "#ff9900" },
              { id: "runpod", name: "RunPod", color: "#673ab7" },
            ].map(p => (
              <Link key={p.id} to={`/accounts/connect/${p.id}`} style={{
                display: "flex", alignItems: "center", gap: "10px",
                padding: "14px 22px", borderRadius: "10px",
                background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.08)",
                textDecoration: "none", transition: "border-color 0.2s, background 0.2s",
              }}
              onMouseEnter={e => { (e.currentTarget.style.borderColor as any) = `${p.color}55`; e.currentTarget.style.background = `${p.color}0a`; }}
              onMouseLeave={e => { e.currentTarget.style.borderColor = "rgba(255,255,255,0.08)"; e.currentTarget.style.background = "rgba(255,255,255,0.04)"; }}
              >
                <div style={{ width: "10px", height: "10px", borderRadius: "50%", background: p.color }} />
                <span style={{ color: "#fff", fontWeight: "600", fontSize: "14px" }}>{p.name}</span>
              </Link>
            ))}
          </div>
          <Link
            to="/accounts/connect"
            style={{ background: "linear-gradient(135deg, #c25800, #e06800)", color: "#fff", padding: "12px 28px", borderRadius: "8px", textDecoration: "none", fontWeight: "700", fontSize: "15px", display: "inline-block" }}
          >
            Connect Cloud Account
          </Link>
        </div>
        ) : (
        <div style={{
          background: "rgba(255,255,255,0.03)",
          border: "1px solid rgba(255,255,255,0.06)",
          borderRadius: "12px",
          padding: "48px 24px",
          textAlign: "center",
          marginBottom: "28px",
        }}>
          <p style={{ fontSize: "36px", marginBottom: "12px" }}>&#128200;</p>
          <h2 style={{ fontFamily: "Outfit, sans-serif", color: "#fff", marginBottom: "8px" }}>
            No cost data yet
          </h2>
          <p style={{ color: "#6b7280", marginBottom: "20px" }}>
            Cost data will appear here after your first monitoring check.
          </p>
          <button
            onClick={runManualCheck}
            disabled={checking}
            style={{ background: "#c25800", color: "#fff", border: "none", padding: "10px 24px", borderRadius: "8px", cursor: "pointer", fontSize: "14px", fontWeight: "600" }}
          >
            {checking ? "Running..." : "Run First Check"}
          </button>
        </div>
        )
      )}

      {/* ─── Account Status Cards ────────────────────────────────────── */}
      {accounts.length > 0 && (
        <>
          <h2 style={{ fontFamily: "Outfit, sans-serif", fontSize: "18px", fontWeight: "600", color: "#fff", margin: "0 0 16px" }}>
            Account Status
          </h2>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(320px, 1fr))", gap: "16px" }}>
            {accounts.map(account => (
              <div
                key={account.id}
                style={{
                  padding: "20px 24px",
                  background: "rgba(255,255,255,0.03)",
                  border: "1px solid rgba(255,255,255,0.06)",
                  borderRadius: "12px",
                  borderLeft: `3px solid ${statusColor(account.lastCheckStatus)}`,
                }}
              >
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "10px" }}>
                  <h3 style={{ fontFamily: "Outfit, sans-serif", fontSize: "16px", color: "#fff", margin: 0 }}>{account.name}</h3>
                  <span style={{
                    fontSize: "11px",
                    padding: "2px 8px",
                    borderRadius: "4px",
                    background: `${statusColor(account.lastCheckStatus)}22`,
                    color: statusColor(account.lastCheckStatus),
                    fontWeight: "600",
                    textTransform: "uppercase",
                  }}>
                    {account.lastCheckStatus || "pending"}
                  </span>
                </div>
                <div style={{ display: "flex", gap: "16px", fontSize: "13px", color: "#6b7280" }}>
                  <span>{providerLabel(account.provider)}</span>
                  <span>Checked: {timeAgo(account.lastCheckAt)}</span>
                </div>
                {account.lastViolations && account.lastViolations.length > 0 && (
                  <div style={{
                    marginTop: "10px",
                    padding: "8px 12px",
                    background: "rgba(255,107,107,0.08)",
                    borderRadius: "6px",
                    fontSize: "12px",
                    color: "#ff6b6b",
                  }}>
                    {account.lastViolations.map((v, i) => <div key={i}>{v}</div>)}
                  </div>
                )}
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
