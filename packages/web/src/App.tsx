import { BrowserRouter, Routes, Route, Link, Navigate, useLocation } from "react-router-dom";
import { SignedIn, SignedOut, SignIn, SignUp, UserButton, useAuth, useUser } from "@clerk/clerk-react";
import { useEffect, useState } from "react";
import { setTokenGetter, api } from "./api/client";
import { OrgProvider } from "./context/OrgContext";
import { OrgSwitcher } from "./components/OrgSwitcher";
import { DashboardPage } from "./pages/Dashboard/DashboardPage";
import { CloudAccountsList } from "./pages/CloudAccounts/CloudAccountsList";
import { ConnectCloudflare } from "./pages/CloudAccounts/ConnectCloudflare";
import { ConnectGCP } from "./pages/CloudAccounts/ConnectGCP";
import { ConnectAWS } from "./pages/CloudAccounts/ConnectAWS";
import { ConnectRunPod } from "./pages/CloudAccounts/ConnectRunPod";
import { ConnectRedis } from "./pages/CloudAccounts/ConnectRedis";
import { ConnectMongoDB } from "./pages/CloudAccounts/ConnectMongoDB";
import { ConnectOpenAI } from "./pages/CloudAccounts/ConnectOpenAI";
import { ConnectAnthropic } from "./pages/CloudAccounts/ConnectAnthropic";
import { ConnectXAI } from "./pages/CloudAccounts/ConnectXAI";
import { ConnectReplicate } from "./pages/CloudAccounts/ConnectReplicate";
import { ConnectSnowflake } from "./pages/CloudAccounts/ConnectSnowflake";
import { ConnectVercel } from "./pages/CloudAccounts/ConnectVercel";
import { ConnectDatadog } from "./pages/CloudAccounts/ConnectDatadog";
import { ConnectNeon } from "./pages/CloudAccounts/ConnectNeon";
import { ConnectNeo4j } from "./pages/CloudAccounts/ConnectNeo4j";
import { ConnectProvider } from "./pages/CloudAccounts/ConnectProvider";
import { AlertsHistory } from "./pages/Alerts/AlertsHistory";
import { BillingPage } from "./pages/Billing/BillingPage";
import { OnboardingPage } from "./pages/Onboarding/OnboardingPage";
import { SettingsPage } from "./pages/Settings/SettingsPage";
import { AcceptInvitePage } from "./pages/Team/AcceptInvitePage";
import { ActivityPage } from "./pages/Activity/ActivityPage";
import { AgentGuardPage } from "./pages/AgentGuard/AgentGuardPage";
import { RulesPage } from "./pages/Rules/RulesPage";
import { DatabaseKillPage } from "./pages/Database/DatabaseKillPage";
import { CliAuthPage } from "./pages/CliAuth/CliAuthPage";
import { SiteFooter } from "./components/SiteFooter";

