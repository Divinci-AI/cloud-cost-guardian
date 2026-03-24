import { BrowserRouter, Routes, Route, Link, Navigate } from "react-router-dom";
import { useAuth0 } from "@auth0/auth0-react";
import { useEffect } from "react";
import { setTokenGetter } from "./api/client";
import { DashboardPage } from "./pages/Dashboard/DashboardPage";
import { CloudAccountsList } from "./pages/CloudAccounts/CloudAccountsList";
import { ConnectCloudflare } from "./pages/CloudAccounts/ConnectCloudflare";
import { ConnectGCP } from "./pages/CloudAccounts/ConnectGCP";
import { ConnectAWS } from "./pages/CloudAccounts/ConnectAWS";
import { ConnectProvider } from "./pages/CloudAccounts/ConnectProvider";
import { AlertsHistory } from "./pages/Alerts/AlertsHistory";
import { BillingPage } from "./pages/Billing/BillingPage";

function AuthenticatedApp() {
  const { isAuthenticated, isLoading, loginWithRedirect, getAccessTokenSilently, user } = useAuth0();

  useEffect(() => {
    if (isAuthenticated) {
      setTokenGetter(() => getAccessTokenSilently({
        authorizationParams: { audience: import.meta.env.VITE_AUTH0_AUDIENCE },
      }));
    }
  }, [isAuthenticated, getAccessTokenSilently]);

  if (isLoading) {
    return (
      <div style={{ display: "flex", justifyContent: "center", alignItems: "center", height: "100vh", background: "#0c1229", color: "#fff" }}>
        <p>Loading...</p>
      </div>
    );
  }

  if (!isAuthenticated) {
    return (
      <div style={{ display: "flex", flexDirection: "column", justifyContent: "center", alignItems: "center", height: "100vh", background: "#0c1229", color: "#fff", gap: "20px" }}>
        <h1 style={{ fontFamily: "Outfit, sans-serif", fontSize: "32px" }}>Cloud Cost Guardian</h1>
        <p style={{ color: "#8b8fa3" }}>Monitor cloud spending. Auto-kill runaway services.</p>
        <button
          onClick={() => loginWithRedirect()}
          style={{ background: "#c25800", color: "#fff", border: "none", padding: "12px 32px", borderRadius: "8px", fontSize: "16px", fontWeight: "600", cursor: "pointer" }}
        >
          Sign In
        </button>
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
          <span style={{ color: "#6b7280", fontSize: "13px" }}>{user?.email}</span>
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
