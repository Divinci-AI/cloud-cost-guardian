/**
 * Guardian API Client
 *
 * Authenticated fetch wrapper that attaches Clerk JWT to all requests.
 */

const API_URL = import.meta.env.VITE_API_URL || "http://localhost:8090";

/** Any non-2xx API response. `status` is the HTTP status (0 = network failure). */
export class ApiError extends Error {
  status: number;
  body?: any;
  constructor(message: string, status: number, body?: any) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

export class TierLimitError extends ApiError {
  code = "TIER_LIMIT" as const;
  currentTier: string;
  limit: number;
  constructor(message: string, currentTier: string, limit: number) {
    super(message, 403);
    this.currentTier = currentTier;
    this.limit = limit;
  }
}

export function isTierLimitError(e: unknown): e is TierLimitError {
  return e instanceof TierLimitError;
}

export function isApiError(e: unknown): e is ApiError {
  return e instanceof ApiError;
}

/** Session expired or not authenticated — distinct from "no access to this org" (403). */
export function isAuthError(e: unknown): boolean {
  return isApiError(e) && e.status === 401;
}

let getAccessToken: (() => Promise<string | null>) | null = null;
let activeOrgId: string | null = null;

export function setTokenGetter(fn: () => Promise<string | null>) {
  getAccessToken = fn;
}

export function setActiveOrgId(orgId: string | null) {
  activeOrgId = orgId;
}

export function getActiveOrgId(): string | null {
  return activeOrgId;
}

async function guardianFetch<T>(path: string, options: RequestInit = {}): Promise<T> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(options.headers as Record<string, string>),
  };

  if (getAccessToken) {
    const token = await getAccessToken();
    headers["Authorization"] = `Bearer ${token}`;
  }

  if (activeOrgId) {
    headers["X-Org-Id"] = activeOrgId;
  }

  let res: Response;
  try {
    res = await fetch(`${API_URL}${path}`, { ...options, headers });
  } catch {
    throw new ApiError("Network error — could not reach the Kill Switch API.", 0);
  }

  const text = await res.text();
  let data: any;
  try {
    data = JSON.parse(text);
  } catch {
    throw new ApiError(`API error (${res.status}): ${text.substring(0, 200)}`, res.status);
  }

  if (!res.ok) {
    if (res.status === 403 && data.limit !== undefined && data.currentTier !== undefined) {
      throw new TierLimitError(
        data.error || "Plan limit reached. Upgrade to continue.",
        data.currentTier,
        data.limit,
      );
    }
    if (res.status === 401) {
      throw new ApiError(data.error || "Your session has expired. Please sign in again.", 401, data);
    }
    throw new ApiError(data.error || `API error: ${res.status}`, res.status, data);
  }

  return data as T;
}

// ─── API Methods ────────────────────────────────────────────────────────────