function AuthenticatedApp() {
  const { getToken, isLoaded } = useAuth();
  const { user } = useUser();
  const location = useLocation();
  const [accountReady, setAccountReady] = useState(false);
  const [needsOnboarding, setNeedsOnboarding] = useState(false);
  const [initialAccount, setInitialAccount] = useState<any>(null);

  useEffect(() => {
    if (isLoaded) {
      setTokenGetter(() => getToken());
    }
  }, [isLoaded, getToken]);

  // Fetch account status after auth to check onboarding + seed org context
  useEffect(() => {
    if (isLoaded && user) {
      api.getMe()
        .then(account => {
          setInitialAccount(account);
          setNeedsOnboarding(!account.onboardingCompleted);
          setAccountReady(true);
        })
        .catch(() => {
          setNeedsOnboarding(true);
          setAccountReady(true);
        });
    }
  }, [isLoaded, user]);

  if (!isLoaded || !accountReady) {
    return (
      <div style={{ display: "flex", justifyContent: "center", alignItems: "center", height: "100vh", background: "#0c1229", color: "#fff" }}>
        <p>Loading...</p>
      </div>
    );
  }

  // CLI device-flow auth: full-screen, no nav, bypasses onboarding gate so
  // first-time CLI users can authorize without finishing the wizard first.
  if (location.pathname === "/cli-auth") {
    return <CliAuthPage />;
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
    <OrgProvider initialAccount={initialAccount}>
      <div style={{ minHeight: "100vh", background: "#0c1229", color: "#c4c5ca" }}>
        {/* Nav */}
        <nav style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "0 24px", height: "56px", background: "rgba(51,51,51,0.55)", backdropFilter: "blur(12px)", borderBottom: "1px solid rgba(255,255,255,0.06)" }}>
          <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
            <span style={{ fontSize: "20px" }}>&#9889;</span>
            <Link to="/" style={{ fontFamily: "Outfit, sans-serif", fontWeight: "600", fontSize: "18px", color: "#fff", textDecoration: "none" }}>Kill Switch</Link>
            <span style={{ display: "inline-block", background: "rgba(194, 88, 0, 0.25)", border: "1px solid rgba(224, 104, 0, 0.5)", borderRadius: "6px", padding: "2px 8px", fontSize: "11px", fontWeight: "700", color: "#ff9d42", textTransform: "uppercase" as const, letterSpacing: "0.5px" }}>Beta</span>
            <OrgSwitcher />
          </div>
          <div style={{ display: "flex", gap: "20px", alignItems: "center" }}>
            <Link to="/" style={{ color: "#c4c5ca", textDecoration: "none", fontSize: "14px" }}>Dashboard</Link>
            <Link to="/accounts" style={{ color: "#c4c5ca", textDecoration: "none", fontSize: "14px" }}>Accounts</Link>
            <Link to="/rules" style={{ color: "#c4c5ca", textDecoration: "none", fontSize: "14px" }}>Rules</Link>
            <Link to="/database" style={{ color: "#c4c5ca", textDecoration: "none", fontSize: "14px" }}>Databases</Link>
            <Link to="/agent-guard" style={{ color: "#c4c5ca", textDecoration: "none", fontSize: "14px" }}>Agent Guard</Link>
            <Link to="/alerts" style={{ color: "#c4c5ca", textDecoration: "none", fontSize: "14px" }}>Alerts</Link>
            <Link to="/activity" style={{ color: "#c4c5ca", textDecoration: "none", fontSize: "14px" }}>Activity</Link>
            <Link to="/billing" style={{ color: "#c4c5ca", textDecoration: "none", fontSize: "14px" }}>Billing</Link>
            <Link to="/settings" style={{ color: "#c4c5ca", textDecoration: "none", fontSize: "14px" }}>Settings</Link>
            <a href="https://kill-switch.net/docs/" target="_blank" rel="noopener noreferrer" style={{ color: "#c4c5ca", textDecoration: "none", fontSize: "14px" }}>Docs</a>
            <UserButton afterSignOutUrl="/" />
          </div>
        </nav>

        {/* Content */}
        <main style={{ maxWidth: "1100px", margin: "0 auto", padding: "32px 24px", minHeight: "calc(100vh - 56px - 73px)" }}>
          <Routes>
            <Route path="/" element={<DashboardPage />} />
            <Route path="/accounts" element={<CloudAccountsList />} />
            <Route path="/accounts/connect" element={<ConnectProvider />} />
            <Route path="/accounts/connect/cloudflare" element={<ConnectCloudflare />} />
            <Route path="/accounts/connect/gcp" element={<ConnectGCP />} />
            <Route path="/accounts/connect/aws" element={<ConnectAWS />} />
            <Route path="/accounts/connect/runpod" element={<ConnectRunPod />} />
            <Route path="/accounts/connect/redis" element={<ConnectRedis />} />
            <Route path="/accounts/connect/mongodb" element={<ConnectMongoDB />} />
            <Route path="/accounts/connect/openai" element={<ConnectOpenAI />} />
            <Route path="/accounts/connect/anthropic" element={<ConnectAnthropic />} />
            <Route path="/accounts/connect/xai" element={<ConnectXAI />} />
            <Route path="/accounts/connect/replicate" element={<ConnectReplicate />} />
            <Route path="/accounts/connect/snowflake" element={<ConnectSnowflake />} />
            <Route path="/accounts/connect/vercel" element={<ConnectVercel />} />
            <Route path="/accounts/connect/datadog" element={<ConnectDatadog />} />
            <Route path="/accounts/connect/neon" element={<ConnectNeon />} />
            <Route path="/accounts/connect/neo4j" element={<ConnectNeo4j />} />
            <Route path="/rules" element={<RulesPage />} />
            <Route path="/database" element={<DatabaseKillPage />} />
            <Route path="/alerts" element={<AlertsHistory />} />
            <Route path="/activity" element={<ActivityPage />} />
            <Route path="/agent-guard" element={<AgentGuardPage />} />
            <Route path="/billing" element={<BillingPage />} />
            <Route path="/settings" element={<SettingsPage />} />
            <Route path="/invite" element={<AcceptInvitePage />} />
            <Route path="*" element={<Navigate to="/" />} />
          </Routes>
        </main>
        <SiteFooter />
      </div>
    </OrgProvider>
  );
}

/**
 * Embedded Clerk auth on app.kill-switch.net (not Account Portal) so legal links
 * from ClerkProvider layout + our SiteFooter are visible on sign-in/sign-up.
 */
function SignedOutAuth() {
  const location = useLocation();
  const params = new URLSearchParams(location.search);

  if (location.pathname === "/" && params.get("screen_hint") === "signup") {
    return <Navigate to="/sign-up" replace />;
  }
  if (location.pathname === "/" || location.pathname === "/cli-auth") {
    return <Navigate to="/sign-in" replace />;
  }

  const authShell = (
    <div style={{ minHeight: "100vh", display: "flex", flexDirection: "column", background: "#0c1229" }}>
      <div style={{ flex: 1, display: "flex", justifyContent: "center", alignItems: "center", padding: "24px" }}>
        <Routes>
          <Route
            path="/sign-up/*"
            element={
              <SignUp
                routing="path"
                path="/sign-up"
                signInUrl="/sign-in"
                fallbackRedirectUrl="/"
              />
            }
          />
          <Route
            path="/sign-in/*"
            element={
              <SignIn
                routing="path"
                path="/sign-in"
                signUpUrl="/sign-up"
                fallbackRedirectUrl="/"
              />
            }
          />
          <Route path="*" element={<Navigate to="/sign-in" replace />} />
        </Routes>
      </div>
      <SiteFooter />
    </div>
  );

  return authShell;
}

export function App() {
  return (
    <BrowserRouter>
      <SignedIn>
        <AuthenticatedApp />
      </SignedIn>
      <SignedOut>
        <SignedOutAuth />
      </SignedOut>
    </BrowserRouter>
  );
}
