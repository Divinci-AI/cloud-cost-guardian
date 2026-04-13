import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { api, isTierLimitError } from "../../api/client";
import { UpgradeBanner } from "../../components/TierLimitBanner";

export function ConnectRunPod() {
  const navigate = useNavigate();
  const [name, setName] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [validating, setValidating] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [validation, setValidation] = useState<any>(null);
  const [error, setError] = useState("");
  const [rawError, setRawError] = useState<unknown>(null);

  const handleValidate = async () => {
    setValidating(true);
    setError("");
    try {
      const result = await api.validateCredential("runpod", {
        provider: "runpod",
        runpodApiKey: apiKey,
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
    setRawError(null);
    try {
      await api.connectCloudAccount({
        provider: "runpod",
        name: name || validation?.accountName || "RunPod Account",
        credential: {
          provider: "runpod",
          runpodApiKey: apiKey,
        },
      });
      navigate("/");
    } catch (e: any) {
      setRawError(e);
      if (!isTierLimitError(e)) setError(e.message);
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
      <h1 style={{ fontFamily: "Outfit, sans-serif", fontSize: "24px", fontWeight: "700", color: "#fff", marginBottom: "8px" }}>Connect RunPod</h1>
      <p style={{ color: "#9ca3af", marginBottom: "32px", fontSize: "14px" }}>
        Provide your RunPod API key to monitor GPU pods, serverless endpoints, and network volumes.
      </p>

      <div style={{ display: "flex", flexDirection: "column", gap: "20px" }}>
        <div>
          <label style={labelStyle}>Account Name</label>
          <input style={inputStyle} placeholder="e.g., ML Training RunPod" value={name} onChange={e => setName(e.target.value)} />
        </div>

        <div>
          <label style={labelStyle}>RunPod API Key</label>
          <input style={{ ...inputStyle, fontFamily: "monospace" }} type="password" placeholder="Paste your RunPod API key"
            value={apiKey} onChange={e => setApiKey(e.target.value)} />
          <p style={{ fontSize: "12px", color: "#9ca3af", marginTop: "4px" }}>
            Create at <span style={{ color: "#a78bfa" }}>runpod.io/console/user/settings</span> under "API Keys".
          </p>
        </div>

        <UpgradeBanner error={rawError} />

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
            <button onClick={handleValidate} disabled={validating || !apiKey}
              style={{ background: "rgba(255,255,255,0.08)", color: "#fff", border: "1px solid rgba(255,255,255,0.15)", padding: "10px 24px", borderRadius: "8px", cursor: "pointer", fontSize: "14px", fontWeight: "600", opacity: !apiKey ? 0.5 : 1 }}>
              {validating ? "Validating..." : "Validate Credentials"}
            </button>
          ) : (
            <button onClick={handleConnect} disabled={connecting}
              style={{ background: "#673ab7", color: "#fff", border: "none", padding: "10px 24px", borderRadius: "8px", cursor: "pointer", fontSize: "14px", fontWeight: "600" }}>
              {connecting ? "Connecting..." : "Connect & Start Monitoring"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
