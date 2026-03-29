import { createContext, useContext, useState, useCallback, useEffect } from "react";
import { api, setActiveOrgId } from "../api/client";

export interface Org {
  id: string;
  name: string;
  slug: string;
  type: "personal" | "organization";
  tier: string;
  role: string;
}

interface OrgContextValue {
  activeOrg: Org | null;
  orgs: Org[];
  teamRole: string | null;
  switchOrg: (orgId: string) => Promise<void>;
  refreshOrgs: () => Promise<void>;
  loading: boolean;
  /**
   * Incremented on every org switch. Components can use this as a
   * useEffect dependency to refetch data when the org changes.
   */
  orgVersion: number;
}

const OrgContext = createContext<OrgContextValue>({
  activeOrg: null,
  orgs: [],
  teamRole: null,
  switchOrg: async () => {},
  refreshOrgs: async () => {},
  loading: true,
  orgVersion: 0,
});

export function useOrg() {
  return useContext(OrgContext);
}

interface OrgProviderProps {
  children: React.ReactNode;
  /** Initial account data from /accounts/me to avoid a duplicate fetch */
  initialAccount?: any;
}

export function OrgProvider({ children, initialAccount }: OrgProviderProps) {
  const [orgs, setOrgs] = useState<Org[]>([]);
  const [activeOrgIdState, setActiveOrgIdState] = useState<string | null>(null);
  const [teamRole, setTeamRole] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [orgVersion, setOrgVersion] = useState(0);

  const applyAccountData = useCallback((me: any) => {
    const orgList: Org[] = me.orgs || [];
    setOrgs(orgList);
    const currentOrgId = me.activeOrgId || orgList[0]?.id || null;
    setActiveOrgIdState(currentOrgId);
    setActiveOrgId(currentOrgId);
    setTeamRole(me.teamRole || null);
  }, []);

  const refreshOrgs = useCallback(async () => {
    try {
      const me = await api.getMe();
      applyAccountData(me);

      // Detect if the active org was deleted or user was removed:
      // If the server returned a different activeOrgId than what we had,
      // it means the old org is no longer accessible.
      if (me.activeOrgId && me.activeOrgId !== activeOrgIdState && activeOrgIdState !== null) {
        setOrgVersion(v => v + 1); // Force pages to refetch
      }
    } catch (err: any) {
      console.error("[OrgContext] Failed to refresh orgs:", err);
      // If we get a 403, the current org may have been deleted
      if (err.message?.includes("403") || err.message?.includes("don't have access")) {
        setActiveOrgIdState(null);
        setActiveOrgId(null);
        setOrgVersion(v => v + 1);
      }
    } finally {
      setLoading(false);
    }
  }, [applyAccountData, activeOrgIdState]);

  // Initialize from parent data or fetch fresh
  useEffect(() => {
    if (initialAccount?.orgs) {
      applyAccountData(initialAccount);
      setLoading(false);
    } else {
      refreshOrgs();
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialAccount, applyAccountData]);

  const switchOrg = useCallback(async (orgId: string) => {
    await api.switchOrg(orgId);
    setActiveOrgIdState(orgId);
    setActiveOrgId(orgId);
    // Bump version BEFORE refreshing so pages start refetching immediately
    setOrgVersion(v => v + 1);
    await refreshOrgs();
  }, [refreshOrgs]);

  const activeOrg = orgs.find(o => o.id === activeOrgIdState) || null;

  return (
    <OrgContext.Provider value={{ activeOrg, orgs, teamRole, switchOrg, refreshOrgs, loading, orgVersion }}>
      {children}
    </OrgContext.Provider>
  );
}
