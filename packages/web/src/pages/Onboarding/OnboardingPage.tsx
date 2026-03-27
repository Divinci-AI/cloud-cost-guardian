import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth0 } from "@auth0/auth0-react";
import { api } from "../../api/client";

type Step = "welcome" | "provider" | "connect" | "thresholds" | "alerts" | "done";

const providers = [
  { id: "cloudflare", name: "Cloudflare", color: "#f6821f", desc: "Workers, R2, D1, Queues, Stream" },
  { id: "gcp", name: "Google Cloud", color: "#4285f4", desc: "Cloud Run, Compute, GKE, BigQuery" },
  { id: "aws", name: "Amazon Web Services", color: "#ff9900", desc: "EC2, Lambda, RDS, ECS, S3" },
];

const presets = [
  { id: "cost-runaway", name: "Cost Runaway Protection", desc: "Auto-kill services exceeding daily cost limit" },
  { id: "ddos", name: "DDoS Protection", desc: "Kill services getting excessive request volume" },
  { id: "error-storm", name: "Error Storm Protection", desc: "Scale down on sustained high error rate" },
];

const cardStyle = {
  padding: "24px",
  background: "rgba(255,255,255,0.03)",
  border: "1px solid rgba(255,255,255,0.08)",
  borderRadius: "12px",
  cursor: "pointer",
  transition: "border-color 0.2s",
};

const selectedCardStyle = {
  ...cardStyle,
  borderColor: "rgba(92, 226, 231, 0.4)",
  background: "rgba(92, 226, 231, 0.05)",
};

const inputStyle = {
  width: "100%", padding: "10px 14px", background: "rgba(255,255,255,0.05)",
  border: "1px solid rgba(255,255,255,0.12)", borderRadius: "8px",
  color: "#fff", fontSize: "14px", fontFamily: "JetBrains Mono, monospace",
  outline: "none",
};

const labelStyle = { display: "block" as const, marginBottom: "6px", fontSize: "13px", fontWeight: "600" as const, color: "#c4c5ca" };

const btnPrimary = {
  background: "linear-gradient(135deg, #c25800, #e06800)", color: "#fff", border: "none",
  padding: "12px 28px", borderRadius: "8px", fontSize: "15px", fontWeight: "700" as const, cursor: "pointer",
};

const btnSecondary = {
  background: "rgba(255,255,255,0.08)", color: "#fff",
  border: "1px solid rgba(255,255,255,0.15)",
  padding: "12px 28px", borderRadius: "8px", fontSize: "15px", fontWeight: "600" as const, cursor: "pointer",
};

