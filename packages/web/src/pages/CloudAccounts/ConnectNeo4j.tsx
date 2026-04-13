import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { api, isTierLimitError } from "../../api/client";
import { UpgradeBanner } from "../../components/TierLimitBanner";

export function ConnectNeo4j() {
  const navigate = useNavigate();
  const [name, setName] = useState("");
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [instanceId, setInstanceId] = useState("");
  const [validating, setValidating] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [validation, setValidation] = useState<any>(null);
  const [error, setError] = useState("");
  const [rawError, setRawError] = useState<unknown>(null);

  function buildCredential() {
    return {
      provider: "neo4j",
      neo4jClientId: clientId,
      neo4jClientSecret: clientSecret,
      ...(instanceId ? { neo4jInstanceId: instanceId } : {}),
    };
  }

  const handleValidate = async () => {
    setValidating(true); setError(""); setValidation(null);
    try {
      const result = await api.validateCredential("neo4j", buildCredential());
      setValidation(result);
      if (!result.valid) setError(result.error || "Invalid credentials");
    } catch (e: any) { setError(e.message); }
    setValidating(false);
  };

  const handleConnect = async () => {
    setConnecting(true); setError(""); setRawError(null);
    try {
      await api.connectCloudAccount({
        provider: "neo4j",
        name: name || validation?.accountName || "Neo4j Aura",
        credential: buildCredential(),
      });
      navigate("/");
    } catch (e: any) { setRawError(e); if (!isTierLimitError(e)) setError(e.message); }
    setConnecting(false);
  };

  const inputStyle = {
    width: "100%", padding: "10px 14px", background: "rgba(255,255,255,0.05)",
    border: "1px solid rgba(255,255,255,0.12)", borderRadius: "8px",
    color: "#fff", fontSize: "14px", outline: "none", boxSizing: "border-box" as const,
  };
  const labelStyle = { display: "block" as const, marginBottom: "6px", fontSize: "13px", fontWeight: "600" as const, color: "#c4c5ca" };

  return (
    <div style={{ maxWidth: "560px" }}>
      <h1 style={{ fontFamily: "Outfit, sans-serif", fontSize: "24px", fontWeight: "700", color: "#fff", marginBottom: "8px" }}>Connect Neo4j Aura</h1>
      <p style={{ color: "#9ca3af", marginBottom: "24px", fontSize: "14px" }}>
        Monitor Neo4j Aura graph database instances for memory, storage, and cost protection.
      </p>

      <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
        <div>
          <label style={labelStyle}>Account Name</label>
          <input style={inputStyle} placeholder="e.g., Divinci AI GraphRAG" value={name} onChange={e => setName(e.target.value)} />
        </div>
        <div>
          <label style={labelStyle}>Client ID</label>
          <input style={{ ...inputStyle, fontFamily: "monospace" }} placeholder="Neo4j Aura API client ID" value={clientId} onChange={e => setClientId(e.target.value)} />
        </div>
        <div>
          <label style={labelStyle}>Client Secret</label>
          <input style={{ ...inputStyle, fontFamily: "monospace" }} type="password" placeholder="Neo4j Aura API client secret" value={clientSecret} onChange={e => setClientSecret(e.target.value)} />
        </div>
        <div>
          <label style={labelStyle}>Instance ID (optional)</label>
          <input style={inputStyle} placeholder="e.g., 9c96c178 (leave empty for all instances)" value={instanceId} onChange={e => setInstanceId(e.target.value)} />
        </div>
        <p style={{ fontSize: "12px", color: "#9ca3af", margin: "-8px 0 0" }}>
          Create API credentials at{" "}
          <span style={{ color: "#018bff" }}>console.neo4j.io &gt; Account &gt; API Credentials</span>.
          {" "}Use the <strong style={{ color: "#c4c5ca" }}>Tenant Admin</strong> role for full monitoring + kill switch actions.
        </p>

        <UpgradeBanner error={rawError} />
        {error && <div style={{ padding: "12px", background: "rgba(255,107,107,0.1)", border: "1px solid rgba(255,107,107,0.2)", borderRadius: "8px", color: "#ff6b6b", fontSize: "13px" }}>{error}</div>}
        {validation?.valid && <div style={{ padding: "12px", background: "rgba(92,226,231,0.1)", border: "1px solid rgba(92,226,231,0.2)", borderRadius: "8px", color: "#5ce2e7", fontSize: "13px" }}>Validated: {validation.accountName} ({validation.accountId})</div>}

        <div style={{ display: "flex", gap: "12px" }}>
          {!validation?.valid ? (
            <button onClick={handleValidate} disabled={validating || !clientId || !clientSecret}
              style={{ background: "rgba(255,255,255,0.08)", color: "#fff", border: "1px solid rgba(255,255,255,0.15)", padding: "10px 24px", borderRadius: "8px", cursor: "pointer", fontSize: "14px", fontWeight: "600", opacity: (!clientId || !clientSecret) ? 0.5 : 1 }}>
              {validating ? "Validating..." : "Validate Credentials"}
            </button>
          ) : (
            <button onClick={handleConnect} disabled={connecting}
              style={{ background: "#018bff", color: "#fff", border: "none", padding: "10px 24px", borderRadius: "8px", cursor: "pointer", fontSize: "14px", fontWeight: "600" }}>
              {connecting ? "Connecting..." : "Connect & Start Monitoring"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
