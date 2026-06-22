import { useCallback, useEffect, useState } from "react";
import { api } from "../../api/client";
import { useOrg } from "../../context/OrgContext";
import { useCan } from "../../hooks/useCan";

interface RuleCondition {
  metric: string;
  operator: string;
  value: number;
  windowMinutes?: number;
}

interface RuleAction {
  type: string;
  target?: string;
  delay?: number;
  requireApproval?: boolean;
}

interface KillSwitchRule {
  id: string;
  name: string;
  enabled: boolean;
  trigger: string;
  conditions: RuleCondition[];
  conditionLogic?: "all" | "any";
  actions: RuleAction[];
  cooldownMinutes: number;
  lastFiredAt?: number;
  forensicsEnabled?: boolean;
}

interface Preset {
  id: string;
  name: string;
  description: string;
  category?: string;
}

const cardStyle = {
  padding: "20px",
  background: "rgba(255,255,255,0.03)",
  border: "1px solid rgba(255,255,255,0.08)",
  borderRadius: "12px",
};

const inputStyle = {
  width: "100%",
  padding: "10px 14px",
  background: "rgba(255,255,255,0.05)",
  border: "1px solid rgba(255,255,255,0.12)",
  borderRadius: "8px",
  color: "#fff",
  fontSize: "14px",
  outline: "none",
};

const labelStyle = {
  display: "block" as const,
  marginBottom: "6px",
  fontSize: "13px",
  fontWeight: 600 as const,
  color: "#c4c5ca",
};

const btnPrimary = {
  background: "linear-gradient(135deg, #c25800, #e06800)",
  color: "#fff",
  border: "none",
  padding: "10px 20px",
  borderRadius: "8px",
  fontSize: "14px",
  fontWeight: 600 as const,
  cursor: "pointer",
};

const btnSecondary = {
  background: "rgba(255,255,255,0.08)",
  color: "#fff",
  border: "1px solid rgba(255,255,255,0.15)",
  padding: "8px 16px",
  borderRadius: "8px",
  fontSize: "13px",
  cursor: "pointer",
};

function formatCondition(c: RuleCondition): string {
  const win = c.windowMinutes ? ` (${c.windowMinutes}m)` : "";
  return `${c.metric} ${c.operator} ${c.value}${win}`;
}

function formatAction(a: RuleAction): string {
  const target = a.target || "*";
  const extra = a.requireApproval ? ", needs approval" : "";
  return `${a.type} → ${target}${extra}`;
}

function triggerColor(trigger: string): string {
  if (trigger === "security") return "#ff6b6b";
  if (trigger === "cost") return "#ffcc00";
  if (trigger === "agent") return "#c084fc";
  return "#5ce2e7";
}

