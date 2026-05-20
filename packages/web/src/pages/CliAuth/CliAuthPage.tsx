import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useUser } from "@clerk/clerk-react";
import { api } from "../../api/client";

interface Org {
  id: string;
  name: string;
  slug: string;
  type: string;
  tier?: string;
  role: "owner" | "admin" | "member" | "viewer";
}

const PAGE_BG = "#0c1229";
const CARD_BG = "rgba(255,255,255,0.03)";
const BORDER = "1px solid rgba(255,255,255,0.08)";

const labelStyle = { display: "block" as const, marginBottom: "6px", fontSize: "13px", fontWeight: 600 as const, color: "#c4c5ca" };
const inputStyle = {
  width: "100%", padding: "10px 14px", background: "rgba(255,255,255,0.05)",
  border: "1px solid rgba(255,255,255,0.12)", borderRadius: "8px",
  color: "#fff", fontSize: "14px", outline: "none", boxSizing: "border-box" as const,
};
const primaryBtn = {
  background: "#ff9d42", color: "#0c1229", border: "none",
  padding: "12px 28px", borderRadius: "8px", cursor: "pointer",
  fontSize: "14px", fontWeight: 700 as const,
};
const dangerBtn = {
  background: "transparent", color: "#ff9d42",
  border: "1px solid rgba(255,157,66,0.4)",
  padding: "12px 28px", borderRadius: "8px", cursor: "pointer",
  fontSize: "14px", fontWeight: 600 as const,
};

// Permission matrix says owner/admin/member can manage api_keys; viewer cannot.
function canManageApiKeys(role: string): boolean {
  return role === "owner" || role === "admin" || role === "member";
}

// localStorage key for the last-chosen org on this page. Per-browser, not
// per-user (Clerk session changes don't clear it), but that's fine since the
// dropdown only shows orgs the current user has access to anyway — a stale
// id that the user no longer has access to just falls through to the next
// default in the resolver below.
const LAST_ORG_LS_KEY = "kill-switch:cli-auth:lastOrgId";

function readLastOrgFromStorage(): string | null {
  try { return localStorage.getItem(LAST_ORG_LS_KEY); }
  catch { return null; }
}

function saveLastOrgToStorage(orgId: string): void {
  try { localStorage.setItem(LAST_ORG_LS_KEY, orgId); }
  catch { /* private-browsing or quota-exceeded; non-critical */ }
}

