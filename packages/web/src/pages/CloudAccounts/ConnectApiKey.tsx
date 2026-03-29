/**
 * Generic API Key Connection Form
 *
 * Reusable form for providers that only need an API key
 * (OpenAI, Anthropic, xAI, Replicate, Vercel).
 */

import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../../api/client";

interface ConnectApiKeyProps {
  providerId: string;
  providerName: string;
  description: string;
  keyLabel: string;
  keyPlaceholder: string;
  keyHint: string;
  credentialField: string;
  buttonColor: string;
  extraFields?: { key: string; label: string; placeholder: string; required?: boolean }[];
}

export function ConnectApiKey({
  providerId, providerName, description, keyLabel, keyPlaceholder,
  keyHint, credentialField, buttonColor, extraFields,
}: ConnectApiKeyProps) {
  const navigate = useNavigate();
  const [name, setName] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [extras, setExtras] = useState<Record<string, string>>({});
  const [validating, setValidating] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [validation, setValidation] = useState<any>(null);
  const [error, setError] = useState("");

  function buildCredential() {
    const cred: any = { provider: providerId, [credentialField]: apiKey };
    for (const [k, v] of Object.entries(extras)) { if (v) cred[k] = v; }
    return cred;
  }

  const handleValidate = async () => {
    setValidating(true); setError(""); setValidation(null);
    try {
      const result = await api.validateCredential(providerId, buildCredential());
      setValidation(result);
      if (!result.valid) setError(result.error || "Invalid credentials");
    } catch (e: any) { setError(e.message); }
    setValidating(false);
  };

  const handleConnect = async () => {
    setConnecting(true); setError("");
    try {
      await api.connectCloudAccount({
        provider: providerId,
        name: name || validation?.accountName || providerName,
        credential: buildCredential(),
      });
      navigate("/");
    } catch (e: any) { setError(e.message); }
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
      <h1 style={{ fontFamily: "Outfit, sans-serif", fontSize: "24px", fontWeight: "700", color: "#fff", marginBottom: "8px" }}>Connect {providerName}</h1>
      <p style={{ color: "#6b7280", marginBottom: "24px", fontSize: "14px" }}>{description}</p>

      <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
        <div>
          <label style={labelStyle}>Account Name</label>
          <input style={inputStyle} placeholder={`e.g., Production ${providerName}`} value={name} onChange={e => setName(e.target.value)} />
        </div>
        <div>
          <label style={labelStyle}>{keyLabel}</label>
          <input style={{ ...inputStyle, fontFamily: "monospace" }} type="password" placeholder={keyPlaceholder} value={apiKey} onChange={e => setApiKey(e.target.value)} />
          <p style={{ fontSize: "12px", color: "#6b7280", marginTop: "4px" }}>{keyHint}</p>
        </div>

        {extraFields?.map(f => (
          <div key={f.key}>
            <label style={labelStyle}>{f.label}{!f.required && " (optional)"}</label>
            <input style={inputStyle} placeholder={f.placeholder} value={extras[f.key] || ""} onChange={e => setExtras({ ...extras, [f.key]: e.target.value })} />
          </div>
        ))}

        {error && <div style={{ padding: "12px", background: "rgba(255,107,107,0.1)", border: "1px solid rgba(255,107,107,0.2)", borderRadius: "8px", color: "#ff6b6b", fontSize: "13px" }}>{error}</div>}
        {validation?.valid && <div style={{ padding: "12px", background: "rgba(92,226,231,0.1)", border: "1px solid rgba(92,226,231,0.2)", borderRadius: "8px", color: "#5ce2e7", fontSize: "13px" }}>Validated: {validation.accountName} ({validation.accountId})</div>}

        <div style={{ display: "flex", gap: "12px" }}>
          {!validation?.valid ? (
            <button onClick={handleValidate} disabled={validating || !apiKey}
              style={{ background: "rgba(255,255,255,0.08)", color: "#fff", border: "1px solid rgba(255,255,255,0.15)", padding: "10px 24px", borderRadius: "8px", cursor: "pointer", fontSize: "14px", fontWeight: "600", opacity: !apiKey ? 0.5 : 1 }}>
              {validating ? "Validating..." : "Validate Credentials"}
            </button>
          ) : (
            <button onClick={handleConnect} disabled={connecting}
              style={{ background: buttonColor, color: "#fff", border: "none", padding: "10px 24px", borderRadius: "8px", cursor: "pointer", fontSize: "14px", fontWeight: "600" }}>
              {connecting ? "Connecting..." : "Connect & Start Monitoring"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
