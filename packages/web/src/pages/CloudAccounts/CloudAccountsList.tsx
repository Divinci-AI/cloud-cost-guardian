import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../../api/client";

export function CloudAccountsList() {
  const [accounts, setAccounts] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api.listCloudAccounts()
      .then(data => setAccounts(data.accounts || []))
      .catch(console.error)
      .finally(() => setLoading(false));
  }, []);

  const handleDelete = async (id: string) => {
    if (!confirm("Disconnect this cloud account? Credentials will be permanently deleted.")) return;
    await api.deleteCloudAccount(id);
    setAccounts(prev => prev.filter(a => a.id !== id));
  };

  if (loading) return <p>Loading...</p>;

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "24px" }}>
        <h1 style={{ fontFamily: "Outfit, sans-serif", fontSize: "24px", fontWeight: "700", color: "#fff", margin: 0 }}>Cloud Accounts</h1>
        <Link to="/accounts/connect" style={{ background: "#c25800", color: "#fff", padding: "8px 20px", borderRadius: "8px", textDecoration: "none", fontSize: "14px", fontWeight: "600" }}>
          + Connect
        </Link>
      </div>

      {accounts.map(a => (
        <div key={a.id} style={{ padding: "20px", background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.06)", borderRadius: "12px", marginBottom: "12px" }}>
          <div style={{ display: "flex", justifyContent: "space-between" }}>
            <div>
              <h3 style={{ color: "#fff", fontFamily: "Outfit, sans-serif", margin: "0 0 4px" }}>{a.name}</h3>
              <span style={{ fontSize: "12px", color: "#6b7280" }}>{a.provider} &middot; {a.providerAccountId}</span>
            </div>
            <button onClick={() => handleDelete(a.id)} style={{ background: "rgba(255,107,107,0.1)", color: "#ff6b6b", border: "1px solid rgba(255,107,107,0.2)", padding: "6px 14px", borderRadius: "6px", cursor: "pointer", fontSize: "12px" }}>
              Disconnect
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}