export function CliAuthPage() {
  const { user } = useUser();
  const [params] = useSearchParams();
  const code = params.get("code") ?? "";

  const [orgs, setOrgs] = useState<Org[] | null>(null);
  const [selectedOrgId, setSelectedOrgId] = useState<string>("");
  const [keyName, setKeyName] = useState("");
  const [state, setState] = useState<"idle" | "loading-orgs" | "approving" | "denying" | "approved" | "denied" | "error">("idle");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!code) return;
    setState("loading-orgs");
    api.listOrgs()
      .then((res: { orgs: Org[]; activeOrgId?: string }) => {
        const eligible = (res.orgs || []).filter(o => canManageApiKeys(o.role));
        setOrgs(eligible);

        // Default resolution order, most-specific to least:
        //   1. Last-chosen org from localStorage (this page only) — preserves
        //      the user's previous decision so a re-auth doesn't ask again.
        //   2. Server's activeOrgId from UserProfile — the user's "primary"
        //      org as set elsewhere in the dashboard.
        //   3. First eligible org — last-resort fallback.
        // Any stage that points at an id not in `eligible` falls through.
        const lastSaved = readLastOrgFromStorage();
        const fromStorage = lastSaved && eligible.find(o => o.id === lastSaved) ? lastSaved : null;
        const fromActive = res.activeOrgId && eligible.find(o => o.id === res.activeOrgId) ? res.activeOrgId : null;
        const defaultId = fromStorage || fromActive || eligible[0]?.id;
        if (defaultId) setSelectedOrgId(defaultId);

        setState("idle");
      })
      .catch((err: Error) => {
        setError(err.message);
        setState("error");
      });
  }, [code]);

  const defaultKeyName = useMemo(() => {
    const u = user?.primaryEmailAddress?.emailAddress?.split("@")[0] || "cli";
    return `CLI (${u})`;
  }, [user]);

  async function onApprove() {
    if (!selectedOrgId) {
      setError("Pick an organization first.");
      return;
    }
    setState("approving");
    setError(null);
    try {
      await api.cliApprove(code, selectedOrgId, keyName.trim() || defaultKeyName);
      // Persist the chosen org so the next CLI auth from this browser
      // defaults to the same org without asking again.
      saveLastOrgToStorage(selectedOrgId);
      setState("approved");
    } catch (err: any) {
      setError(err.message || "Approval failed");
      setState("error");
    }
  }

  async function onDeny() {
    setState("denying");
    setError(null);
    try {
      await api.cliDeny(code, selectedOrgId || (orgs?.[0]?.id ?? ""));
      setState("denied");
    } catch (err: any) {
      setError(err.message || "Deny failed");
      setState("error");
    }
  }

  if (!code) {
    return <ShellLayout><Card><h1 style={{ marginTop: 0, color: "#fff" }}>Missing code</h1><p>This page must be opened by the <code>ks</code> CLI. Run <code>ks auth login</code> in your terminal.</p></Card></ShellLayout>;
  }

  if (state === "approved") {
    return (
      <ShellLayout>
        <Card>
          <h1 style={{ marginTop: 0, color: "#fff" }}>✓ CLI authorized</h1>
          <p style={{ color: "#c4c5ca", fontSize: "15px" }}>
            Return to your terminal — <code>ks</code> has finished signing in.
          </p>
          <p style={{ color: "rgba(196,197,202,0.7)", fontSize: "13px", marginTop: "24px" }}>
            You can revoke this CLI key any time from <a href="/settings" style={{ color: "#ff9d42" }}>Settings → API Keys</a>.
          </p>
        </Card>
      </ShellLayout>
    );
  }

  if (state === "denied") {
    return (
      <ShellLayout>
        <Card>
          <h1 style={{ marginTop: 0, color: "#fff" }}>Denied</h1>
          <p style={{ color: "#c4c5ca" }}>The CLI sign-in request was denied. You can close this tab.</p>
        </Card>
      </ShellLayout>
    );
  }

  return (
    <ShellLayout>
      <Card>
        <h1 style={{ marginTop: 0, color: "#fff", fontFamily: "Outfit, sans-serif" }}>Authorize Kill Switch CLI</h1>
        <p style={{ color: "#c4c5ca", fontSize: "14px", lineHeight: 1.6 }}>
          The <code>ks</code> CLI is requesting permission to act on your behalf. Confirm the code below matches the one shown in your terminal.
        </p>

        <div style={{ margin: "24px 0", padding: "20px", background: "rgba(255,157,66,0.08)", border: "1px solid rgba(255,157,66,0.3)", borderRadius: "10px", textAlign: "center" }}>
          <div style={{ fontSize: "12px", color: "rgba(255,157,66,0.8)", letterSpacing: "0.1em", textTransform: "uppercase" as const, marginBottom: "8px" }}>Verification code</div>
          <div style={{ fontSize: "28px", fontWeight: 700, color: "#ff9d42", fontFamily: "monospace", letterSpacing: "0.15em" }}>{code}</div>
        </div>

        {state === "loading-orgs" && <p style={{ color: "#c4c5ca" }}>Loading your organizations…</p>}

        {orgs && orgs.length === 0 && (
          <p style={{ color: "#ff9d42" }}>
            You don't have permission to create API keys in any organization. Ask an owner or admin to grant the <code>api_keys:manage</code> role.
          </p>
        )}

        {orgs && orgs.length > 0 && (
          <>
            <div style={{ marginBottom: "16px" }}>
              <label style={labelStyle}>Organization</label>
              <select value={selectedOrgId} onChange={(e) => setSelectedOrgId(e.target.value)} style={inputStyle as any}>
                {orgs.map(o => (
                  <option key={o.id} value={o.id} style={{ background: "#1a2240" }}>
                    {o.name} ({o.type}, role: {o.role})
                  </option>
                ))}
              </select>
            </div>

            <div style={{ marginBottom: "24px" }}>
              <label style={labelStyle}>API key name</label>
              <input
                type="text"
                value={keyName}
                onChange={(e) => setKeyName(e.target.value)}
                placeholder={defaultKeyName}
                style={inputStyle}
              />
              <div style={{ fontSize: "12px", color: "rgba(196,197,202,0.6)", marginTop: "6px" }}>
                Shown in <a href="/settings" style={{ color: "#ff9d42" }}>Settings → API Keys</a> for revocation.
              </div>
            </div>

            {error && (
              <div style={{ padding: "12px 14px", background: "rgba(255,80,80,0.1)", border: "1px solid rgba(255,80,80,0.3)", borderRadius: "8px", color: "#ff8585", fontSize: "14px", marginBottom: "16px" }}>
                {error}
              </div>
            )}

            <div style={{ display: "flex", gap: "12px" }}>
              <button onClick={onApprove} disabled={state === "approving"} style={primaryBtn}>
                {state === "approving" ? "Authorizing…" : "Approve"}
              </button>
              <button onClick={onDeny} disabled={state === "denying"} style={dangerBtn}>
                {state === "denying" ? "Denying…" : "Deny"}
              </button>
            </div>
          </>
        )}

        {state === "error" && error && !orgs && (
          <p style={{ color: "#ff8585" }}>{error}</p>
        )}
      </Card>
    </ShellLayout>
  );
}

function ShellLayout({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ minHeight: "100vh", background: PAGE_BG, color: "#c4c5ca", display: "flex", alignItems: "flex-start", justifyContent: "center", padding: "80px 24px" }}>
      <div style={{ width: "100%", maxWidth: "520px" }}>
        <div style={{ display: "flex", alignItems: "center", gap: "10px", marginBottom: "24px" }}>
          <span style={{ fontSize: "20px" }}>⚡</span>
          <span style={{ fontFamily: "Outfit, sans-serif", fontWeight: 600, fontSize: "18px", color: "#fff" }}>Kill Switch</span>
        </div>
        {children}
      </div>
    </div>
  );
}

function Card({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ padding: "32px", background: CARD_BG, border: BORDER, borderRadius: "14px" }}>
      {children}
    </div>
  );
}
