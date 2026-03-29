import { useEffect, useState } from "react";
import { api } from "../../api/client";
import { useOrg } from "../../context/OrgContext";

export function AlertsHistory() {
  const { orgVersion } = useOrg();
  const [alerts, setAlerts] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [testing, setTesting] = useState(false);

  useEffect(() => {
    setLoading(true);
    api.getAlertHistory()
      .then(data => setAlerts(data.alerts || []))
      .catch(console.error)
      .finally(() => setLoading(false));
  }, [orgVersion]);

  const handleTest = async () => {
    setTesting(true);
    try {
      await api.testAlerts();
      alert("Test alert sent to all configured channels!");
    } catch (e: any) {
      alert(`Failed: ${e.message}`);
    }
    setTesting(false);
  };

  const severityColor = (s: string) => {
    if (s === "critical") return "#ff6b6b";
    if (s === "error") return "#ffa07a";
    if (s === "warning") return "#ffcc00";
    return "#5ce2e7";
  };

  if (loading) return <p>Loading...</p>;

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "24px" }}>
        <h1 style={{ fontFamily: "Outfit, sans-serif", fontSize: "24px", fontWeight: "700", color: "#fff", margin: 0 }}>Alert History</h1>
        <button onClick={handleTest} disabled={testing} style={{ background: "rgba(255,255,255,0.08)", color: "#fff", border: "1px solid rgba(255,255,255,0.15)", padding: "8px 20px", borderRadius: "8px", cursor: "pointer", fontSize: "14px" }}>
          {testing ? "Sending..." : "Test Alerts"}
        </button>
      </div>

      {alerts.length === 0 ? (
        <div style={{ textAlign: "center", padding: "60px 20px", color: "#6b7280" }}>
          <p style={{ fontSize: "36px", marginBottom: "12px" }}>&#128276;</p>
          <p>No alerts yet. That's a good thing!</p>
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
          {alerts.map((a, i) => (
            <div key={i} style={{ padding: "16px 20px", background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.06)", borderRadius: "8px", borderLeft: `3px solid ${severityColor(a.severity)}` }}>
              <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "6px" }}>
                <span style={{ fontSize: "11px", textTransform: "uppercase", fontWeight: "600", color: severityColor(a.severity) }}>{a.severity}</span>
                <span style={{ fontSize: "12px", color: "#6b7280" }}>{new Date(a.created_at).toLocaleString()}</span>
              </div>
              <p style={{ color: "#fff", fontSize: "14px", margin: 0 }}>{a.summary}</p>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
