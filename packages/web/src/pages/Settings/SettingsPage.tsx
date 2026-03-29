import { useEffect, useState } from "react";
import { useUser } from "@clerk/clerk-react";
import { api } from "../../api/client";

interface AlertChannel {
  type: string;
  name: string;
  config: { routingKey?: string; webhookUrl?: string; email?: string };
  enabled: boolean;
  configPreview?: string;
}

const inputStyle = {
  width: "100%", padding: "10px 14px", background: "rgba(255,255,255,0.05)",
  border: "1px solid rgba(255,255,255,0.12)", borderRadius: "8px",
  color: "#fff", fontSize: "14px", outline: "none",
};

const labelStyle = { display: "block" as const, marginBottom: "6px", fontSize: "13px", fontWeight: "600" as const, color: "#c4c5ca" };

const sectionStyle = {
  padding: "28px", background: "rgba(255,255,255,0.03)",
  border: "1px solid rgba(255,255,255,0.06)", borderRadius: "12px", marginBottom: "20px",
};

const btnStyle = {
  background: "rgba(255,255,255,0.08)", color: "#fff",
  border: "1px solid rgba(255,255,255,0.15)",
  padding: "8px 20px", borderRadius: "8px", cursor: "pointer", fontSize: "14px", fontWeight: "600" as const,
};

