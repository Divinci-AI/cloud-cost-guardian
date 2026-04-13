import { Link } from "react-router-dom";
import { isTierLimitError } from "../api/client";

export function TierLimitBanner({ error }: { error: string | null }) {
  if (!error) return null;

  return (
    <div style={{
      padding: "12px 16px",
      background: "rgba(255,107,107,0.1)",
      border: "1px solid rgba(255,107,107,0.2)",
      borderRadius: "8px",
      color: "#ff6b6b",
      fontSize: "13px",
    }}>
      {error}
    </div>
  );
}

export function UpgradeBanner({ error }: { error: unknown }) {
  if (!isTierLimitError(error)) return null;

  const suggestedPlan = error.currentTier === "none" || error.currentTier === "free" ? "pro" : "team";

  return (
    <div style={{
      padding: "16px",
      background: "rgba(194, 88, 0, 0.1)",
      border: "1px solid rgba(224, 104, 0, 0.3)",
      borderRadius: "8px",
      display: "flex",
      alignItems: "center",
      justifyContent: "space-between",
      gap: "16px",
    }}>
      <div>
        <div style={{ color: "#ff9d42", fontSize: "14px", fontWeight: "600", marginBottom: "4px" }}>
          Plan limit reached
        </div>
        <div style={{ color: "#c4c5ca", fontSize: "13px" }}>
          {error.message}
        </div>
      </div>
      <Link
        to={`/billing?plan=${suggestedPlan}`}
        style={{
          display: "inline-block",
          background: "linear-gradient(135deg, #c25800, #e06800)",
          color: "#fff",
          padding: "8px 20px",
          borderRadius: "8px",
          textDecoration: "none",
          fontSize: "13px",
          fontWeight: "600",
          whiteSpace: "nowrap",
        }}
      >
        Upgrade Plan
      </Link>
    </div>
  );
}
