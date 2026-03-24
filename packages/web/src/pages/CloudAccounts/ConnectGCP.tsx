import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../../api/client";

export function ConnectGCP() {
  const navigate = useNavigate();
  const [name, setName] = useState("");
  const [projectId, setProjectId] = useState("");
  const [region, setRegion] = useState("us-central1");
  const [serviceAccountJson, setServiceAccountJson] = useState("");
  const [validating, setValidating] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [validation, setValidation] = useState<any>(null);
  const [error, setError] = useState("");

  const handleValidate = async () => {
    setValidating(true);
    setError("");
    try {
      const result = await api.validateCredential("gcp", {
        provider: "gcp",
        serviceAccountJson,
        projectId,
        region,
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
        provider: "gcp",
        name: name || validation?.accountName || "GCP Project",
        credential: { provider: "gcp", serviceAccountJson, projectId, region },
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
      <h1 style={{ fontFamily: "Outfit, sans-serif", fontSize: "24px", fontWeight: "700", color: "#fff", marginBottom: "8px" }}>Connect Google Cloud</h1>
      <p style={{ color: "#6b7280", marginBottom: "32px", fontSize: "14px" }}>
        Provide your GCP Project ID and a Service Account key JSON with the required roles.
      </p>

      <div style={{ display: "flex", flexDirection: "column", gap: "20px" }}>
        <div>
          <label style={labelStyle}>Account Name</label>
          <input style={inputStyle} placeholder="e.g., Production GCP" value={name} onChange={e => setName(e.target.value)} />
        </div>

        <div>
          <label style={labelStyle}>GCP Project ID</label>
          <input style={inputStyle} placeholder="e.g., my-project-123456" value={projectId} onChange={e => setProjectId(e.target.value)} />
        </div>

        <div>
          <label style={labelStyle}>Region</label>
          <input style={inputStyle} placeholder="us-central1" value={region} onChange={e => setRegion(e.target.value)} />
          <p style={{ fontSize: "12px", color: "#6b7280", marginTop: "4px" }}>Primary region for Cloud Run and Cloud Functions monitoring.</p>
        </div>

        <div>
          <label style={labelStyle}>Service Account JSON Key</label>
          <textarea
            style={{ ...inputStyle, minHeight: "120px", resize: "vertical", fontFamily: "monospace", fontSize: "12px" }}
            placeholder='Paste the full JSON key file contents here...'
            value={serviceAccountJson}
            onChange={e => setServiceAccountJson(e.target.value)}
          />
          <p style={{ fontSize: "12px", color: "#6b7280", marginTop: "4px" }}>
            Required IAM roles: Cloud Run Viewer/Admin, Compute Viewer/Instance Admin, Container Cluster Viewer, BigQuery User, Service Usage Admin, Billing Project Manager
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
            <button onClick={handleValidate} disabled={validating || !projectId || !serviceAccountJson}
              style={{ background: "rgba(255,255,255,0.08)", color: "#fff", border: "1px solid rgba(255,255,255,0.15)", padding: "10px 24px", borderRadius: "8px", cursor: "pointer", fontSize: "14px", fontWeight: "600", opacity: (!projectId || !serviceAccountJson) ? 0.5 : 1 }}>
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
