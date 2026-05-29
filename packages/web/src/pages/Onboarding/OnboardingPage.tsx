import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useUser } from "@clerk/clerk-react";
import { api, isTierLimitError } from "../../api/client";
import { UpgradeBanner } from "../../components/TierLimitBanner";

type Step = "welcome" | "provider" | "connect" | "thresholds" | "alerts" | "done";

const providers = [
  { id: "cloudflare", name: "Cloudflare", color: "#f6821f", desc: "Workers, R2, D1, Queues, Stream", group: "infra" },
  { id: "gcp", name: "Google Cloud", color: "#4285f4", desc: "Cloud Run, Compute, GKE, BigQuery", group: "infra" },
  { id: "aws", name: "Amazon Web Services", color: "#ff9900", desc: "EC2, Lambda, RDS, ECS, S3", group: "infra" },
  { id: "runpod", name: "RunPod", color: "#6c3baa", desc: "GPU pods, serverless endpoints", group: "compute" },
  { id: "openai", name: "OpenAI", color: "#10a37f", desc: "Token usage, request counts, cost", group: "ai" },
  { id: "anthropic", name: "Anthropic", color: "#d4a27f", desc: "Claude API usage and cost", group: "ai" },
  { id: "xai", name: "xAI (Grok)", color: "#1d9bf0", desc: "Grok API usage and cost", group: "ai" },
  { id: "replicate", name: "Replicate", color: "#ff6b35", desc: "GPU prediction costs, model usage", group: "ai" },
  { id: "vercel", name: "Vercel", color: "#fff", desc: "Functions, bandwidth, build minutes", group: "platform" },
  { id: "datadog", name: "Datadog", color: "#632ca6", desc: "Hosts, log ingestion, custom metrics", group: "observability" },
  { id: "snowflake", name: "Snowflake", color: "#29b5e8", desc: "Warehouse credits, query costs", group: "data" },
  { id: "redis", name: "Redis", color: "#dc382d", desc: "Memory, connections, ops/sec", group: "data" },
  { id: "mongodb", name: "MongoDB", color: "#00ed64", desc: "Atlas storage, connections, cost", group: "data" },
  { id: "neo4j", name: "Neo4j Aura", color: "#018bff", desc: "Graph DB memory, storage, cost", group: "data" },
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
  const { user } = useUser();
  const navigate = useNavigate();
  const [step, setStep] = useState<Step>("welcome");
  const [selectedProviders, setSelectedProviders] = useState<string[]>([]);
  const [currentProviderIndex, setCurrentProviderIndex] = useState(0);
  const [error, setError] = useState("");
  const [rawError, setRawError] = useState<unknown>(null);
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

  const firstName = user?.firstName || user?.primaryEmailAddress?.emailAddress?.split("@")[0] || "there";

  const selectedProvider = selectedProviders[currentProviderIndex] || null;

  const toggleProvider = (id: string) => {
    setSelectedProviders(prev =>
      prev.includes(id) ? prev.filter(p => p !== id) : [...prev, id]
    );
  };

  const getProviderFields = (): { label1: string; placeholder1: string; label2: string; placeholder2: string; showField3: boolean; label3?: string; placeholder3?: string; isField2Password?: boolean } => {
    switch (selectedProvider) {
      case "cloudflare":
        return { label1: "Cloudflare Account ID", placeholder1: "e.g., 14a6fa23390363382f378b5bd4a0f849", label2: "API Token", placeholder2: "Paste your API token", showField3: false };
      case "gcp":
        return { label1: "GCP Project ID", placeholder1: "e.g., my-project-123", label2: "Service Account Key (JSON)", placeholder2: "Paste your service account key JSON", showField3: false, isField2Password: false };
      case "aws":
        return { label1: "AWS Access Key ID", placeholder1: "e.g., AKIAIOSFODNN7EXAMPLE", label2: "Secret Access Key", placeholder2: "Paste your secret access key", showField3: true, label3: "Region", placeholder3: "e.g., us-east-1" };
      case "runpod":
        return { label1: "RunPod API Key", placeholder1: "Paste your RunPod API key", label2: "", placeholder2: "", showField3: false };
      case "openai":
        return { label1: "OpenAI API Key", placeholder1: "sk-...", label2: "Organization ID (optional)", placeholder2: "org-...", showField3: false, isField2Password: false };
      case "anthropic":
        return { label1: "Anthropic API Key", placeholder1: "sk-ant-...", label2: "Workspace ID (optional)", placeholder2: "wrkspc_...", showField3: false, isField2Password: false };
      case "xai":
        return { label1: "xAI API Key", placeholder1: "Paste your xAI API key", label2: "", placeholder2: "", showField3: false };
      case "replicate":
        return { label1: "Replicate API Token", placeholder1: "r8_...", label2: "", placeholder2: "", showField3: false };
      case "vercel":
        return { label1: "Vercel API Token", placeholder1: "Paste your Vercel token", label2: "Team ID (optional)", placeholder2: "team_...", showField3: false, isField2Password: false };
      case "datadog":
        return { label1: "Datadog API Key", placeholder1: "Paste your API key", label2: "Application Key", placeholder2: "Paste your application key", showField3: false };
      case "snowflake":
        return { label1: "Snowflake Account", placeholder1: "e.g., xy12345.us-east-1", label2: "Username", placeholder2: "Your Snowflake username", showField3: true, label3: "Password", placeholder3: "Your Snowflake password", isField2Password: false };
      case "redis":
        return { label1: "Redis Cloud Account Key", placeholder1: "Paste your account key", label2: "Secret Key", placeholder2: "Paste your secret key", showField3: true, label3: "Subscription ID", placeholder3: "Your subscription ID" };
      case "mongodb":
        return { label1: "Atlas Public Key", placeholder1: "Paste your public key", label2: "Private Key", placeholder2: "Paste your private key", showField3: true, label3: "Project ID", placeholder3: "Your Atlas project ID" };
      case "neo4j":
        return { label1: "Client ID", placeholder1: "Neo4j Aura API client ID", label2: "Client Secret", placeholder2: "Neo4j Aura API client secret", showField3: true, label3: "Instance ID (optional)", placeholder3: "e.g., 9c96c178" };
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
      case "runpod":
        return { provider: "runpod", apiKey: field1 };
      case "openai":
        return { provider: "openai", apiKey: field1, ...(field2 ? { organizationId: field2 } : {}) };
      case "anthropic":
        return { provider: "anthropic", apiKey: field1, ...(field2 ? { workspaceId: field2 } : {}) };
      case "xai":
        return { provider: "xai", apiKey: field1 };
      case "replicate":
        return { provider: "replicate", apiToken: field1 };
      case "vercel":
        return { provider: "vercel", apiToken: field1, ...(field2 ? { teamId: field2 } : {}) };
      case "datadog":
        return { provider: "datadog", apiKey: field1, applicationKey: field2 };
      case "snowflake":
        return { provider: "snowflake", account: field1, username: field2, password: field3 };
      case "redis":
        return { provider: "redis", type: "cloud", accountKey: field1, secretKey: field2, subscriptionId: field3 };
      case "mongodb":
        return { provider: "mongodb", type: "atlas", publicKey: field1, privateKey: field2, projectId: field3 };
      case "neo4j":
        return { provider: "neo4j", neo4jClientId: field1, neo4jClientSecret: field2, ...(field3 ? { neo4jInstanceId: field3 } : {}) };
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
    setRawError(null);
    try {
      await api.connectCloudAccount({
        provider: selectedProvider!,
        name: accountName || validation?.accountName || `${selectedProvider} account`,
        credential: buildCredential(),
      });
      // Move to the next provider, or to thresholds if all done
      const nextIndex = currentProviderIndex + 1;
      if (nextIndex < selectedProviders.length) {
        setCurrentProviderIndex(nextIndex);
        setAccountName("");
        setField1("");
        setField2("");
        setField3("");
        setValidation(null);
        setError("");
      } else {
        setStep("thresholds");
      }
    } catch (e: any) {
      setRawError(e);
      if (!isTierLimitError(e)) setError(e.message);
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
          <div style={{ marginTop: "24px" }}>
            <button onClick={handleFinish} style={{ background: "none", border: "none", color: "#9ca3af", fontSize: "13px", cursor: "pointer", textDecoration: "underline" }}>
              Skip to Dashboard
            </button>
          </div>
        </div>
      )}

      {/* ── Provider Selection ──────────────────────────── */}
      {step === "provider" && (
        <div>
          <h2 style={{ fontFamily: "Outfit, sans-serif", fontSize: "24px", fontWeight: "700", color: "#fff", marginBottom: "8px" }}>
            Choose your cloud providers
          </h2>
          <p style={{ color: "#8b8fa3", marginBottom: "32px", fontSize: "15px" }}>
            Select all the providers you want to protect. You'll connect each one next.
          </p>
          <div style={{ display: "flex", flexDirection: "column", gap: "12px", marginBottom: "32px" }}>
            {[
              { key: "infra", label: "Cloud Infrastructure" },
              { key: "compute", label: "GPU Compute" },
              { key: "ai", label: "AI / LLM APIs" },
              { key: "platform", label: "Platforms" },
              { key: "observability", label: "Observability" },
              { key: "data", label: "Data & Databases" },
            ].map(group => {
              const groupProviders = providers.filter(p => p.group === group.key);
              if (groupProviders.length === 0) return null;
              return (
                <div key={group.key}>
                  <div style={{ fontSize: "11px", fontWeight: "700", color: "#9ca3af", textTransform: "uppercase", letterSpacing: "1px", marginBottom: "8px", marginTop: "8px" }}>
                    {group.label}
                  </div>
                  <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
                    {groupProviders.map(p => {
                      const selected = selectedProviders.includes(p.id);
                      return (
                        <div
                          key={p.id}
                          onClick={() => toggleProvider(p.id)}
                          style={selected ? selectedCardStyle : cardStyle}
                        >
                          <div style={{ display: "flex", alignItems: "center", gap: "14px" }}>
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
                              <div style={{ color: "#fff", fontFamily: "Outfit, sans-serif", fontWeight: "600", fontSize: "16px" }}>{p.name}</div>
                              <div style={{ color: "#9ca3af", fontSize: "13px", marginTop: "2px" }}>{p.desc}</div>
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>
          <div style={{ display: "flex", gap: "12px" }}>
            <button onClick={() => setStep("welcome")} style={btnSecondary}>Back</button>
            <button onClick={() => { setCurrentProviderIndex(0); setStep("connect"); setValidation(null); setField1(""); setField2(""); setField3(""); setError(""); }}
              disabled={selectedProviders.length === 0} style={{ ...btnPrimary, opacity: selectedProviders.length > 0 ? 1 : 0.5 }}>
              Continue ({selectedProviders.length} selected)
            </button>
          </div>
        </div>
      )}

      {/* ── Connect Credentials ────────────────────────── */}
      {step === "connect" && (
        <div>
          <h2 style={{ fontFamily: "Outfit, sans-serif", fontSize: "24px", fontWeight: "700", color: "#fff", marginBottom: "8px" }}>
            Connect {providers.find(p => p.id === selectedProvider)?.name}
            {selectedProviders.length > 1 && <span style={{ color: "#9ca3af", fontWeight: "400", fontSize: "16px" }}> ({currentProviderIndex + 1} of {selectedProviders.length})</span>}
          </h2>
          <p style={{ color: "#8b8fa3", marginBottom: "16px", fontSize: "15px" }}>
            Your credentials are encrypted at rest and never shared.
          </p>

          {/* CLI / AI alternative tip */}
          <div style={{ padding: "12px 16px", background: "rgba(92,226,231,0.06)", border: "1px solid rgba(92,226,231,0.15)", borderRadius: "8px", marginBottom: "28px", fontSize: "13px", color: "#8b8fa3", lineHeight: "1.5" }}>
            <span style={{ color: "#5ce2e7", fontWeight: "600" }}>Tip:</span> You can also set this up via the{" "}
            <a href="https://kill-switch.net/docs/cli" target="_blank" rel="noopener" style={{ color: "#5ce2e7", textDecoration: "underline" }}>Kill Switch CLI</a>
            {" "}or pass your API key to your AI coding assistant to configure it for you.
          </div>

          <div style={{ display: "flex", flexDirection: "column", gap: "20px" }}>
            <div>
              <label style={labelStyle}>Account Name (optional)</label>
              <input style={inputStyle} placeholder="e.g., Production" value={accountName} onChange={e => setAccountName(e.target.value)} />
            </div>
            <div>
              <label style={labelStyle}>{getProviderFields().label1}</label>
              <input style={inputStyle} placeholder={getProviderFields().placeholder1} value={field1} onChange={e => setField1(e.target.value)} />
              {/* Where to find it — visual hint */}
              {selectedProvider === "cloudflare" && (
                <div style={{ marginTop: "8px" }}>
                  <div style={{ fontSize: "12px", color: "#9ca3af", marginBottom: "6px" }}>Find it in your browser URL bar on any Cloudflare dashboard page:</div>
                  <div style={{ background: "#1a1a2e", border: "1px solid rgba(255,255,255,0.1)", borderRadius: "8px", padding: "8px 12px", display: "flex", alignItems: "center", gap: "8px", fontFamily: "JetBrains Mono, monospace", fontSize: "12px" }}>
                    <span style={{ color: "#9ca3af" }}>dash.cloudflare.com/</span>
                    <span style={{ color: "#5ce2e7", background: "rgba(92,226,231,0.12)", padding: "2px 6px", borderRadius: "4px", border: "1px dashed rgba(92,226,231,0.3)" }}>your-account-id</span>
                    <span style={{ color: "#9ca3af" }}>/example.com</span>
                  </div>
                </div>
              )}
              {selectedProvider === "gcp" && (
                <div style={{ fontSize: "12px", color: "#9ca3af", marginTop: "6px" }}>
                  Find it at <a href="https://console.cloud.google.com/home/dashboard" target="_blank" rel="noopener" style={{ color: "#5ce2e7" }}>console.cloud.google.com</a> in the project selector dropdown, or run <code style={{ background: "rgba(255,255,255,0.08)", padding: "1px 6px", borderRadius: "4px", color: "#c4c5ca" }}>gcloud config get-value project</code>
                </div>
              )}
              {selectedProvider === "aws" && (
                <div style={{ fontSize: "12px", color: "#9ca3af", marginTop: "6px" }}>
                  Find it in <a href="https://console.aws.amazon.com/iam/home#/security_credentials" target="_blank" rel="noopener" style={{ color: "#5ce2e7" }}>IAM &rarr; Security Credentials</a>, or run <code style={{ background: "rgba(255,255,255,0.08)", padding: "1px 6px", borderRadius: "4px", color: "#c4c5ca" }}>aws configure get aws_access_key_id</code>
                </div>
              )}
            </div>
            {getProviderFields().label2 && (
              <div>
                <label style={labelStyle}>{getProviderFields().label2}</label>
                {/* Secure vault indicator */}
                <div style={{ position: "relative" }}>
                  <input style={{ ...inputStyle, paddingRight: "140px" }} type={getProviderFields().isField2Password === false ? "text" : "password"} placeholder={getProviderFields().placeholder2} value={field2} onChange={e => setField2(e.target.value)} />
                  <div style={{ position: "absolute", right: "10px", top: "50%", transform: "translateY(-50%)", display: "flex", alignItems: "center", gap: "4px", fontSize: "11px", color: "#9ca3af", pointerEvents: "none" }}>
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0110 0v4"/></svg>
                    AES-256 encrypted
                  </div>
                </div>
                {selectedProvider === "cloudflare" && (
                  <div style={{ fontSize: "12px", color: "#9ca3af", marginTop: "6px", lineHeight: "1.6" }}>
                    <strong style={{ color: "#c4c5ca" }}>Important:</strong> Use an <strong style={{ color: "#c4c5ca" }}>API Token</strong> (not Global API Key).{" "}
                    <a href="https://dash.cloudflare.com/profile/api-tokens" target="_blank" rel="noopener" style={{ color: "#5ce2e7" }}>Create one here</a> with these permissions:
                    <div style={{ marginTop: "6px", padding: "8px 12px", background: "rgba(255,255,255,0.04)", borderRadius: "6px", fontFamily: "JetBrains Mono, monospace", fontSize: "11px", lineHeight: "1.8" }}>
                      <div><span style={{ color: "#5ce2e7" }}>Account &rarr; Account Analytics</span> &rarr; Read</div>
                      <div><span style={{ color: "#5ce2e7" }}>Account &rarr; Workers Scripts</span> &rarr; Edit</div>
                      <div><span style={{ color: "#5ce2e7" }}>Account &rarr; Workers R2 Storage</span> &rarr; Read</div>
                      <div><span style={{ color: "#5ce2e7" }}>Account &rarr; D1</span> &rarr; Read</div>
                      <div><span style={{ color: "#5ce2e7" }}>Zone &rarr; Zone</span> &rarr; Read</div>
                    </div>
                    <div style={{ marginTop: "4px" }}>Or use the <strong style={{ color: "#c4c5ca" }}>"Edit Cloudflare Workers"</strong> template as a starting point.</div>
                  </div>
                )}
                {selectedProvider === "gcp" && (
                  <div style={{ fontSize: "12px", color: "#9ca3af", marginTop: "6px" }}>
                    Create a service account at <a href="https://console.cloud.google.com/iam-admin/serviceaccounts" target="_blank" rel="noopener" style={{ color: "#5ce2e7" }}>IAM &rarr; Service Accounts</a>, then download the JSON key.
                  </div>
                )}
                {selectedProvider === "aws" && (
                  <div style={{ fontSize: "12px", color: "#9ca3af", marginTop: "6px" }}>
                    Found alongside your Access Key ID. Only shown once at creation — if lost, create a new key pair.
                  </div>
                )}
              </div>
            )}
            {getProviderFields().showField3 && (
              <div>
                <label style={labelStyle}>{getProviderFields().label3}</label>
                <input style={inputStyle} type={selectedProvider === "snowflake" ? "password" : "text"} placeholder={getProviderFields().placeholder3} value={field3} onChange={e => setField3(e.target.value)} />
                {selectedProvider === "aws" && (
                  <div style={{ fontSize: "12px", color: "#9ca3af", marginTop: "6px" }}>
                    Run <code style={{ background: "rgba(255,255,255,0.08)", padding: "1px 6px", borderRadius: "4px", color: "#c4c5ca" }}>aws configure get region</code> or check your AWS console URL.
                  </div>
                )}
              </div>
            )}

            <UpgradeBanner error={rawError} />

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
                <button onClick={handleValidate} disabled={loading || !field1 || (!!getProviderFields().label2 && !getProviderFields().placeholder2?.includes("optional") && !field2)}
                  style={{ ...btnPrimary, opacity: (!field1 || (!!getProviderFields().label2 && !getProviderFields().placeholder2?.includes("optional") && !field2)) ? 0.5 : 1 }}>
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
                      <div style={{ color: "#9ca3af", fontSize: "13px", marginTop: "2px" }}>{p.desc}</div>
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
            Get notified when a threshold is breached. PagerDuty, GitHub, and more channels are available later in Settings.
          </p>
          <div style={{ display: "flex", gap: "8px", marginBottom: "24px" }}>
            {(["email", "discord", "slack"] as const).map(type => (
              <button key={type} onClick={() => { setAlertType(type); setAlertValue(type === "email" ? (user?.primaryEmailAddress?.emailAddress || "") : ""); }}
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
                placeholder={alertType === "email" ? user?.primaryEmailAddress?.emailAddress || "you@example.com" : "https://hooks.example.com/..."}
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
          <div style={{
            maxWidth: "440px", margin: "0 auto 32px", padding: "16px 20px",
            background: "rgba(194, 88, 0, 0.08)", border: "1px solid rgba(224, 104, 0, 0.2)",
            borderRadius: "10px", textAlign: "left",
          }}>
            <div style={{ color: "#ff9d42", fontSize: "14px", fontWeight: "600", marginBottom: "6px" }}>
              You're on the Free plan
            </div>
            <div style={{ color: "#9ca3af", fontSize: "13px", lineHeight: "1.5" }}>
              1 cloud account, 6-hour check intervals, 1 alert channel.{" "}
              <a href="/billing?plan=pro" style={{ color: "#ff9d42", textDecoration: "underline" }}>
                Upgrade to Pro ($29/mo)
              </a>{" "}
              for 3 accounts, 5-minute checks, and 10 alert channels.
            </div>
          </div>
          <button onClick={handleFinish} disabled={loading} style={btnPrimary}>
            {loading ? "Finishing..." : "Go to Dashboard"}
          </button>
        </div>
      )}
    </div>
  );
}