export function SettingsPage() {
  const { user } = useUser();
  const [account, setAccount] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ text: string; type: "success" | "error" } | null>(null);

  // Settings form state
  const [timezone, setTimezone] = useState("");
  const [dailyReport, setDailyReport] = useState(false);

  // API Keys
  const [apiKeys, setApiKeys] = useState<any[]>([]);
  const [newKeyName, setNewKeyName] = useState("");
  const [createdKey, setCreatedKey] = useState<string | null>(null);
  const [showCreateKey, setShowCreateKey] = useState(false);

  // Alert channel form
  const [channels, setChannels] = useState<AlertChannel[]>([]);
  const [newChannelType, setNewChannelType] = useState<"email" | "discord" | "slack" | "pagerduty" | "webhook">("email");
  const [newChannelName, setNewChannelName] = useState("");
  const [newChannelValue, setNewChannelValue] = useState("");
  const [showAddChannel, setShowAddChannel] = useState(false);

  // Team state
  const [teamMembers, setTeamMembers] = useState<any[]>([]);
  const [teamInvitations, setTeamInvitations] = useState<any[]>([]);
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState<"admin" | "member" | "viewer">("member");
  const [showInviteForm, setShowInviteForm] = useState(false);

  const loadTeam = async () => {
    try {
      const data = await api.listTeamMembers();
      setTeamMembers(data.members || []);
      setTeamInvitations(data.invitations || []);
    } catch {
      // Not on team tier — ignore
    }
  };

  useEffect(() => {
    Promise.all([
      api.getMe().then(data => {
        setAccount(data);
        setTimezone(data.settings?.timezone || "");
        setDailyReport(data.settings?.dailyReportEnabled || false);
        // Load team data for team/enterprise tiers
        if (data.tier === "team" || data.tier === "enterprise") {
          loadTeam();
        }
      }),
      api.listAlertChannels().then(data => {
        setChannels(data.channels || []);
      }),
      api.listApiKeys().then(data => {
        setApiKeys(data.keys || []);
      }).catch(() => {}),
    ]).finally(() => setLoading(false));
  }, []);

  const flash = (text: string, type: "success" | "error" = "success") => {
    setMessage({ text, type });
    setTimeout(() => setMessage(null), 4000);
  };

  const handleSaveSettings = async () => {
    setSaving(true);
    try {
      const updated = await api.updateMe({
        settings: { timezone: timezone || undefined, dailyReportEnabled: dailyReport },
      });
      setAccount(updated);
      flash("Settings saved");
    } catch (e: any) {
      flash(e.message, "error");
    }
    setSaving(false);
  };

  const handleAddChannel = async () => {
    const configKey = newChannelType === "email" ? "email" : newChannelType === "pagerduty" ? "routingKey" : "webhookUrl";
    const channel: AlertChannel = {
      type: newChannelType,
      name: newChannelName || newChannelType.charAt(0).toUpperCase() + newChannelType.slice(1),
      config: { [configKey]: newChannelValue },
      enabled: true,
    };
    const updated = [...channels, channel];
    try {
      await api.updateAlertChannels(updated);
      setChannels(updated);
      setShowAddChannel(false);
      setNewChannelName("");
      setNewChannelValue("");
      flash("Alert channel added");
    } catch (e: any) {
      flash(e.message, "error");
    }
  };

  const handleRemoveChannel = async (index: number) => {
    const updated = channels.filter((_, i) => i !== index);
    try {
      await api.updateAlertChannels(updated);
      setChannels(updated);
      flash("Alert channel removed");
    } catch (e: any) {
      flash(e.message, "error");
    }
  };

  const handleToggleChannel = async (index: number) => {
    const updated = channels.map((ch, i) => i === index ? { ...ch, enabled: !ch.enabled } : ch);
    try {
      await api.updateAlertChannels(updated);
      setChannels(updated);
    } catch (e: any) {
      flash(e.message, "error");
    }
  };

  const handleTestAlerts = async () => {
    try {
      const result = await api.testAlerts();
      flash(`Test alert sent to ${result.channelsSent} channel(s)`);
    } catch (e: any) {
      flash(e.message, "error");
    }
  };

  if (loading) return <p>Loading...</p>;

  const channelTypeLabel: Record<string, string> = {
    email: "Email Address", discord: "Webhook URL", slack: "Webhook URL",
    pagerduty: "Routing Key", webhook: "Webhook URL",
  };

  return (
    <div style={{ maxWidth: "720px" }}>
      <h1 style={{ fontFamily: "Outfit, sans-serif", fontSize: "28px", fontWeight: "700", color: "#fff", marginBottom: "32px" }}>Settings</h1>

      {/* Flash message */}
      {message && (
        <div style={{
          padding: "12px 16px", borderRadius: "8px", marginBottom: "20px", fontSize: "14px",
          background: message.type === "success" ? "rgba(92,226,231,0.1)" : "rgba(255,107,107,0.1)",
          border: `1px solid ${message.type === "success" ? "rgba(92,226,231,0.2)" : "rgba(255,107,107,0.2)"}`,
          color: message.type === "success" ? "#5ce2e7" : "#ff6b6b",
        }}>
          {message.text}
        </div>
      )}

      {/* ── Profile ────────────────────────────────────── */}
      <div style={sectionStyle}>
        <h2 style={{ fontFamily: "Outfit, sans-serif", fontSize: "18px", fontWeight: "600", color: "#fff", marginBottom: "20px" }}>Profile</h2>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "16px" }}>
          <div>
            <label style={labelStyle}>Email</label>
            <div style={{ ...inputStyle, background: "rgba(255,255,255,0.02)", color: "#6b7280", cursor: "not-allowed" }}>{user?.primaryEmailAddress?.emailAddress}</div>
          </div>
          <div>
            <label style={labelStyle}>Name</label>
            <div style={{ ...inputStyle, background: "rgba(255,255,255,0.02)", color: "#6b7280", cursor: "not-allowed" }}>{user?.fullName || "—"}</div>
          </div>
          <div>
            <label style={labelStyle}>Account Tier</label>
            <div style={{ ...inputStyle, background: "rgba(255,255,255,0.02)" }}>
              <span style={{ color: "#5ce2e7", fontWeight: "600" }}>{account?.tier?.toUpperCase()}</span>
            </div>
          </div>
          <div>
            <label style={labelStyle}>Member Since</label>
            <div style={{ ...inputStyle, background: "rgba(255,255,255,0.02)", color: "#6b7280", cursor: "not-allowed" }}>
              {account?.createdAt ? new Date(account.createdAt).toLocaleDateString() : "—"}
            </div>
          </div>
        </div>
        <p style={{ fontSize: "12px", color: "#6b7280", marginTop: "12px" }}>
          Profile details are managed by your identity provider.
        </p>
      </div>

      {/* ── Account Settings ───────────────────────────── */}
      <div style={sectionStyle}>
        <h2 style={{ fontFamily: "Outfit, sans-serif", fontSize: "18px", fontWeight: "600", color: "#fff", marginBottom: "20px" }}>Account Settings</h2>
        <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
          <div>
            <label style={labelStyle}>Timezone</label>
            <select
              value={timezone}
              onChange={e => setTimezone(e.target.value)}
              style={{ ...inputStyle, cursor: "pointer" }}
            >
              <option value="">Auto (browser default)</option>
              {Intl.supportedValuesOf?.("timeZone")?.map((tz: string) => (
                <option key={tz} value={tz}>{tz.replace(/_/g, " ")}</option>
              )) || [
                "America/New_York", "America/Chicago", "America/Denver", "America/Los_Angeles",
                "Europe/London", "Europe/Berlin", "Asia/Tokyo", "Asia/Shanghai",
                "Australia/Sydney", "Pacific/Auckland",
              ].map(tz => <option key={tz} value={tz}>{tz.replace(/_/g, " ")}</option>)}
            </select>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
            <button
              onClick={() => setDailyReport(!dailyReport)}
              style={{
                width: "44px", height: "24px", borderRadius: "12px", border: "none", cursor: "pointer",
                background: dailyReport ? "#5ce2e7" : "rgba(255,255,255,0.15)", position: "relative", transition: "background 0.2s", flexShrink: 0,
              }}
            >
              <div style={{
                width: "18px", height: "18px", borderRadius: "50%", background: "#fff",
                position: "absolute", top: "3px", left: dailyReport ? "23px" : "3px", transition: "left 0.2s",
              }} />
            </button>
            <div>
              <div style={{ fontSize: "14px", color: "#fff", fontWeight: "500" }}>Daily Cost Report</div>
              <div style={{ fontSize: "12px", color: "#6b7280" }}>Receive a summary of cloud spending every morning</div>
            </div>
          </div>
          <div>
            <label style={labelStyle}>Check Interval</label>
            <div style={{ ...inputStyle, background: "rgba(255,255,255,0.02)", color: "#6b7280", cursor: "not-allowed" }}>
              Every {account?.settings?.checkIntervalMinutes || 360} minutes
              {account?.tier === "free" && <span style={{ color: "#c25800", marginLeft: "8px" }}>(upgrade for 5-min checks)</span>}
            </div>
          </div>
        </div>
        <button onClick={handleSaveSettings} disabled={saving} style={{ ...btnStyle, marginTop: "20px", background: "#c25800", border: "none" }}>
          {saving ? "Saving..." : "Save Settings"}
        </button>
      </div>

      {/* ── API Keys ──────────────────────────────────── */}
      <div style={sectionStyle}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "20px" }}>
          <div>
            <h2 style={{ fontFamily: "Outfit, sans-serif", fontSize: "18px", fontWeight: "600", color: "#fff", margin: 0 }}>API Keys</h2>
            <p style={{ fontSize: "12px", color: "#6b7280", marginTop: "4px" }}>For the CLI (<code style={{ background: "rgba(255,255,255,0.08)", padding: "1px 5px", borderRadius: "3px", fontSize: "11px" }}>ks</code>) and API access</p>
          </div>
          <button onClick={() => { setShowCreateKey(!showCreateKey); setCreatedKey(null); }} style={{ ...btnStyle, background: showCreateKey ? "rgba(255,107,107,0.1)" : "rgba(255,255,255,0.08)" }}>
            {showCreateKey ? "Cancel" : "Create API Key"}
          </button>
        </div>

        {/* Created key display (shown once, never again) */}
        {createdKey && (
          <div style={{
            padding: "16px", background: "rgba(92,226,231,0.08)", border: "1px solid rgba(92,226,231,0.2)",
            borderRadius: "8px", marginBottom: "16px",
          }}>
            <div style={{ fontSize: "13px", color: "#5ce2e7", fontWeight: "600", marginBottom: "8px" }}>
              Your API key (copy it now — it won't be shown again):
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
              <code style={{
                flex: 1, padding: "10px 14px", background: "rgba(0,0,0,0.3)", borderRadius: "6px",
                fontSize: "13px", fontFamily: "JetBrains Mono, monospace", color: "#fff",
                wordBreak: "break-all", userSelect: "all",
              }}>
                {createdKey}
              </code>
              <button
                onClick={() => { navigator.clipboard.writeText(createdKey); flash("Copied to clipboard"); }}
                style={{ ...btnStyle, flexShrink: 0, fontSize: "13px", padding: "10px 16px" }}
              >
                Copy
              </button>
            </div>
            <div style={{ fontSize: "12px", color: "#6b7280", marginTop: "8px" }}>
              Use with: <code style={{ background: "rgba(255,255,255,0.08)", padding: "1px 5px", borderRadius: "3px", fontSize: "11px" }}>ks auth login --api-key {createdKey.substring(0, 16)}...</code>
            </div>
          </div>
        )}

        {/* Create key form */}
        {showCreateKey && !createdKey && (
          <div style={{ padding: "20px", background: "rgba(255,255,255,0.02)", borderRadius: "8px", border: "1px solid rgba(255,255,255,0.08)", marginBottom: "16px" }}>
            <div style={{ display: "flex", gap: "12px", alignItems: "end" }}>
              <div style={{ flex: 1 }}>
                <label style={labelStyle}>Key Name</label>
                <input style={inputStyle} placeholder="e.g., CLI, Claude Code, CI/CD" value={newKeyName} onChange={e => setNewKeyName(e.target.value)} />
              </div>
              <button
                onClick={async () => {
                  try {
                    const result = await api.createApiKey(newKeyName || "CLI Key");
                    setCreatedKey(result.key);
                    setNewKeyName("");
                    const refreshed = await api.listApiKeys();
                    setApiKeys(refreshed.keys || []);
                  } catch (e: any) {
                    flash(e.message, "error");
                  }
                }}
                style={{ ...btnStyle, background: "#c25800", border: "none", height: "41px", flexShrink: 0 }}
              >
                Create Key
              </button>
            </div>
          </div>
        )}

        {/* Existing keys */}
        {apiKeys.length === 0 && !showCreateKey && (
          <p style={{ color: "#6b7280", fontSize: "14px" }}>No API keys yet. Create one to use the CLI or integrate with your tools.</p>
        )}
        {apiKeys.map((k, i) => (
          <div key={k._id || i} style={{
            display: "flex", alignItems: "center", justifyContent: "space-between",
            padding: "12px 16px", background: "rgba(255,255,255,0.02)", borderRadius: "8px",
            marginBottom: "8px", border: "1px solid rgba(255,255,255,0.06)",
          }}>
            <div>
              <span style={{ color: "#fff", fontSize: "14px", fontWeight: "500" }}>{k.name}</span>
              <span style={{ color: "#6b7280", fontSize: "12px", marginLeft: "8px", fontFamily: "JetBrains Mono, monospace" }}>{k.keyPrefix}...</span>
              {k.lastUsedAt && <span style={{ color: "#4b5563", fontSize: "11px", marginLeft: "8px" }}>Last used {new Date(k.lastUsedAt).toLocaleDateString()}</span>}
            </div>
            <div style={{ display: "flex", gap: "8px" }}>
              <button
                onClick={async () => {
                  try {
                    const result = await api.rollApiKey(k._id);
                    setCreatedKey(result.key);
                    const refreshed = await api.listApiKeys();
                    setApiKeys(refreshed.keys || []);
                    flash("Key rotated — save the new key");
                  } catch (e: any) {
                    flash(e.message, "error");
                  }
                }}
                style={{ background: "none", border: "none", color: "#5ce2e7", cursor: "pointer", fontSize: "13px", padding: "4px 8px" }}
                title="Roll (rotate) key"
              >
                Roll
              </button>
              <button
                onClick={async () => {
                  try {
                    await api.deleteApiKey(k._id);
                    setApiKeys(apiKeys.filter((_, j) => j !== i));
                    flash("API key revoked");
                  } catch (e: any) {
                    flash(e.message, "error");
                  }
                }}
                style={{ background: "none", border: "none", color: "#6b7280", cursor: "pointer", fontSize: "13px", padding: "4px 8px" }}
                title="Revoke key"
              >
                Revoke
              </button>
            </div>
          </div>
        ))}
      </div>

      {/* ── Alert Channels ─────────────────────────────── */}
      <div style={sectionStyle}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "20px" }}>
          <h2 style={{ fontFamily: "Outfit, sans-serif", fontSize: "18px", fontWeight: "600", color: "#fff", margin: 0 }}>Alert Channels</h2>
          <div style={{ display: "flex", gap: "8px" }}>
            {channels.length > 0 && (
              <button onClick={handleTestAlerts} style={btnStyle}>Test Alerts</button>
            )}
            <button onClick={() => setShowAddChannel(!showAddChannel)} style={{ ...btnStyle, background: showAddChannel ? "rgba(255,107,107,0.1)" : "rgba(255,255,255,0.08)" }}>
              {showAddChannel ? "Cancel" : "Add Channel"}
            </button>
          </div>
        </div>

        {channels.length === 0 && !showAddChannel && (
          <p style={{ color: "#6b7280", fontSize: "14px" }}>No alert channels configured. Add one to get notified when thresholds are breached.</p>
        )}

        {/* Existing channels */}
        {channels.map((ch, i) => (
          <div key={i} style={{
            display: "flex", alignItems: "center", justifyContent: "space-between",
            padding: "12px 16px", background: "rgba(255,255,255,0.02)", borderRadius: "8px",
            marginBottom: "8px", border: "1px solid rgba(255,255,255,0.06)",
          }}>
            <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
              <button
                onClick={() => handleToggleChannel(i)}
                style={{
                  width: "36px", height: "20px", borderRadius: "10px", border: "none", cursor: "pointer",
                  background: ch.enabled ? "#5ce2e7" : "rgba(255,255,255,0.15)", position: "relative", transition: "background 0.2s", flexShrink: 0,
                }}
              >
                <div style={{
                  width: "14px", height: "14px", borderRadius: "50%", background: "#fff",
                  position: "absolute", top: "3px", left: ch.enabled ? "19px" : "3px", transition: "left 0.2s",
                }} />
              </button>
              <div>
                <span style={{ color: "#fff", fontSize: "14px", fontWeight: "500" }}>{ch.name}</span>
                <span style={{ color: "#6b7280", fontSize: "12px", marginLeft: "8px" }}>{ch.type}</span>
                {ch.configPreview && <div style={{ fontSize: "11px", color: "#4b5563", marginTop: "2px", fontFamily: "monospace" }}>{ch.configPreview}</div>}
              </div>
            </div>
            <button onClick={() => handleRemoveChannel(i)}
              style={{ background: "none", border: "none", color: "#6b7280", cursor: "pointer", fontSize: "16px", padding: "4px 8px" }}
              title="Remove channel"
            >
              &#10005;
            </button>
          </div>
        ))}

        {/* Add channel form */}
        {showAddChannel && (
          <div style={{ marginTop: "16px", padding: "20px", background: "rgba(255,255,255,0.02)", borderRadius: "8px", border: "1px solid rgba(255,255,255,0.08)" }}>
            <div style={{ display: "flex", gap: "8px", marginBottom: "16px", flexWrap: "wrap" }}>
              {(["email", "discord", "slack", "pagerduty", "webhook"] as const).map(type => (
                <button key={type} onClick={() => setNewChannelType(type)}
                  style={{
                    padding: "6px 14px", borderRadius: "6px", fontSize: "13px", fontWeight: "600", cursor: "pointer",
                    background: newChannelType === type ? "rgba(92,226,231,0.1)" : "rgba(255,255,255,0.05)",
                    border: newChannelType === type ? "1px solid rgba(92,226,231,0.3)" : "1px solid rgba(255,255,255,0.1)",
                    color: newChannelType === type ? "#5ce2e7" : "#c4c5ca",
                  }}>
                  {type.charAt(0).toUpperCase() + type.slice(1)}
                </button>
              ))}
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
              <div>
                <label style={labelStyle}>Channel Name</label>
                <input style={inputStyle} placeholder="e.g., Ops Team Discord" value={newChannelName} onChange={e => setNewChannelName(e.target.value)} />
              </div>
              <div>
                <label style={labelStyle}>{channelTypeLabel[newChannelType] || "Value"}</label>
                <input
                  style={inputStyle}
                  type={newChannelType === "email" ? "email" : "text"}
                  placeholder={newChannelType === "email" ? "alerts@yourteam.com" : newChannelType === "pagerduty" ? "Routing key" : "https://hooks..."}
                  value={newChannelValue}
                  onChange={e => setNewChannelValue(e.target.value)}
                />
              </div>
              <button onClick={handleAddChannel} disabled={!newChannelValue}
                style={{ ...btnStyle, background: "#c25800", border: "none", opacity: newChannelValue ? 1 : 0.5, alignSelf: "flex-start" }}>
                Add Channel
              </button>
            </div>
          </div>
        )}
      </div>

      {/* ── Team Management ──────────────────────────── */}
      {(account?.tier === "team" || account?.tier === "enterprise") && (
        <div style={sectionStyle}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "20px" }}>
            <h2 style={{ fontFamily: "Outfit, sans-serif", fontSize: "18px", fontWeight: "600", color: "#fff", margin: 0 }}>Team</h2>
            <button onClick={() => setShowInviteForm(!showInviteForm)} style={{ ...btnStyle, background: showInviteForm ? "rgba(255,107,107,0.1)" : "rgba(255,255,255,0.08)" }}>
              {showInviteForm ? "Cancel" : "Invite Member"}
            </button>
          </div>

          {/* Invite form */}
          {showInviteForm && (
            <div style={{ padding: "20px", background: "rgba(255,255,255,0.02)", borderRadius: "8px", border: "1px solid rgba(255,255,255,0.08)", marginBottom: "16px" }}>
              <div style={{ display: "grid", gridTemplateColumns: "1fr auto auto", gap: "12px", alignItems: "end" }}>
                <div>
                  <label style={labelStyle}>Email</label>
                  <input style={inputStyle} type="email" placeholder="teammate@company.com" value={inviteEmail} onChange={e => setInviteEmail(e.target.value)} />
                </div>
                <div>
                  <label style={labelStyle}>Role</label>
                  <select value={inviteRole} onChange={e => setInviteRole(e.target.value as any)} style={{ ...inputStyle, cursor: "pointer", width: "120px" }}>
                    <option value="viewer">Viewer</option>
                    <option value="member">Member</option>
                    <option value="admin">Admin</option>
                  </select>
                </div>
                <button
                  onClick={async () => {
                    try {
                      const result = await api.inviteTeamMember(inviteEmail, inviteRole);
                      flash(`Invitation sent to ${inviteEmail}`);
                      setInviteEmail("");
                      setShowInviteForm(false);
                      loadTeam();
                    } catch (e: any) {
                      flash(e.message, "error");
                    }
                  }}
                  disabled={!inviteEmail}
                  style={{ ...btnStyle, background: "#c25800", border: "none", opacity: inviteEmail ? 1 : 0.5, height: "41px" }}
                >
                  Send Invite
                </button>
              </div>
              <p style={{ fontSize: "12px", color: "#6b7280", marginTop: "8px" }}>
                Invitations expire after 7 days. The recipient must have or create a Kill Switch account to join.
              </p>
            </div>
          )}

          {/* Members list */}
          {teamMembers.map((m, i) => (
            <div key={m.userId || i} style={{
              display: "flex", alignItems: "center", justifyContent: "space-between",
              padding: "12px 16px", background: "rgba(255,255,255,0.02)", borderRadius: "8px",
              marginBottom: "8px", border: "1px solid rgba(255,255,255,0.06)",
            }}>
              <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
                <div style={{
                  width: "32px", height: "32px", borderRadius: "50%",
                  background: m.isOwner ? "rgba(194,88,0,0.2)" : "rgba(92,226,231,0.1)",
                  display: "flex", alignItems: "center", justifyContent: "center",
                  fontSize: "14px", color: m.isOwner ? "#c25800" : "#5ce2e7", fontWeight: "700",
                }}>
                  {m.email?.charAt(0)?.toUpperCase() || "?"}
                </div>
                <div>
                  <div style={{ color: "#fff", fontSize: "14px", fontWeight: "500" }}>{m.email}</div>
                  <div style={{ fontSize: "12px", color: "#6b7280" }}>
                    {m.role.charAt(0).toUpperCase() + m.role.slice(1)}
                    {m.isOwner && " (Account Owner)"}
                    {m.joinedAt && !m.isOwner && ` \u00B7 Joined ${new Date(m.joinedAt).toLocaleDateString()}`}
                  </div>
                </div>
              </div>
              {!m.isOwner && (
                <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
                  <select
                    value={m.role}
                    onChange={async (e) => {
                      try {
                        await api.updateTeamMember(m.id, e.target.value);
                        loadTeam();
                      } catch (err: any) {
                        flash(err.message, "error");
                      }
                    }}
                    style={{ background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.1)", borderRadius: "6px", color: "#c4c5ca", padding: "4px 8px", fontSize: "12px", cursor: "pointer" }}
                  >
                    <option value="viewer">Viewer</option>
                    <option value="member">Member</option>
                    <option value="admin">Admin</option>
                  </select>
                  <button
                    onClick={async () => {
                      if (window.confirm(`Remove ${m.email} from the team?`)) {
                        try {
                          await api.removeTeamMember(m.id);
                          flash(`Removed ${m.email}`);
                          loadTeam();
                        } catch (err: any) {
                          flash(err.message, "error");
                        }
                      }
                    }}
                    style={{ background: "none", border: "none", color: "#6b7280", cursor: "pointer", fontSize: "16px", padding: "4px 8px" }}
                    title="Remove member"
                  >
                    &#10005;
                  </button>
                </div>
              )}
            </div>
          ))}

          {/* Pending invitations */}
          {teamInvitations.length > 0 && (
            <div style={{ marginTop: "16px" }}>
              <div style={{ fontSize: "13px", fontWeight: "600", color: "#6b7280", marginBottom: "8px", textTransform: "uppercase", letterSpacing: "1px" }}>
                Pending Invitations
              </div>
              {teamInvitations.map((inv, i) => (
                <div key={inv.id || i} style={{
                  display: "flex", alignItems: "center", justifyContent: "space-between",
                  padding: "10px 16px", background: "rgba(255,165,0,0.04)", borderRadius: "8px",
                  marginBottom: "6px", border: "1px solid rgba(255,165,0,0.1)",
                }}>
                  <div>
                    <span style={{ color: "#ffa07a", fontSize: "14px" }}>{inv.email}</span>
                    <span style={{ color: "#6b7280", fontSize: "12px", marginLeft: "8px" }}>
                      {inv.role} &middot; Expires {new Date(inv.expiresAt).toLocaleDateString()}
                    </span>
                  </div>
                  <button
                    onClick={async () => {
                      try {
                        await api.revokeInvitation(inv.id);
                        flash(`Revoked invitation for ${inv.email}`);
                        loadTeam();
                      } catch (err: any) {
                        flash(err.message, "error");
                      }
                    }}
                    style={{ background: "none", border: "none", color: "#6b7280", cursor: "pointer", fontSize: "13px", padding: "4px 8px" }}
                    title="Revoke invitation"
                  >
                    Revoke
                  </button>
                </div>
              ))}
            </div>
          )}

          {teamMembers.length <= 1 && teamInvitations.length === 0 && !showInviteForm && (
            <p style={{ color: "#6b7280", fontSize: "14px" }}>No team members yet. Invite your first teammate to collaborate on cloud monitoring.</p>
          )}
        </div>
      )}

      {/* Upgrade prompt for non-team tiers */}
      {account?.tier !== "team" && account?.tier !== "enterprise" && (
        <div style={{ ...sectionStyle, borderColor: "rgba(194,88,0,0.2)" }}>
          <h2 style={{ fontFamily: "Outfit, sans-serif", fontSize: "18px", fontWeight: "600", color: "#fff", marginBottom: "8px" }}>Team</h2>
          <p style={{ color: "#6b7280", fontSize: "14px", marginBottom: "16px" }}>
            Invite team members, assign roles, and collaborate on cloud monitoring.
            Available on the Team and Enterprise plans.
          </p>
          <a href="/billing?plan=team" style={{ ...btnStyle, background: "rgba(194,88,0,0.15)", borderColor: "rgba(194,88,0,0.3)", color: "#c25800", textDecoration: "none", display: "inline-block" }}>
            Upgrade to Team
          </a>
        </div>
      )}

      {/* ── Danger Zone ────────────────────────────────── */}
      <div style={{ ...sectionStyle, borderColor: "rgba(255,107,107,0.2)" }}>
        <h2 style={{ fontFamily: "Outfit, sans-serif", fontSize: "18px", fontWeight: "600", color: "#ff6b6b", marginBottom: "8px" }}>Danger Zone</h2>
        <p style={{ color: "#6b7280", fontSize: "13px", marginBottom: "16px" }}>
          These actions are irreversible. Proceed with caution.
        </p>
        <button
          onClick={() => {
            if (window.confirm("Are you sure you want to delete your account? This will remove all cloud accounts, rules, and alert history. This cannot be undone.")) {
              // TODO: Implement DELETE /accounts/me
              flash("Account deletion is not yet available. Contact support@divinci.ai.", "error");
            }
          }}
          style={{ ...btnStyle, background: "rgba(255,107,107,0.1)", borderColor: "rgba(255,107,107,0.3)", color: "#ff6b6b" }}
        >
          Delete Account
        </button>
      </div>
    </div>
  );
}
