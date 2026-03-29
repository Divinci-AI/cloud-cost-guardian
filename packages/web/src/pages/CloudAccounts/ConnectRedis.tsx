import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../../api/client";

type RedisSubType = "redis-cloud" | "elasticache" | "self-hosted";

export function ConnectRedis() {
  const navigate = useNavigate();
  const [name, setName] = useState("");
  const [subType, setSubType] = useState<RedisSubType>("self-hosted");
  const [validating, setValidating] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [validation, setValidation] = useState<any>(null);
  const [error, setError] = useState("");

  // Redis Cloud
  const [accountKey, setAccountKey] = useState("");
  const [secretKey, setSecretKey] = useState("");
  const [subscriptionId, setSubscriptionId] = useState("");
  // ElastiCache
  const [awsAccessKeyId, setAwsAccessKeyId] = useState("");
  const [awsSecretAccessKey, setAwsSecretAccessKey] = useState("");
  const [awsRegion, setAwsRegion] = useState("us-east-1");
  const [clusterId, setClusterId] = useState("");
  // Self-hosted
  const [redisUrl, setRedisUrl] = useState("");
  const [tlsEnabled, setTlsEnabled] = useState(false);

  function buildCredential() {
    const base: any = { provider: "redis", redisSubType: subType };
    switch (subType) {
      case "redis-cloud":
        return { ...base, redisCloudAccountKey: accountKey, redisCloudSecretKey: secretKey, redisCloudSubscriptionId: subscriptionId };
      case "elasticache":
        return { ...base, awsAccessKeyId, awsSecretAccessKey, awsRegion, elasticacheClusterId: clusterId };
      case "self-hosted":
        return { ...base, redisUrl, redisTlsEnabled: tlsEnabled };
    }
  }

  const handleValidate = async () => {
    setValidating(true);
    setError("");
    setValidation(null);
    try {
      const result = await api.validateCredential("redis", buildCredential());
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
        provider: "redis",
        name: name || validation?.accountName || "Redis",
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
  const radioStyle = { display: "flex" as const, gap: "16px", marginBottom: "20px" };
  const radioBtnStyle = (active: boolean) => ({
    padding: "10px 20px", borderRadius: "8px", cursor: "pointer", fontSize: "13px", fontWeight: "600" as const,
    background: active ? "rgba(220, 56, 45, 0.15)" : "rgba(255,255,255,0.04)",
    border: `1px solid ${active ? "#dc382d" : "rgba(255,255,255,0.08)"}`,
    color: active ? "#dc382d" : "#999",
  });

  const canValidate = () => {
    switch (subType) {
      case "redis-cloud": return accountKey && secretKey && subscriptionId;
      case "elasticache": return awsAccessKeyId && awsSecretAccessKey && clusterId;
      case "self-hosted": return redisUrl;
    }
  };

  return (
    <div style={{ maxWidth: "560px" }}>
      <h1 style={{ fontFamily: "Outfit, sans-serif", fontSize: "24px", fontWeight: "700", color: "#fff", marginBottom: "8px" }}>Connect Redis</h1>
      <p style={{ color: "#6b7280", marginBottom: "24px", fontSize: "14px" }}>
        Monitor Redis instances for memory spikes, connection overload, and cost runaway.
      </p>

      <div style={radioStyle}>
        {(["redis-cloud", "elasticache", "self-hosted"] as RedisSubType[]).map(t => (
          <button key={t} onClick={() => { setSubType(t); setValidation(null); setError(""); }} style={radioBtnStyle(subType === t)}>
            {t === "redis-cloud" ? "Redis Cloud" : t === "elasticache" ? "ElastiCache" : "Self-Hosted"}
          </button>
        ))}
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
        <div>
          <label style={labelStyle}>Account Name</label>
          <input style={inputStyle} placeholder="e.g., Production Redis" value={name} onChange={e => setName(e.target.value)} />
        </div>

        {subType === "redis-cloud" && (<>
          <div><label style={labelStyle}>Account Key</label><input style={inputStyle} placeholder="Redis Cloud account key" value={accountKey} onChange={e => setAccountKey(e.target.value)} /></div>
          <div><label style={labelStyle}>Secret Key</label><input style={inputStyle} type="password" placeholder="Redis Cloud secret key" value={secretKey} onChange={e => setSecretKey(e.target.value)} /></div>
          <div><label style={labelStyle}>Subscription ID</label><input style={inputStyle} placeholder="e.g., 12345" value={subscriptionId} onChange={e => setSubscriptionId(e.target.value)} /></div>
        </>)}

        {subType === "elasticache" && (<>
          <div><label style={labelStyle}>AWS Access Key ID</label><input style={inputStyle} placeholder="AKIA..." value={awsAccessKeyId} onChange={e => setAwsAccessKeyId(e.target.value)} /></div>
          <div><label style={labelStyle}>AWS Secret Access Key</label><input style={inputStyle} type="password" placeholder="Secret key" value={awsSecretAccessKey} onChange={e => setAwsSecretAccessKey(e.target.value)} /></div>
          <div><label style={labelStyle}>Region</label><input style={inputStyle} placeholder="us-east-1" value={awsRegion} onChange={e => setAwsRegion(e.target.value)} /></div>
          <div><label style={labelStyle}>Cluster ID</label><input style={inputStyle} placeholder="my-redis-cluster" value={clusterId} onChange={e => setClusterId(e.target.value)} /></div>
        </>)}

        {subType === "self-hosted" && (<>
          <div>
            <label style={labelStyle}>Redis URL</label>
            <input style={inputStyle} placeholder="redis://user:pass@host:6379" value={redisUrl} onChange={e => setRedisUrl(e.target.value)} />
          </div>
          <label style={{ display: "flex", alignItems: "center", gap: "8px", color: "#c4c5ca", fontSize: "13px", cursor: "pointer" }}>
            <input type="checkbox" checked={tlsEnabled} onChange={e => setTlsEnabled(e.target.checked)} /> Enable TLS
          </label>
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
              style={{ background: "#dc382d", color: "#fff", border: "none", padding: "10px 24px", borderRadius: "8px", cursor: "pointer", fontSize: "14px", fontWeight: "600" }}>
              {connecting ? "Connecting..." : "Connect & Start Monitoring"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