export const api = {
  // Health
  health: () => guardianFetch<any>("/"),

  // Providers
  listProviders: () => guardianFetch<any>("/providers"),
  validateCredential: (providerId: string, credential: any) =>
    guardianFetch<any>(`/providers/${providerId}/validate`, {
      method: "POST",
      body: JSON.stringify(credential),
    }),

  // Account (current user)
  getMe: () => guardianFetch<any>("/accounts/me"),
  updateMe: (data: Record<string, any>) =>
    guardianFetch<any>("/accounts/me", {
      method: "PATCH",
      body: JSON.stringify(data),
    }),
  deleteAccount: () => guardianFetch<any>("/accounts/me", { method: "DELETE" }),
  completeOnboarding: () =>
    guardianFetch<any>("/accounts/me", {
      method: "PATCH",
      body: JSON.stringify({ onboardingCompleted: true }),
    }),

  // Accounts (legacy)
  getAccount: (id: string) => guardianFetch<any>(`/accounts/${id}`),

  // Cloud Accounts
  listCloudAccounts: () => guardianFetch<any>("/cloud-accounts"),
  connectCloudAccount: (data: { provider: string; name: string; credential: any }) =>
    guardianFetch<any>("/cloud-accounts", {
      method: "POST",
      body: JSON.stringify(data),
    }),
  getCloudAccount: (id: string) => guardianFetch<any>(`/cloud-accounts/${id}`),
  updateCloudAccount: (id: string, data: any) =>
    guardianFetch<any>(`/cloud-accounts/${id}`, {
      method: "PUT",
      body: JSON.stringify(data),
    }),
  updateCloudAccountCredentials: (id: string, credential: any) =>
    guardianFetch<any>(`/cloud-accounts/${id}/credentials`, {
      method: "PATCH",
      body: JSON.stringify({ credential }),
    }),
  deleteCloudAccount: (id: string) =>
    guardianFetch<any>(`/cloud-accounts/${id}`, { method: "DELETE" }),
  checkCloudAccount: (id: string) =>
    guardianFetch<any>(`/cloud-accounts/${id}/check`, { method: "POST" }),
  getUsageHistory: (id: string, days = 7) =>
    guardianFetch<any>(`/cloud-accounts/${id}/usage?days=${days}`),

  // Analytics
  getAnalyticsOverview: (days = 30) =>
    guardianFetch<any>(`/analytics/overview?days=${days}`),

  // Alerts
  listAlertChannels: () => guardianFetch<any>("/alerts/channels"),
  updateAlertChannels: (channels: any[]) =>
    guardianFetch<any>("/alerts/channels", {
      method: "PUT",
      body: JSON.stringify({ channels }),
    }),
  testAlerts: () => guardianFetch<any>("/alerts/test", { method: "POST" }),
  getAlertHistory: () => guardianFetch<any>("/alerts/history"),

  // Manual check
  runCheck: () => guardianFetch<any>("/check", { method: "POST" }),

  // Billing
  getPlans: () => guardianFetch<any>("/billing/plans"),
  getBillingStatus: () => guardianFetch<any>("/billing/status"),
  createCheckout: (planKey: string, successUrl?: string, cancelUrl?: string) =>
    guardianFetch<any>("/billing/checkout", {
      method: "POST",
      body: JSON.stringify({ planKey, successUrl, cancelUrl }),
    }),
  createPortal: (returnUrl?: string) =>
    guardianFetch<any>("/billing/portal", {
      method: "POST",
      body: JSON.stringify({ returnUrl }),
    }),

  // Team
  listTeamMembers: () => guardianFetch<any>("/team/members"),
  inviteTeamMember: (email: string, role: string = "member") =>
    guardianFetch<any>("/team/invite", {
      method: "POST",
      body: JSON.stringify({ email, role }),
    }),
  acceptInvitation: (token: string) =>
    guardianFetch<any>("/team/invite/accept", {
      method: "POST",
      body: JSON.stringify({ token }),
    }),
  updateTeamMember: (memberId: string, role: string) =>
    guardianFetch<any>(`/team/members/${memberId}`, {
      method: "PATCH",
      body: JSON.stringify({ role }),
    }),
  removeTeamMember: (memberId: string) =>
    guardianFetch<any>(`/team/members/${memberId}`, { method: "DELETE" }),
  revokeInvitation: (invitationId: string) =>
    guardianFetch<any>(`/team/invitations/${invitationId}`, { method: "DELETE" }),

  // API Keys
  listApiKeys: () => guardianFetch<any>("/auth/api-keys"),
  createApiKey: (name: string) =>
    guardianFetch<any>("/auth/api-keys", {
      method: "POST",
      body: JSON.stringify({ name }),
    }),
  deleteApiKey: (id: string) =>
    guardianFetch<any>(`/auth/api-keys/${id}`, { method: "DELETE" }),
  rollApiKey: (id: string) =>
    guardianFetch<any>(`/auth/api-keys/${id}/roll`, { method: "POST" }),

  // Rules
  listRules: () => guardianFetch<any>("/rules"),
  listPresets: () => guardianFetch<any>("/rules/presets"),
  applyPreset: (presetId: string, customValues?: any) =>
    guardianFetch<any>(`/rules/presets/${presetId}`, {
      method: "POST",
      body: JSON.stringify(customValues || {}),
    }),
  updateRule: (ruleId: string, data: Record<string, unknown>) =>
    guardianFetch<any>(`/rules/${ruleId}`, {
      method: "PUT",
      body: JSON.stringify(data),
    }),
  deleteRule: (ruleId: string) =>
    guardianFetch<any>(`/rules/${ruleId}`, { method: "DELETE" }),
  toggleRule: (ruleId: string) =>
    guardianFetch<any>(`/rules/${ruleId}/toggle`, { method: "POST" }),
  preflightRule: (rule: Record<string, unknown>) =>
    guardianFetch<any>("/rules/preflight", {
      method: "POST",
      body: JSON.stringify(rule),
    }),
  agentTrigger: (data: {
    agentId?: string;
    threatDescription: string;
    severity?: string;
    recommendedActions: { type: string; target?: string; delay?: number }[];
    evidence?: Record<string, unknown>;
    autoExecute?: boolean;
  }) =>
    guardianFetch<any>("/rules/agent/trigger", {
      method: "POST",
      body: JSON.stringify(data),
    }),

  // Database Kill Switch
  listDbCredentials: () => guardianFetch<any>("/database/credentials"),
  storeDbCredential: (data: { provider: string } & Record<string, unknown>) =>
    guardianFetch<any>("/database/credentials", {
      method: "POST",
      body: JSON.stringify(data),
    }),
  deleteDbCredential: (id: string) =>
    guardianFetch<any>(`/database/credentials/${id}`, { method: "DELETE" }),
  listKillSequences: () => guardianFetch<any>("/database/kill"),
  getKillSequence: (id: string) => guardianFetch<any>(`/database/kill/${id}`),
  initiateDbKill: (data: { credentialId: string; trigger: string; actions?: string[] }) =>
    guardianFetch<any>("/database/kill", {
      method: "POST",
      body: JSON.stringify(data),
    }),
  advanceDbKill: (id: string, credentialId: string, humanApproval?: boolean) =>
    guardianFetch<any>(`/database/kill/${id}/advance`, {
      method: "POST",
      body: JSON.stringify({ credentialId, humanApproval }),
    }),
  abortDbKill: (id: string) =>
    guardianFetch<any>(`/database/kill/${id}/abort`, { method: "POST" }),

  // Organizations
  listOrgs: () => guardianFetch<any>("/orgs"),
  createOrg: (name: string) =>
    guardianFetch<any>("/orgs", {
      method: "POST",
      body: JSON.stringify({ name }),
    }),
  getOrg: (orgId: string) => guardianFetch<any>(`/orgs/${orgId}`),
  updateOrg: (orgId: string, data: { name?: string; slug?: string }) =>
    guardianFetch<any>(`/orgs/${orgId}`, {
      method: "PATCH",
      body: JSON.stringify(data),
    }),
  deleteOrg: (orgId: string) =>
    guardianFetch<any>(`/orgs/${orgId}`, { method: "DELETE" }),
  switchOrg: (orgId: string) =>
    guardianFetch<any>(`/orgs/${orgId}/switch`, { method: "POST" }),
  convertPersonalToOrg: (name: string) =>
    guardianFetch<any>("/orgs/convert-personal", {
      method: "POST",
      body: JSON.stringify({ name }),
    }),

  // CLI device-flow auth (org context comes from the orgId arg, NOT activeOrgId)
  cliApprove: async (code: string, orgId: string, keyName?: string) => {
    const prev = getActiveOrgId();
    setActiveOrgId(orgId);
    try {
      return await guardianFetch<{ approved: true }>("/auth/cli/approve", {
        method: "POST",
        body: JSON.stringify({ code, keyName }),
      });
    } finally {
      setActiveOrgId(prev);
    }
  },
  cliDeny: async (code: string, orgId: string) => {
    const prev = getActiveOrgId();
    setActiveOrgId(orgId);
    try {
      return await guardianFetch<{ denied: true }>("/auth/cli/deny", {
        method: "POST",
        body: JSON.stringify({ code }),
      });
    } finally {
      setActiveOrgId(prev);
    }
  },

  // Agent Guard — coding-agent budget-trip events
  getAgentGuardEvents: (params?: { limit?: number; skip?: number }) => {
    const qs = new URLSearchParams();
    if (params?.limit) qs.set("limit", String(params.limit));
    if (params?.skip) qs.set("skip", String(params.skip));
    const queryStr = qs.toString();
    return guardianFetch<any>(`/agent-guard/events${queryStr ? `?${queryStr}` : ""}`);
  },

  // Usage Budgets
  listBudgets: () => guardianFetch<any>("/budgets"),
  getBudgetStatus: () => guardianFetch<any>("/budgets/status"),
  createBudget: (data: {
    name: string;
    period: "hour" | "day" | "week" | "month" | "year";
    budgetAmountUsd: number;
    thresholdPcts?: number[];
    channels?: "all" | string[];
  }) =>
    guardianFetch<any>("/budgets", {
      method: "POST",
      body: JSON.stringify(data),
    }),
  updateBudget: (id: string, data: Partial<{
    name: string;
    period: string;
    budgetAmountUsd: number;
    thresholdPcts: number[];
    channels: "all" | string[];
    enabled: boolean;
  }>) =>
    guardianFetch<any>(`/budgets/${id}`, {
      method: "PATCH",
      body: JSON.stringify(data),
    }),
  deleteBudget: (id: string) =>
    guardianFetch<any>(`/budgets/${id}`, { method: "DELETE" }),

  // Web Push
  getVapidPublicKey: () => guardianFetch<{ publicKey: string | null }>("/push/vapid-public-key"),
  registerPushSubscription: (data: { endpoint: string; keys: { p256dh: string; auth: string } }) =>
    guardianFetch<any>("/push/subscribe", {
      method: "POST",
      body: JSON.stringify(data),
    }),
  removePushSubscription: (endpoint: string) =>
    guardianFetch<any>("/push/subscribe", {
      method: "DELETE",
      body: JSON.stringify({ endpoint }),
    }),

  // Activity Log
  getActivity: (params?: {
    page?: number; limit?: number; action?: string;
    resourceType?: string; from?: string; to?: string;
  }) => {
    const qs = new URLSearchParams();
    if (params?.page) qs.set("page", String(params.page));
    if (params?.limit) qs.set("limit", String(params.limit));
    if (params?.action) qs.set("action", params.action);
    if (params?.resourceType) qs.set("resourceType", params.resourceType);
    if (params?.from) qs.set("from", params.from);
    if (params?.to) qs.set("to", params.to);
    const queryStr = qs.toString();
    return guardianFetch<any>(`/activity${queryStr ? `?${queryStr}` : ""}`);
  },
};
