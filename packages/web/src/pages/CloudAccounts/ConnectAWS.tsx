import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../../api/client";

const AWS_REGIONS = [
  "us-east-1", "us-east-2", "us-west-1", "us-west-2",
  "eu-west-1", "eu-west-2", "eu-central-1",
  "ap-southeast-1", "ap-southeast-2", "ap-northeast-1",
  "ca-central-1", "sa-east-1",
];

export function ConnectAWS() {
  const navigate = useNavigate();
  const [name, setName] = useState("");
  const [accessKeyId, setAccessKeyId] = useState("");
  const [secretAccessKey, setSecretAccessKey] = useState("");
  const [awsRegion, setAwsRegion] = useState("us-east-1");
  const [roleArn, setRoleArn] = useState("");
  const [validating, setValidating] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [validation, setValidation] = useState<any>(null);
  const [error, setError] = useState("");

  const handleValidate = async () => {
    setValidating(true);
    setError("");
    try {
      const result = await api.validateCredential("aws", {
        provider: "aws",
        awsAccessKeyId: accessKeyId,
        awsSecretAccessKey: secretAccessKey,
        awsRegion,
        awsRoleArn: roleArn || undefined,
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
        provider: "aws",
        name: name || validation?.accountName || "AWS Account",
        credential: {
          provider: "aws",
          awsAccessKeyId: accessKeyId,
          awsSecretAccessKey: secretAccessKey,
          awsRegion,
          awsRoleArn: roleArn || undefined,
        },
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
      <h1 style={{ fontFamily: "Outfit, sans-serif", fontSize: "24px", fontWeight: "700", color: "#fff", marginBottom: "8px" }}>Connect AWS</h1>
      <p style={{ color: "#6b7280", marginBottom: "32px", fontSize: "14px" }}>
        Provide IAM credentials with read access to EC2, Lambda, RDS, ECS, EKS, S3, SageMaker, and Cost Explorer.
      </p>

      <div style={{ display: "flex", flexDirection: "column", gap: "20px" }}>
        <div>
          <label style={labelStyle}>Account Name</label>
          <input style={inputStyle} placeholder="e.g., Production AWS" value={name} onChange={e => setName(e.target.value)} />
        </div>

        <div>
          <label style={labelStyle}>AWS Access Key ID</label>
          <input style={inputStyle} placeholder="AKIAIOSFODNN7EXAMPLE" value={accessKeyId} onChange={e => setAccessKeyId(e.target.value)} />
        </div>

        <div>
          <label style={labelStyle}>AWS Secret Access Key</label>
          <input style={{ ...inputStyle, fontFamily: "monospace" }} type="password" placeholder="Paste your secret access key"
            value={secretAccessKey} onChange={e => setSecretAccessKey(e.target.value)} />
        </div>

        <div>
          <label style={labelStyle}>Region</label>
          <select style={{ ...inputStyle, cursor: "pointer" }} value={awsRegion} onChange={e => setAwsRegion(e.target.value)}>
            {AWS_REGIONS.map(r => <option key={r} value={r}>{r}</option>)}
          </select>
          <p style={{ fontSize: "12px", color: "#6b7280", marginTop: "4px" }}>Primary region to monitor. Multi-region resources (S3, Cost Explorer) are monitored globally.</p>
        </div>

        <div>
          <label style={labelStyle}>IAM Role ARN (optional)</label>
          <input style={inputStyle} placeholder="arn:aws:iam::123456789012:role/KillSwitchRole" value={roleArn} onChange={e => setRoleArn(e.target.value)} />
          <p style={{ fontSize: "12px", color: "#6b7280", marginTop: "4px" }}>
            For cross-account monitoring. The role must trust the credentials above and have the required permissions.
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
            <button onClick={handleValidate} disabled={validating || !accessKeyId || !secretAccessKey}
              style={{ background: "rgba(255,255,255,0.08)", color: "#fff", border: "1px solid rgba(255,255,255,0.15)", padding: "10px 24px", borderRadius: "8px", cursor: "pointer", fontSize: "14px", fontWeight: "600", opacity: (!accessKeyId || !secretAccessKey) ? 0.5 : 1 }}>
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
