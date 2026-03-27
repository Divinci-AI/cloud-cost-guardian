/**
 * Guardian API Client
 *
 * Authenticated fetch wrapper that attaches Auth0 JWT to all requests.
 */

const API_URL = import.meta.env.VITE_API_URL || "http://localhost:8090";

let getAccessToken: (() => Promise<string>) | null = null;

export function setTokenGetter(fn: () => Promise<string>) {
  getAccessToken = fn;
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

  const res = await fetch(`${API_URL}${path}`, { ...options, headers });

  const text = await res.text();
  let data: any;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`API error (${res.status}): ${text.substring(0, 200)}`);
  }

  if (!res.ok) {
    throw new Error(data.error || `API error: ${res.status}`);
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

  // Rules
  listRules: () => guardianFetch<any>("/rules"),
  listPresets: () => guardianFetch<any>("/rules/presets"),
  applyPreset: (presetId: string, customValues?: any) =>
    guardianFetch<any>(`/rules/presets/${presetId}`, {
      method: "POST",
      body: JSON.stringify(customValues || {}),
    }),
};
