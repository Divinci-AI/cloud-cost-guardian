import { useEffect, useState } from "react";
import { api } from "../../api/client";
import { useOrg } from "../../context/OrgContext";

const ACTION_LABELS: Record<string, string> = {
  "cloud_account.create": "Connected cloud account",
  "cloud_account.update": "Updated cloud account",
  "cloud_account.delete": "Disconnected cloud account",
  "rule.create": "Created rule",
  "rule.update": "Updated rule",
  "rule.delete": "Deleted rule",
  "rule.toggle": "Toggled rule",
  "kill_switch.trigger": "Triggered kill switch",
  "kill_switch.advance": "Advanced kill sequence",
  "kill_switch.abort": "Aborted kill sequence",
  "team.invite": "Sent team invite",
  "team.join": "Joined team",
  "team.remove": "Removed team member",
  "team.role_change": "Changed member role",
  "settings.update": "Updated settings",
  "alert_channel.update": "Updated alert channels",
  "api_key.create": "Created API key",
  "api_key.roll": "Rotated API key",
  "api_key.revoke": "Revoked API key",
  "billing.checkout": "Started checkout",
  "billing.tier_change": "Changed plan",
  "org.create": "Created organization",
  "org.update": "Updated organization",
  "org.delete": "Deleted organization",
};

const ACTION_FILTER_OPTIONS = [
  { value: "", label: "All actions" },
  { value: "cloud_account", label: "Cloud accounts" },
  { value: "rule", label: "Rules" },
  { value: "kill_switch", label: "Kill switch" },
  { value: "team", label: "Team" },
  { value: "api_key", label: "API keys" },
  { value: "settings", label: "Settings" },
  { value: "org", label: "Organization" },
];

