import { useState, useEffect } from "react";
import { useSearchParams, useNavigate } from "react-router-dom";
import { api } from "../../api/client";

export function AcceptInvitePage() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const token = searchParams.get("token");
  const [status, setStatus] = useState<"loading" | "ready" | "accepting" | "success" | "error">("ready");
  const [error, setError] = useState("");

  useEffect(() => {
    if (!token) {
      setStatus("error");
      setError("No invitation token provided.");
    }
  }, [token]);

  const handleAccept = async () => {
    if (!token) return;
    setStatus("accepting");
    try {
      const result = await api.acceptInvitation(token);
      setStatus("success");
      setTimeout(() => navigate("/"), 2000);
    } catch (e: any) {
      setStatus("error");
      setError(e.message || "Failed to accept invitation");
    }
  };

  return (
    <div style={{ maxWidth: "480px", margin: "0 auto", padding: "80px 24px", textAlign: "center" }}>
      {status === "ready" && (
        <>
          <div style={{ fontSize: "48px", marginBottom: "16px" }}>&#9993;&#65039;</div>
          <h1 style={{ fontFamily: "Outfit, sans-serif", fontSize: "28px", fontWeight: "700", color: "#fff", marginBottom: "12px" }}>
            Team Invitation
          </h1>
          <p style={{ color: "#8b8fa3", fontSize: "16px", marginBottom: "32px", lineHeight: "1.6" }}>
            You've been invited to join a team on Kill Switch.
            Accept to start collaborating on cloud cost monitoring.
          </p>
          <button
            onClick={handleAccept}
            style={{
              background: "linear-gradient(135deg, #c25800, #e06800)", color: "#fff", border: "none",
              padding: "14px 36px", borderRadius: "8px", fontSize: "16px", fontWeight: "700", cursor: "pointer",
            }}
          >
            Accept Invitation
          </button>
        </>
      )}

      {status === "accepting" && (
        <>
          <div style={{ fontSize: "48px", marginBottom: "16px" }}>&#9203;</div>
          <p style={{ color: "#8b8fa3", fontSize: "16px" }}>Joining team...</p>
        </>
      )}

      {status === "success" && (
        <>
          <div style={{ fontSize: "48px", marginBottom: "16px" }}>&#9989;</div>
          <h2 style={{ fontFamily: "Outfit, sans-serif", fontSize: "24px", fontWeight: "700", color: "#fff", marginBottom: "12px" }}>
            You're in!
          </h2>
          <p style={{ color: "#8b8fa3", fontSize: "16px" }}>
            Redirecting to the dashboard...
          </p>
        </>
      )}

      {status === "error" && (
        <>
          <div style={{ fontSize: "48px", marginBottom: "16px" }}>&#10060;</div>
          <h2 style={{ fontFamily: "Outfit, sans-serif", fontSize: "24px", fontWeight: "700", color: "#ff6b6b", marginBottom: "12px" }}>
            Couldn't join team
          </h2>
          <p style={{ color: "#8b8fa3", fontSize: "15px", marginBottom: "24px" }}>{error}</p>
          <button
            onClick={() => navigate("/")}
            style={{
              background: "rgba(255,255,255,0.08)", color: "#fff",
              border: "1px solid rgba(255,255,255,0.15)",
              padding: "10px 24px", borderRadius: "8px", fontSize: "14px", fontWeight: "600", cursor: "pointer",
            }}
          >
            Go to Dashboard
          </button>
        </>
      )}
    </div>
  );
}
