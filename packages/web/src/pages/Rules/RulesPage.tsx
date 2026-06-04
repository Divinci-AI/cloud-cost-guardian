import { useCallback, useEffect, useState } from "react";
import { api } from "../../api/client";
import { useOrg } from "../../context/OrgContext";

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
      <div style={{ marginBottom: "24px" }}>
        <h1 style={{ fontFamily: "Outfit, sans-serif", fontSize: "24px", fontWeight: 700, color: "#fff", margin: "0 0 8px" }}>
          Kill Switch Rules
        </h1>
        <p style={{ color: "#8b8fa3", fontSize: "14px", margin: 0 }}>
          Programmable shields that auto-fire when usage or security thresholds are breached.
        </p>
      </div>

      {error && (
        <div style={{ padding: "12px 16px", background: "rgba(255,107,107,0.1)", border: "1px solid rgba(255,107,107,0.2)", borderRadius: "8px", color: "#ff6b6b", fontSize: "13px", marginBottom: "16px" }}>
          {error}
        </div>
      )}

      <div style={{ marginBottom: "32px" }}>
        <button
          type="button"
          onClick={() => setShowPresets(!showPresets)}
          style={{ ...btnSecondary, marginBottom: showPresets ? "16px" : 0 }}
        >
          {showPresets ? "Hide preset shields" : "+ Add preset shield"}
        </button>
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
                  <label style={{ display: "flex", alignItems: "center", gap: "8px", cursor: "pointer", fontSize: "13px", color: "#c4c5ca" }}>
                    <input
                      type="checkbox"
                      checked={rule.enabled}
                      disabled={togglingId === rule.id}
                      onChange={() => handleToggle(rule.id)}
                    />
                    {rule.enabled ? "On" : "Off"}
                  </label>
                  <button type="button" onClick={() => openEdit(rule)} style={btnSecondary}>
                    Edit
                  </button>
                  <button
                    type="button"
                    onClick={() => handleDelete(rule)}
                    style={{ ...btnSecondary, color: "#ff6b6b", borderColor: "rgba(255,107,107,0.3)" }}
                  >
                    Delete
                  </button>
                </div>
              </div>
            </div>
          ))}
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
            <div style={{ display: "flex", gap: "12px", justifyContent: "flex-end" }}>
              <button type="button" onClick={() => setEditing(null)} disabled={saving} style={btnSecondary}>
                Cancel
              </button>
              <button type="button" onClick={handleSaveEdit} disabled={saving} style={btnPrimary}>
                {saving ? "Saving..." : "Save"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