export function ActivityPage() {
  const { activeOrg, orgVersion } = useOrg();
  const [entries, setEntries] = useState<any[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [actionFilter, setActionFilter] = useState("");
  const limit = 25;

  const isTierGated = !activeOrg || (activeOrg.tier !== "team" && activeOrg.tier !== "enterprise");

  useEffect(() => {
    if (isTierGated || !activeOrg) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setError("");
    const params: any = { page, limit };
    if (actionFilter) {
      params.action = actionFilter; // Filter by action prefix
    }
    api.getActivity(params)
      .then(data => {
        setEntries(data.entries || []);
        setTotal(data.total || 0);
      })
      .catch(err => setError(err.message))
      .finally(() => setLoading(false));
  }, [page, actionFilter, activeOrg, isTierGated, orgVersion]);

  if (isTierGated) {
    return (
      <div>
        <h1 style={{ fontSize: "24px", fontWeight: 600, color: "#fff", marginBottom: "16px" }}>Activity Log</h1>
        <div style={{ background: "rgba(255,255,255,0.04)", borderRadius: "12px", padding: "40px", textAlign: "center" }}>
          <p style={{ fontSize: "16px", color: "#c4c5ca", marginBottom: "12px" }}>
            Activity tracking is available on the Team and Enterprise plans.
          </p>
          <a href="/billing" style={{ color: "#5ce2e7", textDecoration: "none", fontWeight: 600 }}>
            Upgrade to Team &rarr;
          </a>
        </div>
      </div>
    );
  }

  const totalPages = Math.ceil(total / limit);

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "20px" }}>
        <h1 style={{ fontSize: "24px", fontWeight: 600, color: "#fff", margin: 0 }}>Activity Log</h1>
        <select
          value={actionFilter}
          onChange={e => { setActionFilter(e.target.value); setPage(1); }}
          style={{
            background: "rgba(255,255,255,0.06)",
            border: "1px solid rgba(255,255,255,0.1)",
            borderRadius: "6px",
            padding: "6px 12px",
            color: "#c4c5ca",
            fontSize: "13px",
          }}
        >
          {ACTION_FILTER_OPTIONS.map(opt => (
            <option key={opt.value} value={opt.value}>{opt.label}</option>
          ))}
        </select>
      </div>

      {error && (
        <div style={{ background: "rgba(255,80,80,0.1)", border: "1px solid rgba(255,80,80,0.3)", borderRadius: "8px", padding: "12px", marginBottom: "16px", color: "#ff6b6b" }}>
          {error}
        </div>
      )}

      {loading ? (
        <p style={{ color: "#999" }}>Loading...</p>
      ) : entries.length === 0 ? (
        <div style={{ background: "rgba(255,255,255,0.04)", borderRadius: "12px", padding: "40px", textAlign: "center", color: "#999" }}>
          No activity recorded yet.
        </div>
      ) : (
        <>
          <div style={{ background: "rgba(255,255,255,0.04)", borderRadius: "12px", overflow: "hidden" }}>
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead>
                <tr style={{ borderBottom: "1px solid rgba(255,255,255,0.08)" }}>
                  <th style={thStyle}>Time</th>
                  <th style={thStyle}>Actor</th>
                  <th style={thStyle}>Action</th>
                  <th style={thStyle}>Resource</th>
                  <th style={thStyle}>Details</th>
                </tr>
              </thead>
              <tbody>
                {entries.map((entry: any) => (
                  <tr key={entry.id} style={{ borderBottom: "1px solid rgba(255,255,255,0.04)" }}>
                    <td style={tdStyle}>
                      {new Date(entry.created_at).toLocaleDateString(undefined, { month: "short", day: "numeric" })}{" "}
                      {new Date(entry.created_at).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}
                    </td>
                    <td style={tdStyle}>{entry.actor_email || entry.actor_user_id?.substring(0, 12)}</td>
                    <td style={tdStyle}>
                      <span style={{
                        padding: "2px 8px",
                        borderRadius: "4px",
                        background: getActionColor(entry.action),
                        fontSize: "12px",
                        whiteSpace: "nowrap",
                      }}>
                        {ACTION_LABELS[entry.action] || entry.action}
                      </span>
                    </td>
                    <td style={tdStyle}>
                      <span style={{ color: "#999", fontSize: "12px" }}>{entry.resource_type}</span>
                      {entry.resource_id && (
                        <span style={{ color: "#666", fontSize: "11px", marginLeft: "4px" }}>
                          {entry.resource_id.substring(0, 8)}...
                        </span>
                      )}
                    </td>
                    <td style={tdStyle}>
                      {entry.details && Object.keys(entry.details).length > 0 && (
                        <span style={{ color: "#999", fontSize: "12px" }}>
                          {Object.entries(entry.details)
                            .slice(0, 2)
                            .map(([k, v]) => `${k}: ${String(v).substring(0, 20)}`)
                            .join(", ")}
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {totalPages > 1 && (
            <div style={{ display: "flex", justifyContent: "center", alignItems: "center", gap: "12px", marginTop: "16px" }}>
              <button
                onClick={() => setPage(p => Math.max(1, p - 1))}
                disabled={page === 1}
                style={pageBtnStyle}
              >
                Previous
              </button>
              <span style={{ color: "#999", fontSize: "13px" }}>
                Page {page} of {totalPages} ({total} total)
              </span>
              <button
                onClick={() => setPage(p => Math.min(totalPages, p + 1))}
                disabled={page === totalPages}
                style={pageBtnStyle}
              >
                Next
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function getActionColor(action: string): string {
  if (action.startsWith("kill_switch")) return "rgba(255, 80, 80, 0.15)";
  if (action.startsWith("team")) return "rgba(92, 226, 231, 0.12)";
  if (action.startsWith("api_key")) return "rgba(255, 180, 50, 0.12)";
  if (action.startsWith("cloud_account")) return "rgba(100, 180, 255, 0.12)";
  if (action.startsWith("rule")) return "rgba(180, 130, 255, 0.12)";
  return "rgba(255,255,255,0.06)";
}

const thStyle: React.CSSProperties = {
  textAlign: "left",
  padding: "10px 12px",
  color: "#999",
  fontSize: "12px",
  fontWeight: 500,
  textTransform: "uppercase",
  letterSpacing: "0.5px",
};

const tdStyle: React.CSSProperties = {
  padding: "10px 12px",
  color: "#c4c5ca",
  fontSize: "13px",
};

const pageBtnStyle: React.CSSProperties = {
  background: "rgba(255,255,255,0.06)",
  border: "1px solid rgba(255,255,255,0.1)",
  borderRadius: "6px",
  padding: "6px 14px",
  color: "#c4c5ca",
  fontSize: "13px",
  cursor: "pointer",
};