export function OnboardingPage({ onComplete }: { onComplete: () => void }) {
  const { user } = useAuth0();
  const navigate = useNavigate();
  const [step, setStep] = useState<Step>("welcome");
  const [selectedProvider, setSelectedProvider] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  // Connect form state
  const [accountName, setAccountName] = useState("");
  const [field1, setField1] = useState(""); // Account ID / Project ID / Access Key
  const [field2, setField2] = useState(""); // API Token / Service Account JSON / Secret Key
  const [field3, setField3] = useState(""); // AWS region
  const [validation, setValidation] = useState<any>(null);

  // Threshold & alert state
  const [selectedPresets, setSelectedPresets] = useState<string[]>(["cost-runaway"]);
  const [alertType, setAlertType] = useState<"email" | "discord" | "slack" | "">("email");
  const [alertValue, setAlertValue] = useState("");

  const firstName = user?.name?.split(" ")[0] || user?.email?.split("@")[0] || "there";

  const getProviderFields = () => {
    switch (selectedProvider) {
      case "cloudflare":
        return { label1: "Cloudflare Account ID", placeholder1: "e.g., 14a6fa23390363382f378b5bd4a0f849", label2: "API Token", placeholder2: "Paste your API token", showField3: false };
      case "gcp":
        return { label1: "GCP Project ID", placeholder1: "e.g., my-project-123", label2: "Service Account Key (JSON)", placeholder2: "Paste your service account key JSON", showField3: false };
      case "aws":
        return { label1: "AWS Access Key ID", placeholder1: "e.g., AKIAIOSFODNN7EXAMPLE", label2: "Secret Access Key", placeholder2: "Paste your secret access key", showField3: true, label3: "Region", placeholder3: "e.g., us-east-1" };
      default:
        return { label1: "", placeholder1: "", label2: "", placeholder2: "", showField3: false };
    }
  };

  const buildCredential = () => {
    switch (selectedProvider) {
      case "cloudflare":
        return { provider: "cloudflare", accountId: field1, apiToken: field2 };
      case "gcp":
        return { provider: "gcp", projectId: field1, serviceAccountKey: field2 };
      case "aws":
        return { provider: "aws", accessKeyId: field1, secretAccessKey: field2, region: field3 || "us-east-1" };
      default:
        return {};
    }
  };

  const handleValidate = async () => {
    setLoading(true);
    setError("");
    try {
      const result = await api.validateCredential(selectedProvider!, buildCredential());
      setValidation(result);
      if (!result.valid) setError(result.error || "Invalid credentials");
    } catch (e: any) {
      setError(e.message);
    }
    setLoading(false);
  };

  const handleConnect = async () => {
    setLoading(true);
    setError("");
    try {
      await api.connectCloudAccount({
        provider: selectedProvider!,
        name: accountName || validation?.accountName || `${selectedProvider} account`,
        credential: buildCredential(),
      });
      setStep("thresholds");
    } catch (e: any) {
      setError(e.message);
    }
    setLoading(false);
  };

  const handleApplyPresets = async () => {
    setLoading(true);
    setError("");
    try {
      for (const presetId of selectedPresets) {
        await api.applyPreset(presetId);
      }
      setStep("alerts");
    } catch (e: any) {
      setError(e.message);
    }
    setLoading(false);
  };

  const handleSetupAlerts = async () => {
    setLoading(true);
    setError("");
    try {
      if (alertType && alertValue) {
        const channel = {
          type: alertType,
          name: alertType === "email" ? "Email" : alertType === "discord" ? "Discord" : "Slack",
          config: alertType === "email" ? { email: alertValue } : { webhookUrl: alertValue },
          enabled: true,
        };
        await api.updateAlertChannels([channel]);
      }
      setStep("done");
    } catch (e: any) {
      setError(e.message);
    }
    setLoading(false);
  };

  const handleFinish = async () => {
    setLoading(true);
    try {
      await api.completeOnboarding();
      onComplete();
      navigate("/");
    } catch {
      // Non-critical — navigate anyway
      onComplete();
      navigate("/");
    }
  };

  const stepIndicator = (
    <div style={{ display: "flex", gap: "8px", justifyContent: "center", marginBottom: "48px" }}>
      {["welcome", "provider", "connect", "thresholds", "alerts", "done"].map((s, i) => (
        <div key={s} style={{
          width: s === step ? "32px" : "8px", height: "8px", borderRadius: "4px",
          background: s === step ? "#c25800" : "rgba(255,255,255,0.12)",
          transition: "all 0.3s",
        }} />
      ))}
    </div>
  );

  return (
    <div style={{ maxWidth: "640px", margin: "0 auto", padding: "60px 24px" }}>
      {stepIndicator}

      {/* ── Welcome ─────────────────────────────────────── */}
      {step === "welcome" && (
        <div style={{ textAlign: "center" }}>
          <div style={{ fontSize: "48px", marginBottom: "16px" }}>&#9889;</div>
          <h1 style={{ fontFamily: "Outfit, sans-serif", fontSize: "32px", fontWeight: "700", color: "#fff", marginBottom: "12px" }}>
            Welcome, {firstName}
          </h1>
          <p style={{ color: "#8b8fa3", fontSize: "17px", maxWidth: "480px", margin: "0 auto 40px", lineHeight: "1.6" }}>
            Let's set up cost protection for your cloud infrastructure.
            We'll connect a provider, set spending thresholds, and configure alerts.
            Takes about 2 minutes.
          </p>
          <button onClick={() => setStep("provider")} style={btnPrimary}>
            Let's Go
          </button>
        </div>
      )}

      {/* ── Provider Selection ──────────────────────────── */}
      {step === "provider" && (
        <div>
          <h2 style={{ fontFamily: "Outfit, sans-serif", fontSize: "24px", fontWeight: "700", color: "#fff", marginBottom: "8px" }}>
            Choose your cloud provider
          </h2>
          <p style={{ color: "#8b8fa3", marginBottom: "32px", fontSize: "15px" }}>
            You can add more providers later. Pick the one you want to protect first.
          </p>
          <div style={{ display: "flex", flexDirection: "column", gap: "12px", marginBottom: "32px" }}>
            {providers.map(p => (
              <div
                key={p.id}
                onClick={() => setSelectedProvider(p.id)}
                style={selectedProvider === p.id ? selectedCardStyle : cardStyle}
              >
                <div style={{ display: "flex", alignItems: "center", gap: "14px" }}>
                  <div style={{ width: "12px", height: "12px", borderRadius: "50%", background: p.color, flexShrink: 0 }} />
                  <div>
                    <div style={{ color: "#fff", fontFamily: "Outfit, sans-serif", fontWeight: "600", fontSize: "16px" }}>{p.name}</div>
                    <div style={{ color: "#6b7280", fontSize: "13px", marginTop: "2px" }}>{p.desc}</div>
                  </div>
                </div>
              </div>
            ))}
          </div>
          <div style={{ display: "flex", gap: "12px" }}>
            <button onClick={() => setStep("welcome")} style={btnSecondary}>Back</button>
            <button onClick={() => { setStep("connect"); setValidation(null); setField1(""); setField2(""); setField3(""); setError(""); }}
              disabled={!selectedProvider} style={{ ...btnPrimary, opacity: selectedProvider ? 1 : 0.5 }}>
              Continue
            </button>
          </div>
        </div>
      )}

      {/* ── Connect Credentials ────────────────────────── */}
      {step === "connect" && (
        <div>
          <h2 style={{ fontFamily: "Outfit, sans-serif", fontSize: "24px", fontWeight: "700", color: "#fff", marginBottom: "8px" }}>
            Connect {providers.find(p => p.id === selectedProvider)?.name}
          </h2>
          <p style={{ color: "#8b8fa3", marginBottom: "32px", fontSize: "15px" }}>
            Your credentials are encrypted at rest and never shared.
          </p>
          <div style={{ display: "flex", flexDirection: "column", gap: "20px" }}>
            <div>
              <label style={labelStyle}>Account Name (optional)</label>
              <input style={inputStyle} placeholder="e.g., Production" value={accountName} onChange={e => setAccountName(e.target.value)} />
            </div>
            <div>
              <label style={labelStyle}>{getProviderFields().label1}</label>
              <input style={inputStyle} placeholder={getProviderFields().placeholder1} value={field1} onChange={e => setField1(e.target.value)} />
            </div>
            <div>
              <label style={labelStyle}>{getProviderFields().label2}</label>
              <input style={{ ...inputStyle }} type="password" placeholder={getProviderFields().placeholder2} value={field2} onChange={e => setField2(e.target.value)} />
            </div>
            {getProviderFields().showField3 && (
              <div>
                <label style={labelStyle}>{(getProviderFields() as any).label3}</label>
                <input style={inputStyle} placeholder={(getProviderFields() as any).placeholder3} value={field3} onChange={e => setField3(e.target.value)} />
              </div>
            )}

            {error && (
              <div style={{ padding: "12px 16px", background: "rgba(255,107,107,0.1)", border: "1px solid rgba(255,107,107,0.2)", borderRadius: "8px", color: "#ff6b6b", fontSize: "13px" }}>
                {error}
              </div>
            )}

            {validation?.valid && (
              <div style={{ padding: "12px 16px", background: "rgba(92,226,231,0.1)", border: "1px solid rgba(92,226,231,0.2)", borderRadius: "8px", color: "#5ce2e7", fontSize: "13px" }}>
                Validated: {validation.accountName || validation.projectId || "credentials OK"}
              </div>
            )}

            <div style={{ display: "flex", gap: "12px" }}>
              <button onClick={() => setStep("provider")} style={btnSecondary}>Back</button>
              {!validation?.valid ? (
                <button onClick={handleValidate} disabled={loading || !field1 || !field2}
                  style={{ ...btnPrimary, opacity: (!field1 || !field2) ? 0.5 : 1 }}>
                  {loading ? "Validating..." : "Validate Credentials"}
                </button>
              ) : (
                <button onClick={handleConnect} disabled={loading} style={btnPrimary}>
                  {loading ? "Connecting..." : "Connect & Continue"}
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {/* ── Thresholds / Rule Presets ──────────────────── */}
      {step === "thresholds" && (
        <div>
          <h2 style={{ fontFamily: "Outfit, sans-serif", fontSize: "24px", fontWeight: "700", color: "#fff", marginBottom: "8px" }}>
            Set up protection rules
          </h2>
          <p style={{ color: "#8b8fa3", marginBottom: "32px", fontSize: "15px" }}>
            Choose rule presets to apply. You can customize thresholds later.
          </p>
          <div style={{ display: "flex", flexDirection: "column", gap: "12px", marginBottom: "32px" }}>
            {presets.map(p => {
              const selected = selectedPresets.includes(p.id);
              return (
                <div
                  key={p.id}
                  onClick={() => setSelectedPresets(selected ? selectedPresets.filter(id => id !== p.id) : [...selectedPresets, p.id])}
                  style={selected ? selectedCardStyle : cardStyle}
                >
                  <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
                    <div style={{
                      width: "20px", height: "20px", borderRadius: "4px", flexShrink: 0,
                      border: selected ? "2px solid #5ce2e7" : "2px solid rgba(255,255,255,0.15)",
                      background: selected ? "rgba(92,226,231,0.15)" : "transparent",
                      display: "flex", alignItems: "center", justifyContent: "center",
                      fontSize: "12px", color: "#5ce2e7",
                    }}>
                      {selected ? "\u2713" : ""}
                    </div>
                    <div>
                      <div style={{ color: "#fff", fontWeight: "600", fontSize: "15px" }}>{p.name}</div>
                      <div style={{ color: "#6b7280", fontSize: "13px", marginTop: "2px" }}>{p.desc}</div>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
          {error && (
            <div style={{ padding: "12px 16px", background: "rgba(255,107,107,0.1)", border: "1px solid rgba(255,107,107,0.2)", borderRadius: "8px", color: "#ff6b6b", fontSize: "13px", marginBottom: "16px" }}>
              {error}
            </div>
          )}
          <div style={{ display: "flex", gap: "12px" }}>
            <button onClick={() => setStep("alerts")} style={btnSecondary}>Skip</button>
            <button onClick={handleApplyPresets} disabled={loading || selectedPresets.length === 0}
              style={{ ...btnPrimary, opacity: selectedPresets.length === 0 ? 0.5 : 1 }}>
              {loading ? "Applying..." : "Apply & Continue"}
            </button>
          </div>
        </div>
      )}

      {/* ── Alert Channel ──────────────────────────────── */}
      {step === "alerts" && (
        <div>
          <h2 style={{ fontFamily: "Outfit, sans-serif", fontSize: "24px", fontWeight: "700", color: "#fff", marginBottom: "8px" }}>
            Set up alerts
          </h2>
          <p style={{ color: "#8b8fa3", marginBottom: "32px", fontSize: "15px" }}>
            Get notified when a threshold is breached. You can add more channels later.
          </p>
          <div style={{ display: "flex", gap: "8px", marginBottom: "24px" }}>
            {(["email", "discord", "slack"] as const).map(type => (
              <button key={type} onClick={() => { setAlertType(type); setAlertValue(type === "email" ? (user?.email || "") : ""); }}
                style={{
                  padding: "8px 20px", borderRadius: "8px", fontSize: "14px", fontWeight: "600", cursor: "pointer",
                  background: alertType === type ? "rgba(92,226,231,0.1)" : "rgba(255,255,255,0.05)",
                  border: alertType === type ? "1px solid rgba(92,226,231,0.3)" : "1px solid rgba(255,255,255,0.1)",
                  color: alertType === type ? "#5ce2e7" : "#c4c5ca",
                }}>
                {type.charAt(0).toUpperCase() + type.slice(1)}
              </button>
            ))}
          </div>
          {alertType && (
            <div style={{ marginBottom: "32px" }}>
              <label style={labelStyle}>
                {alertType === "email" ? "Email Address" : alertType === "discord" ? "Discord Webhook URL" : "Slack Webhook URL"}
              </label>
              <input
                style={inputStyle}
                type={alertType === "email" ? "email" : "url"}
                placeholder={alertType === "email" ? user?.email || "you@example.com" : "https://hooks.example.com/..."}
                value={alertValue}
                onChange={e => setAlertValue(e.target.value)}
              />
            </div>
          )}
          {error && (
            <div style={{ padding: "12px 16px", background: "rgba(255,107,107,0.1)", border: "1px solid rgba(255,107,107,0.2)", borderRadius: "8px", color: "#ff6b6b", fontSize: "13px", marginBottom: "16px" }}>
              {error}
            </div>
          )}
          <div style={{ display: "flex", gap: "12px" }}>
            <button onClick={() => setStep("done")} style={btnSecondary}>Skip</button>
            <button onClick={handleSetupAlerts} disabled={loading || !alertValue}
              style={{ ...btnPrimary, opacity: !alertValue ? 0.5 : 1 }}>
              {loading ? "Saving..." : "Save & Continue"}
            </button>
          </div>
        </div>
      )}

      {/* ── Done ───────────────────────────────────────── */}
      {step === "done" && (
        <div style={{ textAlign: "center" }}>
          <div style={{ fontSize: "48px", marginBottom: "16px" }}>&#9989;</div>
          <h2 style={{ fontFamily: "Outfit, sans-serif", fontSize: "28px", fontWeight: "700", color: "#fff", marginBottom: "12px" }}>
            You're protected
          </h2>
          <p style={{ color: "#8b8fa3", fontSize: "16px", maxWidth: "440px", margin: "0 auto 40px", lineHeight: "1.6" }}>
            Kill Switch is now monitoring your cloud account. We'll alert you the moment spending goes out of bounds.
          </p>
          <button onClick={handleFinish} disabled={loading} style={btnPrimary}>
            {loading ? "Finishing..." : "Go to Dashboard"}
          </button>
        </div>
      )}
    </div>
  );
}