export function RulesPage() {
  const { orgVersion } = useOrg();
  const can = useCan();
  const [rules, setRules] = useState<KillSwitchRule[]>([]);
  const [presets, setPresets] = useState<Preset[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [applyingPreset, setApplyingPreset] = useState<string | null>(null);
  const [showPresets, setShowPresets] = useState(false);
  const [editing, setEditing] = useState<KillSwitchRule | null>(null);
  const [editName, setEditName] = useState("");
  const [editCooldown, setEditCooldown] = useState(60);
  const [editForensics, setEditForensics] = useState(true);
  const [saving, setSaving] = useState(false);
  const [togglingId, setTogglingId] = useState<string | null>(null);
  const [preflighting, setPreflighting] = useState(false);
  const [preflight, setPreflight] = useState<any>(null);
  const [showEmergency, setShowEmergency] = useState(false);
  const [threatDescription, setThreatDescription] = useState("");
  const [threatSeverity, setThreatSeverity] = useState("critical");
  const [emergencyActions, setEmergencyActions] = useState<{ type: string; target: string }[]>([
    { type: "disconnect", target: "*" },
  ]);
  const [autoExecute, setAutoExecute] = useState(false);
  const [triggering, setTriggering] = useState(false);
  const [triggerResult, setTriggerResult] = useState<string>("");

  const load = useCallback(() => {
    setLoading(true);
    setError("");
    Promise.all([api.listRules(), api.listPresets()])
      .then(([rulesRes, presetsRes]) => {
        setRules(rulesRes.rules || []);
        setPresets(presetsRes.presets || []);
      })
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    load();
  }, [load, orgVersion]);

  const handleToggle = async (ruleId: string) => {
    setTogglingId(ruleId);
    try {
      const res = await api.toggleRule(ruleId);
      setRules(prev => prev.map(r => (r.id === ruleId ? { ...r, enabled: res.rule.enabled } : r)));
    } catch (e: any) {
      setError(e.message);
    } finally {
      setTogglingId(null);
    }
  };

  const handleDelete = async (rule: KillSwitchRule) => {
    if (!window.confirm(`Delete rule "${rule.name}"? This cannot be undone.`)) return;
    try {
      await api.deleteRule(rule.id);
      setRules(prev => prev.filter(r => r.id !== rule.id));
    } catch (e: any) {
      setError(e.message);
    }
  };

  const openEdit = (rule: KillSwitchRule) => {
    setEditing(rule);
    setEditName(rule.name);
    setEditCooldown(rule.cooldownMinutes ?? 60);
    setEditForensics(rule.forensicsEnabled !== false);
    setPreflight(null);
  };

  const handlePreflight = async () => {
    if (!editing) return;
    setPreflighting(true);
    setPreflight(null);
    try {
      const res = await api.preflightRule({ ruleId: editing.id });
      setPreflight(res);
    } catch (e: any) {
      setPreflight({ error: e.message });
    } finally {
      setPreflighting(false);
    }
  };

  const handleSaveEdit = async () => {
    if (!editing) return;
    setSaving(true);
    setError("");
    try {
      const res = await api.updateRule(editing.id, {
        ...editing,
        name: editName.trim() || editing.name,
        cooldownMinutes: Math.max(0, editCooldown),
        forensicsEnabled: editForensics,
      });
      setRules(prev => prev.map(r => (r.id === editing.id ? res.rule : r)));
      setEditing(null);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  };

  const handleEmergencyTrigger = async () => {
    const actions = emergencyActions.filter(a => a.type);
    if (!threatDescription.trim() || actions.length === 0) return;
    if (autoExecute && !window.confirm(
      "Execute immediately? The kill actions will run without further approval against all matching, non-protected services."
    )) return;
    setTriggering(true);
    setError("");
    setTriggerResult("");
    try {
      const res = await api.agentTrigger({
        agentId: "web-dashboard",
        threatDescription: threatDescription.trim(),
        severity: threatSeverity,
        recommendedActions: actions.map(a => ({ type: a.type, target: a.target.trim() || "*" })),
        autoExecute,
      });
      setTriggerResult(res.message || (autoExecute ? "Kill switch executing." : "Rule created, awaiting approval."));
      setThreatDescription("");
      load(); // the created rule appears in the list
    } catch (e: any) {
      setError(e.message);
    } finally {
      setTriggering(false);
    }
  };

  const handleApplyPreset = async (presetId: string) => {
    setApplyingPreset(presetId);
    setError("");
    try {
      const res = await api.applyPreset(presetId);
      const applied = res.rule as KillSwitchRule;
      setRules(prev => {
        const idx = prev.findIndex(r => r.id === applied.id);
        if (idx >= 0) {
          const next = [...prev];
          next[idx] = applied;
          return next;
        }
        return [...prev, applied];
      });
    } catch (e: any) {
      setError(e.message);
    } finally {
      setApplyingPreset(null);
    }
  };

  if (loading) return <p>Loading...</p>;

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: "16px", marginBottom: "24px", flexWrap: "wrap" }}>
        <div>
          <h1 style={{ fontFamily: "Outfit, sans-serif", fontSize: "24px", fontWeight: 700, color: "#fff", margin: "0 0 8px" }}>
            Kill Switch Rules
          </h1>
          <p style={{ color: "#8b8fa3", fontSize: "14px", margin: 0 }}>
            Programmable shields that auto-fire when usage or security thresholds are breached.
          </p>
        </div>
        {can("kill_switch:trigger") && (
          <button
            type="button"
            onClick={() => { setShowEmergency(true); setTriggerResult(""); }}
            style={{
              background: "rgba(255,107,107,0.12)", color: "#ff6b6b",
              border: "1px solid rgba(255,107,107,0.35)", padding: "9px 20px",
              borderRadius: "8px", cursor: "pointer", fontSize: "14px", fontWeight: 600, flexShrink: 0,
            }}
          >
            ⚠ Emergency trigger
          </button>
        )}
      </div>

      {error && (
        <div style={{ padding: "12px 16px", background: "rgba(255,107,107,0.1)", border: "1px solid rgba(255,107,107,0.2)", borderRadius: "8px", color: "#ff6b6b", fontSize: "13px", marginBottom: "16px" }}>
          {error}
        </div>
      )}

      <div style={{ marginBottom: "32px" }}>
        {can("rules:write") && (
        <button
          type="button"
          onClick={() => setShowPresets(!showPresets)}
          style={{ ...btnSecondary, marginBottom: showPresets ? "16px" : 0 }}
        >
          {showPresets ? "Hide preset shields" : "+ Add preset shield"}
        </button>
        )}
        {showPresets && (
          <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
            {presets.map(p => (
              <div key={p.id} style={{ ...cardStyle, display: "flex", justifyContent: "space-between", alignItems: "center", gap: "16px" }}>
                <div>
                  <div style={{ color: "#fff", fontWeight: 600, fontSize: "15px" }}>{p.name}</div>
                  <div style={{ color: "#9ca3af", fontSize: "13px", marginTop: "4px" }}>{p.description}</div>
                  {p.category && (
                    <span style={{ display: "inline-block", marginTop: "8px", fontSize: "11px", color: "#5ce2e7", textTransform: "uppercase" }}>
                      {p.category}
                    </span>
                  )}
                </div>
                <button
                  type="button"
                  onClick={() => handleApplyPreset(p.id)}
                  disabled={applyingPreset !== null}
                  style={{ ...btnPrimary, opacity: applyingPreset && applyingPreset !== p.id ? 0.5 : 1, flexShrink: 0 }}
                >
                  {applyingPreset === p.id ? "Applying..." : "Apply"}
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      <h2 style={{ fontFamily: "Outfit, sans-serif", fontSize: "18px", fontWeight: 600, color: "#fff", marginBottom: "16px" }}>
        Active rules ({rules.length})
      </h2>

      {rules.length === 0 ? (
        <div style={{ ...cardStyle, textAlign: "center", padding: "48px 20px", color: "#9ca3af" }}>
          <p style={{ fontSize: "32px", marginBottom: "12px" }}>&#128737;</p>
          <p>No rules yet. Add a preset shield above or finish onboarding.</p>
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
          {rules.map(rule => (
            <div
              key={rule.id}
              style={{
                ...cardStyle,
                borderLeft: `3px solid ${rule.enabled ? "#5ce2e7" : "rgba(255,255,255,0.15)"}`,
                opacity: rule.enabled ? 1 : 0.75,
              }}
            >
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: "16px", flexWrap: "wrap" }}>
                <div style={{ flex: 1, minWidth: "200px" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: "10px", marginBottom: "8px", flexWrap: "wrap" }}>
                    <span style={{ fontSize: "16px", fontWeight: 600, color: "#fff" }}>{rule.name}</span>
                    <span style={{ fontSize: "11px", fontWeight: 600, color: triggerColor(rule.trigger), textTransform: "uppercase" }}>
                      {rule.trigger}
                    </span>
                    <span style={{ fontSize: "11px", color: "#9ca3af", fontFamily: "JetBrains Mono, monospace" }}>{rule.id}</span>
                  </div>
                  {rule.conditions?.length > 0 && (
                    <div style={{ fontSize: "13px", color: "#c4c5ca", marginBottom: "6px" }}>
                      <strong style={{ color: "#8b8fa3" }}>When </strong>
                      ({rule.conditionLogic || "any"}){" "}
                      {rule.conditions.map(formatCondition).join("; ")}
                    </div>
                  )}
                  {rule.actions?.length > 0 && (
                    <div style={{ fontSize: "13px", color: "#c4c5ca", marginBottom: "6px" }}>
                      <strong style={{ color: "#8b8fa3" }}>Then </strong>
                      {rule.actions.map(formatAction).join("; ")}
                    </div>
                  )}
                  <div style={{ fontSize: "12px", color: "#9ca3af" }}>
                    Cooldown: {rule.cooldownMinutes}m
                    {rule.lastFiredAt ? ` · Last fired ${new Date(rule.lastFiredAt).toLocaleString()}` : ""}
                    {rule.forensicsEnabled ? " · Forensics on" : ""}
                  </div>
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: "10px", flexShrink: 0 }}>
                  <label style={{ display: "flex", alignItems: "center", gap: "8px", cursor: can("rules:write") ? "pointer" : "default", fontSize: "13px", color: "#c4c5ca" }}>
                    <input
                      type="checkbox"
                      checked={rule.enabled}
                      disabled={togglingId === rule.id || !can("rules:write")}
                      onChange={() => handleToggle(rule.id)}
                    />
                    {rule.enabled ? "On" : "Off"}
                  </label>
                  {can("rules:write") && (
                    <button type="button" onClick={() => openEdit(rule)} style={btnSecondary}>
                      Edit
                    </button>
                  )}
                  {can("rules:delete") && (
                    <button
                      type="button"
                      onClick={() => handleDelete(rule)}
                      style={{ ...btnSecondary, color: "#ff6b6b", borderColor: "rgba(255,107,107,0.3)" }}
                    >
                      Delete
                    </button>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {showEmergency && (
        <div
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,0,0,0.6)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 1000,
            padding: "24px",
          }}
          onClick={() => !triggering && setShowEmergency(false)}
        >
          <div
            style={{ ...cardStyle, maxWidth: "540px", width: "100%", background: "#141b33", border: "1px solid rgba(255,107,107,0.3)" }}
            onClick={e => e.stopPropagation()}
          >
            <h3 style={{ fontFamily: "Outfit, sans-serif", color: "#ff6b6b", margin: "0 0 8px" }}>⚠ Emergency kill trigger</h3>
            <p style={{ fontSize: "13px", color: "#9ca3af", margin: "0 0 20px", lineHeight: 1.5 }}>
              Report an active threat and fire kill actions across this org's accounts.
              By default this creates a rule awaiting approval; check "execute immediately" to fire now.
            </p>
            <div style={{ marginBottom: "16px" }}>
              <label style={labelStyle}>What's happening? (required)</label>
              <textarea
                style={{ ...inputStyle, minHeight: "70px", resize: "vertical" as const, fontFamily: "inherit" }}
                value={threatDescription}
                onChange={e => setThreatDescription(e.target.value)}
                placeholder="e.g. Leaked API key being used to spin up crypto-mining workers"
              />
            </div>
            <div style={{ marginBottom: "16px", maxWidth: "200px" }}>
              <label style={labelStyle}>Severity</label>
              <select style={inputStyle} value={threatSeverity} onChange={e => setThreatSeverity(e.target.value)}>
                <option value="info">Info</option>
                <option value="warning">Warning</option>
                <option value="critical">Critical</option>
              </select>
            </div>
            <label style={labelStyle}>Kill actions</label>
            {emergencyActions.map((a, i) => (
              <div key={i} style={{ display: "flex", gap: "8px", marginBottom: "8px", alignItems: "center" }}>
                <select
                  style={{ ...inputStyle, width: "auto", flex: 1 }}
                  value={a.type}
                  onChange={e => setEmergencyActions(prev => prev.map((x, j) => j === i ? { ...x, type: e.target.value } : x))}
                >
                  <option value="disconnect">Disconnect (remove routes)</option>
                  <option value="scale-down">Scale down to 0</option>
                  <option value="block-traffic">Block traffic (WAF)</option>
                  <option value="isolate">Isolate (network)</option>
                  <option value="pause-zone">Pause zone (CF)</option>
                  <option value="stop-instances">Stop instances</option>
                  <option value="rotate-creds">Rotate credentials</option>
                  <option value="snapshot">Snapshot only (forensics)</option>
                </select>
                <input
                  style={{ ...inputStyle, width: "auto", flex: 1 }}
                  value={a.target}
                  placeholder="target service or * for all"
                  onChange={e => setEmergencyActions(prev => prev.map((x, j) => j === i ? { ...x, target: e.target.value } : x))}
                />
                {emergencyActions.length > 1 && (
                  <button
                    type="button"
                    onClick={() => setEmergencyActions(prev => prev.filter((_, j) => j !== i))}
                    style={{ ...btnSecondary, padding: "6px 10px" }}
                  >
                    ✕
                  </button>
                )}
              </div>
            ))}
            <button
              type="button"
              onClick={() => setEmergencyActions(prev => [...prev, { type: "disconnect", target: "*" }])}
              style={{ ...btnSecondary, marginBottom: "16px" }}
            >
              + Add action
            </button>
            <label style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "16px", fontSize: "14px", color: "#ff9d42", cursor: "pointer" }}>
              <input type="checkbox" checked={autoExecute} onChange={e => setAutoExecute(e.target.checked)} />
              Execute immediately (skip human approval)
            </label>
            {triggerResult && (
              <p style={{ fontSize: "13px", color: "#4ade80", marginBottom: "16px" }}>{triggerResult}</p>
            )}
            <div style={{ display: "flex", gap: "12px", justifyContent: "flex-end" }}>
              <button type="button" onClick={() => setShowEmergency(false)} disabled={triggering} style={btnSecondary}>
                Close
              </button>
              <button
                type="button"
                onClick={handleEmergencyTrigger}
                disabled={triggering || !threatDescription.trim()}
                style={{
                  background: "rgba(255,107,107,0.15)", color: "#ff6b6b",
                  border: "1px solid rgba(255,107,107,0.4)", padding: "8px 18px",
                  borderRadius: "8px", cursor: "pointer", fontSize: "13px", fontWeight: 600,
                  opacity: !threatDescription.trim() ? 0.5 : 1,
                }}
              >
                {triggering ? "Triggering..." : autoExecute ? "Fire kill switch" : "Create for approval"}
              </button>
            </div>
          </div>
        </div>
      )}

      {editing && (
        <div
          role="dialog"
          aria-modal="true"
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,0,0,0.6)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 1000,
            padding: "24px",
          }}
          onClick={() => !saving && setEditing(null)}
        >
          <div
            style={{ ...cardStyle, maxWidth: "480px", width: "100%", background: "#141b33" }}
            onClick={e => e.stopPropagation()}
          >
            <h3 style={{ fontFamily: "Outfit, sans-serif", color: "#fff", margin: "0 0 20px" }}>Edit rule</h3>
            <div style={{ marginBottom: "16px" }}>
              <label style={labelStyle}>Name</label>
              <input style={inputStyle} value={editName} onChange={e => setEditName(e.target.value)} />
            </div>
            <div style={{ marginBottom: "16px" }}>
              <label style={labelStyle}>Cooldown (minutes)</label>
              <input
                style={inputStyle}
                type="number"
                min={0}
                value={editCooldown}
                onChange={e => setEditCooldown(parseInt(e.target.value, 10) || 0)}
              />
            </div>
            <label style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "20px", fontSize: "14px", color: "#c4c5ca", cursor: "pointer" }}>
              <input type="checkbox" checked={editForensics} onChange={e => setEditForensics(e.target.checked)} />
              Capture forensics snapshot when rule fires
            </label>
            <p style={{ fontSize: "12px", color: "#9ca3af", marginBottom: "20px" }}>
              Conditions and actions are fixed for this rule. Use the API or CLI for advanced edits.
            </p>

            {preflight && (
              <div style={{ marginBottom: "20px", padding: "14px 16px", background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.08)", borderRadius: "8px", maxHeight: "220px", overflowY: "auto" }}>
                {preflight.error ? (
                  <p style={{ color: "#ff6b6b", fontSize: "13px", margin: 0 }}>Preview failed: {preflight.error}</p>
                ) : (
                  <>
                    <p style={{ color: "#fff", fontSize: "13px", fontWeight: 600, margin: "0 0 8px" }}>
                      If this rule fired right now:
                    </p>
                    <p style={{ color: "#c4c5ca", fontSize: "13px", margin: "0 0 8px", lineHeight: 1.6 }}>
                      {preflight.summary.accountsWouldFire} of {preflight.summary.accountsConsidered} account(s) would be
                      acted on ({preflight.summary.accountsTriggered} currently match the conditions)
                      {preflight.summary.totalEstimatedDailySavingsUSD > 0 &&
                        ` — est. $${preflight.summary.totalEstimatedDailySavingsUSD}/day stopped`}.
                    </p>
                    {preflight.rule.cooldownActive && (
                      <p style={{ color: "#ffcc00", fontSize: "12px", margin: "0 0 8px" }}>
                        ⏳ Cooldown active — a real trigger would be suppressed until {new Date(preflight.rule.cooldownExpiresAt).toLocaleString()}.
                      </p>
                    )}
                    {preflight.summary.protectedCollisions > 0 && (
                      <p style={{ color: "#ffcc00", fontSize: "12px", margin: "0 0 8px" }}>
                        ⚠ {preflight.summary.protectedCollisions} action(s) collide with protected services and would be skipped.
                      </p>
                    )}
                    {preflight.summary.degradedProviders > 0 && (
                      <p style={{ color: "#ffa07a", fontSize: "12px", margin: "0 0 8px" }}>
                        ⚠ {preflight.summary.degradedProviders} provider(s) reported degraded health — results may be incomplete.
                      </p>
                    )}
                    <ul style={{ margin: 0, paddingLeft: "18px" }}>
                      {(preflight.perAccount || []).map((a: any) => (
                        <li key={a.cloudAccountId} style={{ color: "#9ca3af", fontSize: "12px", lineHeight: 1.7 }}>
                          <span style={{ color: "#c4c5ca" }}>{a.accountName}</span> ({a.provider}):{" "}
                          {a.error
                            ? <span style={{ color: "#ff6b6b" }}>error — {a.error}</span>
                            : a.wouldFire
                              ? <span style={{ color: "#ff6b6b" }}>would fire</span>
                              : a.triggered
                                ? <span style={{ color: "#ffcc00" }}>conditions met (suppressed)</span>
                                : "no action"}
                        </li>
                      ))}
                    </ul>
                  </>
                )}
              </div>
            )}

            <div style={{ display: "flex", gap: "12px", justifyContent: "space-between" }}>
              <button type="button" onClick={handlePreflight} disabled={preflighting || saving} style={btnSecondary}>
                {preflighting ? "Simulating..." : "Preview impact"}
              </button>
              <div style={{ display: "flex", gap: "12px" }}>
                <button type="button" onClick={() => setEditing(null)} disabled={saving} style={btnSecondary}>
                  Cancel
                </button>
                <button type="button" onClick={handleSaveEdit} disabled={saving} style={btnPrimary}>
                  {saving ? "Saving..." : "Save"}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
