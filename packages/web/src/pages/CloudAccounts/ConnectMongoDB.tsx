import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../../api/client";

type MongoDBSubType = "atlas" | "self-hosted";

export function ConnectMongoDB() {
  const navigate = useNavigate();
  const [name, setName] = useState("");
  const [subType, setSubType] = useState<MongoDBSubType>("atlas");
  const [validating, setValidating] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [validation, setValidation] = useState<any>(null);
  const [error, setError] = useState("");

  // Atlas
  const [atlasPublicKey, setAtlasPublicKey] = useState("");
  const [atlasPrivateKey, setAtlasPrivateKey] = useState("");
  const [atlasProjectId, setAtlasProjectId] = useState("");
  const [clusterName, setClusterName] = useState("");
  // Self-hosted
  const [mongodbUri, setMongodbUri] = useState("");
  const [databaseName, setDatabaseName] = useState("");

  function buildCredential() {
    const base: any = { provider: "mongodb", mongodbSubType: subType };
    switch (subType) {
      case "atlas":
        return { ...base, atlasPublicKey, atlasPrivateKey, atlasProjectId, atlasClusterName: clusterName };
      case "self-hosted":
        return { ...base, mongodbUri, mongodbDatabaseName: databaseName || undefined };
    }
  }

  const handleValidate = async () => {
    setValidating(true);
    setError("");
    setValidation(null);
    try {
      const result = await api.validateCredential("mongodb", buildCredential());
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
        provider: "mongodb",
        name: name || validation?.accountName || "MongoDB",
        credential: buildCredential(),
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
    color: "#fff", fontSize: "14px", outline: "none", boxSizing: "border-box" as const,
  };
  const labelStyle = { display: "block" as const, marginBottom: "6px", fontSize: "13px", fontWeight: "600" as const, color: "#c4c5ca" };
  const radioBtnStyle = (active: boolean) => ({
    padding: "10px 20px", borderRadius: "8px", cursor: "pointer", fontSize: "13px", fontWeight: "600" as const,
    background: active ? "rgba(0, 104, 74, 0.15)" : "rgba(255,255,255,0.04)",
    border: `1px solid ${active ? "#00684a" : "rgba(255,255,255,0.08)"}`,
    color: active ? "#47c97a" : "#999",
  });

  const canValidate = () => {
    switch (subType) {
      case "atlas": return atlasPublicKey && atlasPrivateKey && atlasProjectId;
      case "self-hosted": return mongodbUri;
    }
  };

  return (
    <div style={{ maxWidth: "560px" }}>
      <h1 style={{ fontFamily: "Outfit, sans-serif", fontSize: "24px", fontWeight: "700", color: "#fff", marginBottom: "8px" }}>Connect MongoDB</h1>
      <p style={{ color: "#6b7280", marginBottom: "24px", fontSize: "14px" }}>
        Monitor MongoDB clusters for storage growth, connection overload, and cost runaway.
      </p>

      <div style={{ display: "flex", gap: "16px", marginBottom: "20px" }}>
        {(["atlas", "self-hosted"] as MongoDBSubType[]).map(t => (
          <button key={t} onClick={() => { setSubType(t); setValidation(null); setError(""); }} style={radioBtnStyle(subType === t)}>
            {t === "atlas" ? "MongoDB Atlas" : "Self-Hosted"}
          </button>
        ))}
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
        <div>
          <label style={labelStyle}>Account Name</label>
          <input style={inputStyle} placeholder="e.g., Production MongoDB" value={name} onChange={e => setName(e.target.value)} />
        </div>

        {subType === "atlas" && (<>
          <div><label style={labelStyle}>Public Key</label><input style={inputStyle} placeholder="Atlas API public key" value={atlasPublicKey} onChange={e => setAtlasPublicKey(e.target.value)} /></div>
          <div><label style={labelStyle}>Private Key</label><input style={inputStyle} type="password" placeholder="Atlas API private key" value={atlasPrivateKey} onChange={e => setAtlasPrivateKey(e.target.value)} /></div>
          <div><label style={labelStyle}>Project ID</label><input style={inputStyle} placeholder="Atlas project ID (from URL or settings)" value={atlasProjectId} onChange={e => setAtlasProjectId(e.target.value)} /></div>
          <div><label style={labelStyle}>Cluster Name (optional)</label><input style={inputStyle} placeholder="e.g., Cluster0 (leave empty for all)" value={clusterName} onChange={e => setClusterName(e.target.value)} /></div>
          <p style={{ fontSize: "12px", color: "#6b7280", margin: "-8px 0 0" }}>
            Create API keys at <span style={{ color: "#47c97a" }}>cloud.mongodb.com &gt; Organization &gt; Access Manager &gt; API Keys</span>
          </p>
        </>)}

        {subType === "self-hosted" && (<>
          <div>
            <label style={labelStyle}>MongoDB URI</label>
            <input style={inputStyle} placeholder="mongodb+srv://user:pass@host/db" value={mongodbUri} onChange={e => setMongodbUri(e.target.value)} />
          </div>
          <div>
            <label style={labelStyle}>Database Name (optional)</label>
            <input style={inputStyle} placeholder="Defaults to admin" value={databaseName} onChange={e => setDatabaseName(e.target.value)} />
          </div>
        </>)}

        {error && <div style={{ padding: "12px", background: "rgba(255,107,107,0.1)", border: "1px solid rgba(255,107,107,0.2)", borderRadius: "8px", color: "#ff6b6b", fontSize: "13px" }}>{error}</div>}
        {validation?.valid && <div style={{ padding: "12px", background: "rgba(92,226,231,0.1)", border: "1px solid rgba(92,226,231,0.2)", borderRadius: "8px", color: "#5ce2e7", fontSize: "13px" }}>Validated: {validation.accountName} ({validation.accountId})</div>}

        <div style={{ display: "flex", gap: "12px" }}>
          {!validation?.valid ? (
            <button onClick={handleValidate} disabled={validating || !canValidate()}
              style={{ background: "rgba(255,255,255,0.08)", color: "#fff", border: "1px solid rgba(255,255,255,0.15)", padding: "10px 24px", borderRadius: "8px", cursor: "pointer", fontSize: "14px", fontWeight: "600", opacity: !canValidate() ? 0.5 : 1 }}>
              {validating ? "Validating..." : "Validate Credentials"}
            </button>
          ) : (
            <button onClick={handleConnect} disabled={connecting}
              style={{ background: "#00684a", color: "#fff", border: "none", padding: "10px 24px", borderRadius: "8px", cursor: "pointer", fontSize: "14px", fontWeight: "600" }}>
              {connecting ? "Connecting..." : "Connect & Start Monitoring"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
