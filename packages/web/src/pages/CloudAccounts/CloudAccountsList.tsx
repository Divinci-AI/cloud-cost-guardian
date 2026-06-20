import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../../api/client";
import { useOrg } from "../../context/OrgContext";
import { ViolationChart } from "../../components/ViolationChart";
import { ErrorState } from "../../components/ErrorState";
import { useCan } from "../../hooks/useCan";

const statusColor = (s?: string) =>
  s === "error" ? "#ffa07a" : s === "violation" ? "#ff6b6b" : s === "ok" ? "#5ce2e7" : "#9ca3af";

// Managed databases where destructive auto-actions (pause-cluster / delete /
// flush-redis) are blocked by the account's productionProtected flag (default on).
const MANAGED_DB_PROVIDERS = new Set(["mongodb", "redis", "neo4j", "neon"]);
const isManagedDb = (provider?: string) => MANAGED_DB_PROVIDERS.has(provider || "");
// Default-on, and the API list returns the effective value (!== false).
const isProtected = (a: any) => a.productionProtected !== false;

const CREDENTIAL_HINTS: Record<string, Record<string, string>> = {
  cloudflare: {
    apiToken: "Create an API Token (not Global API Key) at dash.cloudflare.com/profile/api-tokens. Required permissions: Account Analytics: Read · Workers Scripts: Edit · Workers R2 Storage: Read · D1: Read · Zone: Read. Or use the \"Edit Cloudflare Workers\" template.",
  },
};

const CREDENTIAL_FIELDS: Record<string, { key: string; label: string; placeholder: string; secret?: boolean }[]> = {
  cloudflare: [
    { key: "apiToken", label: "API Token", placeholder: "Paste new Cloudflare API token", secret: true },
    { key: "accountId", label: "Account ID", placeholder: "Cloudflare account ID" },
  ],
  gcp: [
    { key: "projectId", label: "Project ID", placeholder: "GCP project ID" },
    { key: "serviceAccountKey", label: "Service Account JSON", placeholder: '{"type":"service_account",...}', secret: true },
  ],
  aws: [
    { key: "accessKeyId", label: "Access Key ID", placeholder: "AKIA..." },
    { key: "secretAccessKey", label: "Secret Access Key", placeholder: "Secret access key", secret: true },
    { key: "region", label: "Region", placeholder: "us-east-1" },
  ],
  runpod: [{ key: "apiKey", label: "API Key", placeholder: "Paste new RunPod API key", secret: true }],
  redis: [{ key: "redisUrl", label: "Redis URL", placeholder: "redis://...", secret: true }],
  mongodb: [{ key: "connectionString", label: "Connection String", placeholder: "mongodb+srv://...", secret: true }],
  openai: [{ key: "apiKey", label: "API Key", placeholder: "sk-...", secret: true }],
  anthropic: [{ key: "apiKey", label: "API Key", placeholder: "sk-ant-...", secret: true }],
  xai: [{ key: "apiKey", label: "API Key", placeholder: "xai-...", secret: true }],
  replicate: [{ key: "apiToken", label: "API Token", placeholder: "r8_...", secret: true }],
  snowflake: [
    { key: "account", label: "Account", placeholder: "orgname-accountname" },
    { key: "username", label: "Username", placeholder: "Username" },
    { key: "password", label: "Password", placeholder: "Password", secret: true },
    { key: "warehouse", label: "Warehouse", placeholder: "COMPUTE_WH" },
  ],
  vercel: [
    { key: "token", label: "Token", placeholder: "Vercel token", secret: true },
    { key: "teamId", label: "Team ID", placeholder: "team_... (optional)" },
  ],
  datadog: [
    { key: "apiKey", label: "API Key", placeholder: "Datadog API key", secret: true },
    { key: "appKey", label: "App Key", placeholder: "Datadog application key", secret: true },
    { key: "site", label: "Site", placeholder: "datadoghq.com" },
  ],
  neon: [
    { key: "neonApiKey", label: "API Key", placeholder: "Neon API key", secret: true },
    { key: "neonProjectId", label: "Project ID (optional)", placeholder: "e.g. icy-night-79929587" },
  ],
};

