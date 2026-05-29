import { useEffect, useState } from "react";
import { api } from "../../api/client";
import { useOrg } from "../../context/OrgContext";

/**
 * Agent Guard — read-only view of coding-agent budget trips reported by the
 * @kill-switch/agent-guard hook & proxy (POST /agent-guard/events). The
 * infrastructure analog of the Activity log, but for LLM spend on the laptop.
 */

interface AgentGuardEvent {
  id: string;
  ts: number;
  source: "hook" | "proxy";
  sessionId: string;
  level: "warn" | "block";
  sessionUSD: number;
  dailyUSD: number;
  reasons: string[];
  action: string;
  cwd?: string;
  createdAt: string;
}

function fmtUSD(n: number): string {
  return `$${(n ?? 0).toFixed(n < 1 ? 4 : 2)}`;
}

export function AgentGuardPage() {
  const { activeOrg, orgVersion } = useOrg();
  const [events, setEvents] = useState<AgentGuardEvent[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const limit = 25;

  useEffect(() => {
    if (!activeOrg) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setError("");
    api.getAgentGuardEvents({ limit, skip: (page - 1) * limit })
      .then(data => {
        setEvents(data.events || []);
        setTotal(data.total || 0);
      })
      .catch(err => setError(err.message))
      .finally(() => setLoading(false));
  }, [page, activeOrg, orgVersion]);

  const totalPages = Math.ceil(total / limit);

  return (
    <div>
      <div style={{ marginBottom: "8px" }}>
        <h1 style={{ fontSize: "24px", fontWeight: 600, color: "#fff", margin: 0 }}>Agent Guard</h1>
        <p style={{ color: "#999", fontSize: "13px", marginTop: "6px" }}>
          Budget trips from coding agents (Claude Code, Cursor, Aider) running the{" "}
          <code style={{ color: "#5ce2e7" }}>agent-guard</code> hook or proxy. Set caps with{" "}
          <code style={{ color: "#5ce2e7" }}>ks guard config</code>.
        </p>
      </div>

      {error && (
        <div style={{ background: "rgba(255,80,80,0.1)", border: "1px solid rgba(255,80,80,0.3)", borderRadius: "8px", padding: "12px", marginBottom: "16px", color: "#ff6b6b" }}>
          {error}
        </div>
      )}

      {loading ? (
        <p style={{ color: "#999" }}>Loading...</p>
      ) : events.length === 0 ? (
        <div style={{ background: "rgba(255,255,255,0.04)", borderRadius: "12px", padding: "40px", textAlign: "center", color: "#999" }}>
          No agent budget trips recorded yet. Install the guard with{" "}
          <code style={{ color: "#5ce2e7" }}>ks guard install</code>.
        </div>
      ) : (
        <>
          <div style={{ background: "rgba(255,255,255,0.04)", borderRadius: "12px", overflow: "hidden" }}>
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead>
                <tr style={{ borderBottom: "1px solid rgba(255,255,255,0.08)" }}>
                  <th style={thStyle}>Time</th>
                  <th style={thStyle}>Level</th>
                  <th style={thStyle}>Project</th>
                  <th style={thStyle}>Session</th>
                  <th style={thStyle}>Daily (24h)</th>
                  <th style={thStyle}>Action</th>
                  <th style={thStyle}>Source</th>
                </tr>
              </thead>
              <tbody>
                {events.map(evt => (
                  <tr key={evt.id} style={{ borderBottom: "1px solid rgba(255,255,255,0.04)" }}>
                    <td style={tdStyle}>
                      {new Date(evt.ts).toLocaleDateString(undefined, { month: "short", day: "numeric" })}{" "}
                      {new Date(evt.ts).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}
                    </td>
                    <td style={tdStyle}>
                      <span style={{
                        padding: "2px 8px",
                        borderRadius: "4px",
                        background: evt.level === "block" ? "rgba(255, 80, 80, 0.15)" : "rgba(255, 180, 50, 0.12)",
                        color: evt.level === "block" ? "#ff6b6b" : "#ffb432",
                        fontSize: "12px",
                        whiteSpace: "nowrap",
                      }}>
                        {evt.level === "block" ? "🛑 blocked" : "⚠️ warn"}
                      </span>
                    </td>
                    <td style={{ ...tdStyle, maxWidth: "220px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={evt.cwd}>
                      {evt.cwd ? evt.cwd.replace(/^.*\//, "") || evt.cwd : <span style={{ color: "#666" }}>—</span>}
                    </td>
                    <td style={{ ...tdStyle, color: evt.level === "block" ? "#ff6b6b" : "#c4c5ca" }}>{fmtUSD(evt.sessionUSD)}</td>
                    <td style={tdStyle}>{fmtUSD(evt.dailyUSD)}</td>
                    <td style={{ ...tdStyle, color: "#999", fontSize: "12px" }}>{evt.action || "—"}</td>
                    <td style={{ ...tdStyle, color: "#666", fontSize: "12px" }}>{evt.source}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {totalPages > 1 && (
            <div style={{ display: "flex", justifyContent: "center", alignItems: "center", gap: "12px", marginTop: "16px" }}>
              <button onClick={() => setPage(p => Math.max(1, p - 1))} disabled={page === 1} style={pageBtnStyle}>
                Previous
              </button>
              <span style={{ color: "#999", fontSize: "13px" }}>
                Page {page} of {totalPages} ({total} total)
              </span>
              <button onClick={() => setPage(p => Math.min(totalPages, p + 1))} disabled={page === totalPages} style={pageBtnStyle}>
                Next
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
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
