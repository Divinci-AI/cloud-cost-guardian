import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../../api/client";

export function ConnectCloudflare() {
  const navigate = useNavigate();
  const [name, setName] = useState("");
  const [accountId, setAccountId] = useState("");
  const [apiToken, setApiToken] = useState("");
  const [validating, setValidating] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [validation, setValidation] = useState<any>(null);
  const [error, setError] = useState("");

  const handleValidate = async () => {
    setValidating(true);
    setError("");
    try {
      const result = await api.validateCredential("cloudflare", {
        provider: "cloudflare",
        apiToken,
        accountId,
      });
      setValidation(result);
      if (!result.valid) setError(result.error || "Invalid credentials");
    } catch (e: any) {
      setError(e.message);
    }
    setValidating(false);
  };

  const handleConnect = async () => {
    setConnecting(true);
    setError("");
    try {
      await api.connectCloudAccount({
        provider: "cloudflare",
        name: name || validation?.accountName || "Cloudflare Account",
        credential: { provider: "cloudflare", apiToken, accountId },
      });
      navigate("/");
    } catch (e: any) {
      setError(e.message);
    }
    setConnecting(false);
  };

  const inputStyle = {
    width: "100%", padding: "10px 14px", background: "rgba(255,255,255,0.05)",
    border: "1px solid rgba(255,255,255,0.12)", borderRadius: "8px",
    color: "#fff", fontSize: "14px", fontFamily: "JetBrains Mono, monospace",
    outline: "none",
  };

  const labelStyle = { display: "block", marginBottom: "6px", fontSize: "13px", fontWeight: "600" as const, color: "#c4c5ca" };

  return (
    <div style={{ maxWidth: "560px" }}>
      <h1 style={{ fontFamily: "Outfit, sans-serif", fontSize: "24px", fontWeight: "700", color: "#fff", marginBottom: "8px" }}>Connect Cloudflare</h1>
      <p style={{ color: "#9ca3af", marginBottom: "32px", fontSize: "14px" }}>
        Provide your Cloudflare Account ID and an API Token with Analytics:Read and Workers Scripts:Edit permissions.
      </p>

      <div style={{ display: "flex", flexDirection: "column", gap: "20px" }}>
        <div>
          <label style={labelStyle}>Account Name</label>
          <input style={inputStyle} placeholder="e.g., Production" value={name} onChange={e => setName(e.target.value)} />
        </div>

        <div>
          <label style={labelStyle}>Cloudflare Account ID</label>
          <input style={inputStyle} placeholder="e.g., 14a6fa23390363382f378b5bd4a0f849" value={accountId} onChange={e => setAccountId(e.target.value)} />
          <p style={{ fontSize: "12px", color: "#9ca3af", marginTop: "4px" }}>Found in your Cloudflare Dashboard URL or Workers overview.</p>
        </div>

        <div>
          <label style={labelStyle}>API Token</label>
          <input style={{ ...inputStyle, fontFamily: "monospace" }} type="password" placeholder="Paste your API token" value={apiToken} onChange={e => setApiToken(e.target.value)} />
          <p style={{ fontSize: "12px", color: "#9ca3af", marginTop: "4px" }}>
            Required permissions: Account Analytics (Read), Workers Scripts (Edit), Workers Routes (Edit)
          </p>
        </div>

        {error && (
          <div style={{ padding: "12px 16px", background: "rgba(255,107,107,0.1)", border: "1px solid rgba(255,107,107,0.2)", borderRadius: "8px", color: "#ff6b6b", fontSize: "13px" }}>
            {error}
          </div>
        )}

        {validation?.valid && (
          <div style={{ padding: "12px 16px", background: "rgba(92,226,231,0.1)", border: "1px solid rgba(92,226,231,0.2)", borderRadius: "8px", color: "#5ce2e7", fontSize: "13px" }}>
            Validated: {validation.accountName} ({validation.accountId})
          </div>
        )}

        <div style={{ display: "flex", gap: "12px" }}>
          {!validation?.valid ? (
            <button onClick={handleValidate} disabled={validating || !accountId || !apiToken}
              style={{ background: "rgba(255,255,255,0.08)", color: "#fff", border: "1px solid rgba(255,255,255,0.15)", padding: "10px 24px", borderRadius: "8px", cursor: "pointer", fontSize: "14px", fontWeight: "600", opacity: (!accountId || !apiToken) ? 0.5 : 1 }}>
              {validating ? "Validating..." : "Validate Credentials"}
            </button>
          ) : (
            <button onClick={handleConnect} disabled={connecting}
              style={{ background: "#c25800", color: "#fff", border: "none", padding: "10px 24px", borderRadius: "8px", cursor: "pointer", fontSize: "14px", fontWeight: "600" }}>
              {connecting ? "Connecting..." : "Connect & Start Monitoring"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