function UpdateCredentialsForm({ account, onSuccess, onCancel }: {
  account: any;
  onSuccess: () => void;
  onCancel: () => void;
}) {
  const fields = CREDENTIAL_FIELDS[account.provider] || [];
  // Pre-fill accountId / projectId from existing account data so user only needs to re-enter secrets
  const [values, setValues] = useState<Record<string, string>>(() => {
    const prefill: Record<string, string> = {};
    if (account.provider === "cloudflare") prefill.accountId = account.providerAccountId || "";
    if (account.provider === "gcp") prefill.projectId = account.providerAccountId || "";
    if (account.provider === "aws") prefill.region = "us-east-1";
    if (account.provider === "snowflake") prefill.account = account.providerAccountId || "";
    return prefill;
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const handleSave = async () => {
    setSaving(true);
    setError("");
    try {
      await api.updateCloudAccountCredentials(account.id, { provider: account.provider, ...values });
      onSuccess();
    } catch (e: any) {
      setError(e.message);
    }
    setSaving(false);
  };

  return (
    <form
      onSubmit={e => { e.preventDefault(); handleSave(); }}
      style={{
        marginTop: "12px",
        padding: "16px",
        background: "rgba(255,255,255,0.03)",
        border: "1px solid rgba(255,255,255,0.1)",
        borderRadius: "8px",
      }}
    >
      <p style={{ color: "#fff", fontSize: "13px", fontWeight: "600", margin: "0 0 12px" }}>
        Update credentials for {account.name}
      </p>
      {fields.map(f => {
        const hint = CREDENTIAL_HINTS[account.provider]?.[f.key];
        return (
          <div key={f.key} style={{ marginBottom: "12px" }}>
            <label style={{ display: "block", fontSize: "12px", color: "#9ca3af", marginBottom: "4px" }}>{f.label}</label>
            <input
              type={f.secret ? "password" : "text"}
              placeholder={f.placeholder}
              value={values[f.key] || ""}
              onChange={e => setValues(v => ({ ...v, [f.key]: e.target.value }))}
              style={{
                width: "100%",
                background: "rgba(255,255,255,0.06)",
                border: "1px solid rgba(255,255,255,0.12)",
                borderRadius: "6px",
                color: "#fff",
                padding: "8px 10px",
                fontSize: "13px",
                boxSizing: "border-box",
              }}
            />
            {hint && (
              <p
                style={{ color: "#9ca3af", fontSize: "11px", margin: "5px 0 0", lineHeight: "1.5", cursor: "default", transition: "color 0.15s" }}
                onMouseEnter={e => (e.currentTarget.style.color = "#e2e8f0")}
                onMouseLeave={e => (e.currentTarget.style.color = "#9ca3af")}
              >
                {hint}
              </p>
            )}
          </div>
        );
      })}
      {error && <p style={{ color: "#ff6b6b", fontSize: "12px", margin: "8px 0" }}>{error}</p>}
      <div style={{ display: "flex", gap: "8px", marginTop: "12px" }}>
        <button
          type="submit"
          disabled={saving}
          style={{
            background: "#c25800", color: "#fff", border: "none",
            padding: "7px 16px", borderRadius: "6px", cursor: "pointer", fontSize: "13px", fontWeight: "600",
          }}
        >
          {saving ? "Saving..." : "Save & Verify"}
        </button>
        <button
          type="button"
          onClick={onCancel}
          style={{
            background: "transparent", color: "#9ca3af", border: "1px solid rgba(255,255,255,0.1)",
            padding: "7px 14px", borderRadius: "6px", cursor: "pointer", fontSize: "13px",
          }}
        >
          Cancel
        </button>
      </div>
    </form>
  );
}

export function CloudAccountsList() {
  const { orgVersion } = useOrg();
  const can = useCan();
  const [accounts, setAccounts] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);

  const reload = () => {
    setLoading(true);
    setLoadError(null);
    api.listCloudAccounts()
      .then(data => setAccounts(data.accounts || []))
      .catch(err => {
        console.error(err);
        setLoadError(err?.message || "Failed to load cloud accounts.");
      })
      .finally(() => setLoading(false));
  };

  useEffect(() => { reload(); }, [orgVersion]);

  const handleDelete = async (id: string) => {
    if (!confirm("Disconnect this cloud account? Credentials will be permanently deleted.")) return;
    await api.deleteCloudAccount(id);
    setAccounts(prev => prev.filter(a => a.id !== id));
  };

  // Toggle production protection. Turning it OFF is the dangerous direction
  // (allows auto pause/delete/flush on a managed DB) — confirm first.
  const toggleProtection = async (a: any) => {
    const next = !isProtected(a);
    if (!next && !confirm(
      `Disable production protection for "${a.name}"?\n\n` +
      `This ALLOWS the kill switch to auto-pause, delete, or flush this managed ` +
      `database when a threshold/rule fires. Only do this for non-production databases.`
    )) return;
    await api.updateCloudAccount(a.id, { productionProtected: next });
    setAccounts(prev => prev.map(x => x.id === a.id ? { ...x, productionProtected: next } : x));
  };

  if (loading) return <p style={{ color: "#9ca3af", padding: "40px" }}>Loading...</p>;

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "24px" }}>
        <h1 style={{ fontFamily: "Outfit, sans-serif", fontSize: "24px", fontWeight: "700", color: "#fff", margin: 0 }}>
          Cloud Accounts
        </h1>
        {can("cloud_accounts:write") && (
          <Link to="/accounts/connect" style={{
            background: "#c25800", color: "#fff", padding: "8px 20px",
            borderRadius: "8px", textDecoration: "none", fontSize: "14px", fontWeight: "600",
          }}>
            + Connect
          </Link>
        )}
      </div>

      {accounts.map(a => (
        <div key={a.id} style={{
          padding: "20px",
          background: "rgba(255,255,255,0.03)",
          border: `1px solid ${a.lastCheckStatus === "error" ? "rgba(255,160,122,0.25)" : "rgba(255,255,255,0.06)"}`,
          borderLeft: `3px solid ${statusColor(a.lastCheckStatus)}`,
          borderRadius: "12px",
          marginBottom: "12px",
        }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
            <div style={{ flex: 1 }}>
              <div style={{ display: "flex", alignItems: "center", gap: "10px", marginBottom: "4px" }}>
                <h3 style={{ color: "#fff", fontFamily: "Outfit, sans-serif", margin: 0 }}>{a.name}</h3>
                {a.lastCheckStatus && (
                  <span style={{
                    fontSize: "11px", padding: "2px 7px", borderRadius: "4px", fontWeight: "600",
                    textTransform: "uppercase" as const,
                    background: `${statusColor(a.lastCheckStatus)}22`,
                    color: statusColor(a.lastCheckStatus),
                  }}>
                    {a.lastCheckStatus}
                  </span>
                )}
                {isManagedDb(a.provider) && (
                  <span
                    title={isProtected(a)
                      ? "Production-protected: the kill switch will never auto-pause, delete, or flush this database — a breach is downgraded to a snapshot + alert."
                      : "Protection OFF: destructive auto-actions (pause/delete/flush) are allowed on this database."}
                    style={{
                      fontSize: "11px", padding: "2px 7px", borderRadius: "4px", fontWeight: "600",
                      background: isProtected(a) ? "rgba(92,226,231,0.15)" : "rgba(255,160,122,0.15)",
                      color: isProtected(a) ? "#5ce2e7" : "#ffa07a",
                    }}>
                    {isProtected(a) ? "🔒 prod-protected" : "⚠ auto-kill enabled"}
                  </span>
                )}
              </div>
              <span style={{ fontSize: "12px", color: "#9ca3af" }}>
                {a.provider} · {a.providerAccountId}
              </span>

              {a.lastCheckStatus === "violation" && a.lastViolations?.length > 0 && editingId !== a.id && (
                <div style={{
                  marginTop: "10px", padding: "12px 14px",
                  background: "rgba(255,107,107,0.08)", border: "1px solid rgba(255,107,107,0.2)",
                  borderRadius: "6px",
                }}>
                  <p style={{ color: "#ff6b6b", fontSize: "12px", fontWeight: "600", margin: "0 0 10px" }}>
                    Threshold violations — <span style={{ color: "#fbbf24" }}>▎</span> = limit
                  </p>
                  <ViolationChart violations={a.lastViolations} />
                </div>
              )}

              {a.lastCheckStatus === "error" && a.lastCheckError && editingId !== a.id && (
                <div style={{
                  marginTop: "10px", padding: "10px 12px",
                  background: "rgba(255,160,122,0.08)", border: "1px solid rgba(255,160,122,0.2)",
                  borderRadius: "6px",
                }}>
                  <p style={{ color: "#ffa07a", fontSize: "12px", fontWeight: "600", margin: "0 0 4px" }}>Check failed</p>
                  <p style={{ color: "#d4846a", fontSize: "12px", margin: "0 0 8px", lineHeight: "1.5", wordBreak: "break-all" as const }}>
                    {a.lastCheckError}
                  </p>
                  {can("cloud_accounts:write") && (
                    <button
                      onClick={() => setEditingId(a.id)}
                      style={{
                        background: "rgba(255,160,122,0.15)", color: "#ffa07a",
                        border: "1px solid rgba(255,160,122,0.3)", padding: "5px 12px",
                        borderRadius: "5px", cursor: "pointer", fontSize: "12px", fontWeight: "600",
                      }}
                    >
                      Update credentials →
                    </button>
                  )}
                </div>
              )}

              {editingId === a.id && (
                <UpdateCredentialsForm
                  account={a}
                  onSuccess={() => { setEditingId(null); reload(); }}
                  onCancel={() => setEditingId(null)}
                />
              )}
            </div>

            <div style={{ display: "flex", gap: "8px", marginLeft: "16px", flexShrink: 0 }}>
              {can("cloud_accounts:write") && isManagedDb(a.provider) && (
                <button
                  onClick={() => toggleProtection(a)}
                  title={isProtected(a) ? "Allow destructive auto-actions (not recommended for prod)" : "Re-enable production protection"}
                  style={{
                    background: isProtected(a) ? "rgba(255,160,122,0.1)" : "rgba(92,226,231,0.12)",
                    color: isProtected(a) ? "#ffa07a" : "#5ce2e7",
                    border: `1px solid ${isProtected(a) ? "rgba(255,160,122,0.25)" : "rgba(92,226,231,0.3)"}`,
                    padding: "6px 14px", borderRadius: "6px", cursor: "pointer", fontSize: "12px",
                  }}
                >
                  {isProtected(a) ? "Disable protection" : "Enable protection"}
                </button>
              )}
              {can("cloud_accounts:write") && a.lastCheckStatus !== "error" && (
                <button
                  onClick={() => setEditingId(editingId === a.id ? null : a.id)}
                  style={{
                    background: "rgba(255,255,255,0.06)", color: "#9ca3af",
                    border: "1px solid rgba(255,255,255,0.1)", padding: "6px 14px",
                    borderRadius: "6px", cursor: "pointer", fontSize: "12px",
                  }}
                >
                  {editingId === a.id ? "Cancel" : "Update credentials"}
                </button>
              )}
              {can("cloud_accounts:delete") && (
                <button
                  onClick={() => handleDelete(a.id)}
                  style={{
                    background: "rgba(255,107,107,0.1)", color: "#ff6b6b",
                    border: "1px solid rgba(255,107,107,0.2)", padding: "6px 14px",
                    borderRadius: "6px", cursor: "pointer", fontSize: "12px",
                  }}
                >
                  Disconnect
                </button>
              )}
            </div>
          </div>
        </div>
      ))}

      {loadError && (
        <ErrorState message={`Couldn't load cloud accounts: ${loadError}`} onRetry={reload} />
      )}

      {!loadError && accounts.length === 0 && (
        <div style={{ textAlign: "center", padding: "48px", color: "#9ca3af" }}>
          <p style={{ marginBottom: "16px" }}>No cloud accounts connected yet.</p>
          {can("cloud_accounts:write") && <Link to="/accounts/connect" style={{
            background: "#c25800", color: "#fff", padding: "10px 24px",
            borderRadius: "8px", textDecoration: "none", fontWeight: "600",
          }}>
            Connect your first account
          </Link>}
        </div>
      )}
    </div>
  );
}
