import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../../api/client";

export function ConnectSnowflake() {
  const navigate = useNavigate();
  const [name, setName] = useState("");
  const [accountName, setAccountName] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [warehouseName, setWarehouseName] = useState("");
  const [role, setRole] = useState("");
  const [validating, setValidating] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [validation, setValidation] = useState<any>(null);
  const [error, setError] = useState("");

  function buildCredential() {
    return { provider: "snowflake", snowflakeAccountName: accountName, snowflakeUsername: username, snowflakePassword: password, snowflakeWarehouseName: warehouseName || undefined, snowflakeRole: role || undefined };
  }

  const handleValidate = async () => {
    setValidating(true); setError(""); setValidation(null);
    try {
      const result = await api.validateCredential("snowflake", buildCredential());
      setValidation(result);
      if (!result.valid) setError(result.error || "Invalid credentials");
    } catch (e: any) { setError(e.message); }
    setValidating(false);
  };

  const handleConnect = async () => {
    setConnecting(true); setError("");
    try {
      await api.connectCloudAccount({ provider: "snowflake", name: name || validation?.accountName || "Snowflake", credential: buildCredential() });
      navigate("/");
    } catch (e: any) { setError(e.message); }
    setConnecting(false);
  };

  const inputStyle = { width: "100%", padding: "10px 14px", background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.12)", borderRadius: "8px", color: "#fff", fontSize: "14px", outline: "none", boxSizing: "border-box" as const };
  const labelStyle = { display: "block" as const, marginBottom: "6px", fontSize: "13px", fontWeight: "600" as const, color: "#c4c5ca" };
  const canValidate = accountName && username && password;

  return (
    <div style={{ maxWidth: "560px" }}>
      <h1 style={{ fontFamily: "Outfit, sans-serif", fontSize: "24px", fontWeight: "700", color: "#fff", marginBottom: "8px" }}>Connect Snowflake</h1>
      <p style={{ color: "#6b7280", marginBottom: "24px", fontSize: "14px" }}>Monitor warehouse credits, query costs, and data scanning.</p>
      <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
        <div><label style={labelStyle}>Account Name</label><input style={inputStyle} placeholder="e.g., Production Snowflake" value={name} onChange={e => setName(e.target.value)} /></div>
        <div><label style={labelStyle}>Snowflake Account</label><input style={inputStyle} placeholder="xy12345.us-east-1" value={accountName} onChange={e => setAccountName(e.target.value)} /><p style={{ fontSize: "12px", color: "#6b7280", marginTop: "4px" }}>Found in your Snowflake URL: https://&lt;account&gt;.snowflakecomputing.com</p></div>
        <div><label style={labelStyle}>Username</label><input style={inputStyle} placeholder="Snowflake username" value={username} onChange={e => setUsername(e.target.value)} /></div>
        <div><label style={labelStyle}>Password</label><input style={inputStyle} type="password" placeholder="Snowflake password" value={password} onChange={e => setPassword(e.target.value)} /></div>
        <div><label style={labelStyle}>Warehouse (optional)</label><input style={inputStyle} placeholder="COMPUTE_WH" value={warehouseName} onChange={e => setWarehouseName(e.target.value)} /></div>
        <div><label style={labelStyle}>Role (optional)</label><input style={inputStyle} placeholder="ACCOUNTADMIN" value={role} onChange={e => setRole(e.target.value)} /></div>
        {error && <div style={{ padding: "12px", background: "rgba(255,107,107,0.1)", border: "1px solid rgba(255,107,107,0.2)", borderRadius: "8px", color: "#ff6b6b", fontSize: "13px" }}>{error}</div>}
        {validation?.valid && <div style={{ padding: "12px", background: "rgba(92,226,231,0.1)", border: "1px solid rgba(92,226,231,0.2)", borderRadius: "8px", color: "#5ce2e7", fontSize: "13px" }}>Validated: {validation.accountName} ({validation.accountId})</div>}
        <div style={{ display: "flex", gap: "12px" }}>
          {!validation?.valid ? (
            <button onClick={handleValidate} disabled={validating || !canValidate} style={{ background: "rgba(255,255,255,0.08)", color: "#fff", border: "1px solid rgba(255,255,255,0.15)", padding: "10px 24px", borderRadius: "8px", cursor: "pointer", fontSize: "14px", fontWeight: "600", opacity: !canValidate ? 0.5 : 1 }}>{validating ? "Validating..." : "Validate Credentials"}</button>
          ) : (
            <button onClick={handleConnect} disabled={connecting} style={{ background: "#29b5e8", color: "#fff", border: "none", padding: "10px 24px", borderRadius: "8px", cursor: "pointer", fontSize: "14px", fontWeight: "600" }}>{connecting ? "Connecting..." : "Connect & Start Monitoring"}</button>
          )}
        </div>
      </div>
    </div>
  );
}
