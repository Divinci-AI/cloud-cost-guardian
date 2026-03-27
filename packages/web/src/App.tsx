import { BrowserRouter, Routes, Route, Link, Navigate, useLocation } from "react-router-dom";
import { useAuth0 } from "@auth0/auth0-react";
import { useEffect, useState } from "react";
import { setTokenGetter, api } from "./api/client";
import { DashboardPage } from "./pages/Dashboard/DashboardPage";
import { CloudAccountsList } from "./pages/CloudAccounts/CloudAccountsList";
import { ConnectCloudflare } from "./pages/CloudAccounts/ConnectCloudflare";
import { ConnectGCP } from "./pages/CloudAccounts/ConnectGCP";
import { ConnectAWS } from "./pages/CloudAccounts/ConnectAWS";
import { ConnectProvider } from "./pages/CloudAccounts/ConnectProvider";
import { AlertsHistory } from "./pages/Alerts/AlertsHistory";
import { BillingPage } from "./pages/Billing/BillingPage";
import { OnboardingPage } from "./pages/Onboarding/OnboardingPage";
import { SettingsPage } from "./pages/Settings/SettingsPage";
import { AcceptInvitePage } from "./pages/Team/AcceptInvitePage";

function AuthenticatedApp() {
  const { isAuthenticated, isLoading, loginWithRedirect, logout, getAccessTokenSilently, user } = useAuth0();
  const location = useLocation();
  const [accountReady, setAccountReady] = useState(false);
  const [needsOnboarding, setNeedsOnboarding] = useState(false);

  useEffect(() => {
    if (isAuthenticated) {
      setTokenGetter(() => getAccessTokenSilently({
        authorizationParams: { audience: import.meta.env.VITE_AUTH0_AUDIENCE },
      }));
    }
  }, [isAuthenticated, getAccessTokenSilently]);

  // Fetch account status after auth to check onboarding
  useEffect(() => {
    if (isAuthenticated) {
      api.getMe()
        .then(account => {
          setNeedsOnboarding(!account.onboardingCompleted);
          setAccountReady(true);
        })
        .catch(() => {
          // Account may not exist yet (first request auto-creates it)
          setNeedsOnboarding(true);
          setAccountReady(true);
        });
    }
  }, [isAuthenticated]);

  // Auto-redirect unauthenticated users to Auth0, preserving the original URL
  useEffect(() => {
    if (!isLoading && !isAuthenticated) {
      const params = new URLSearchParams(window.location.search);
      const screenHint = params.get("screen_hint") || "login";
      // Preserve the full path + search so Auth0 can redirect back after login
      // (e.g., /invite?token=abc, /billing?plan=pro)
      const returnTo = window.location.pathname + window.location.search;
      loginWithRedirect({
        authorizationParams: { screen_hint: screenHint },
        appState: { returnTo },
      });
    }
  }, [isLoading, isAuthenticated, loginWithRedirect]);

  if (isLoading || !isAuthenticated || !accountReady) {
    return (
      <div style={{ display: "flex", justifyContent: "center", alignItems: "center", height: "100vh", background: "#0c1229", color: "#fff" }}>
        <p>Loading...</p>
      </div>
    );
  }

  // Show onboarding wizard for new users (full-screen, no nav)
  if (needsOnboarding && location.pathname !== "/billing" && !location.pathname.startsWith("/invite")) {
    return (
      <div style={{ minHeight: "100vh", background: "#0c1229", color: "#c4c5ca" }}>
        <OnboardingPage onComplete={() => setNeedsOnboarding(false)} />
      </div>
    );
  }

  return (
    <div style={{ minHeight: "100vh", background: "#0c1229", color: "#c4c5ca" }}>
      {/* Nav */}
      <nav style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "0 24px", height: "56px", background: "rgba(51,51,51,0.55)", backdropFilter: "blur(12px)", borderBottom: "1px solid rgba(255,255,255,0.06)" }}>
        <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
          <span style={{ fontSize: "20px" }}>&#9889;</span>
          <Link to="/" style={{ fontFamily: "Outfit, sans-serif", fontWeight: "600", fontSize: "18px", color: "#fff", textDecoration: "none" }}>Guardian</Link>
        </div>
        <div style={{ display: "flex", gap: "20px", alignItems: "center" }}>
          <Link to="/" style={{ color: "#c4c5ca", textDecoration: "none", fontSize: "14px" }}>Dashboard</Link>
          <Link to="/accounts" style={{ color: "#c4c5ca", textDecoration: "none", fontSize: "14px" }}>Accounts</Link>
          <Link to="/alerts" style={{ color: "#c4c5ca", textDecoration: "none", fontSize: "14px" }}>Alerts</Link>
          <Link to="/billing" style={{ color: "#c4c5ca", textDecoration: "none", fontSize: "14px" }}>Billing</Link>
          <Link to="/settings" style={{ color: "#c4c5ca", textDecoration: "none", fontSize: "14px" }}>Settings</Link>
          <span style={{ color: "#6b7280", fontSize: "13px" }}>{user?.email}</span>
          <button
            onClick={() => logout({ logoutParams: { returnTo: window.location.origin } })}
            style={{ background: "rgba(255,255,255,0.08)", color: "#c4c5ca", border: "1px solid rgba(255,255,255,0.1)", padding: "4px 12px", borderRadius: "6px", fontSize: "13px", cursor: "pointer" }}
          >
            Sign Out
          </button>
        </div>
      </nav>

      {/* Content */}
      <main style={{ maxWidth: "1100px", margin: "0 auto", padding: "32px 24px" }}>
        <Routes>
          <Route path="/" element={<DashboardPage />} />
          <Route path="/accounts" element={<CloudAccountsList />} />
          <Route path="/accounts/connect" element={<ConnectProvider />} />
          <Route path="/accounts/connect/cloudflare" element={<ConnectCloudflare />} />
          <Route path="/accounts/connect/gcp" element={<ConnectGCP />} />
          <Route path="/accounts/connect/aws" element={<ConnectAWS />} />
          <Route path="/alerts" element={<AlertsHistory />} />
          <Route path="/billing" element={<BillingPage />} />
          <Route path="/settings" element={<SettingsPage />} />
          <Route path="/invite" element={<AcceptInvitePage />} />
          <Route path="*" element={<Navigate to="/" />} />
        </Routes>
      </main>
    </div>
  );
}

export function App() {
  return (
    <BrowserRouter>
      <AuthenticatedApp />
    </BrowserRouter>
  );
}
