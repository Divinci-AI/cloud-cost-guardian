import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { api } from "../../api/client";

interface Plan {
  tier: string;
  name: string;
  price?: number;
  monthlyPrice?: number;
  annualPrice?: number;
  features: string[];
  contactUs?: boolean;
  priceIds?: { monthly: string; annual: string };
}

export function BillingPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [plans, setPlans] = useState<Plan[]>([]);
  const [status, setStatus] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [annual, setAnnual] = useState(false);

  const successParam = searchParams.get("success");
  const canceledParam = searchParams.get("canceled");
  const planParam = searchParams.get("plan");

  useEffect(() => {
    Promise.all([
      api.getPlans().then(d => setPlans(d.plans)),
      api.getBillingStatus().then(d => setStatus(d)),
    ]).finally(() => setLoading(false));
  }, []);

  // Clear success/canceled params after displaying
  useEffect(() => {
    if (successParam || canceledParam) {
      const timer = setTimeout(() => {
        searchParams.delete("success");
        searchParams.delete("canceled");
        setSearchParams(searchParams, { replace: true });
      }, 8000);
      return () => clearTimeout(timer);
    }
  }, [successParam, canceledParam, searchParams, setSearchParams]);

  const handleCheckout = async (planKey: string) => {
    try {
      const successUrl = `${window.location.origin}/billing?success=true`;
      const cancelUrl = `${window.location.origin}/billing?canceled=true`;
      const data = await api.createCheckout(planKey, successUrl, cancelUrl);
      window.location.href = data.checkoutUrl;
    } catch (e: any) {
      alert(e.message);
    }
  };

  const handleManage = async () => {
    try {
      const returnUrl = `${window.location.origin}/billing`;
      const data = await api.createPortal(returnUrl);
      window.location.href = data.portalUrl;
    } catch (e: any) {
      alert(e.message);
    }
  };

  if (loading) return <p>Loading...</p>;

  return (
    <div>
      {/* Success banner */}
      {successParam === "true" && (
        <div style={{
          padding: "14px 20px", borderRadius: "10px", marginBottom: "24px",
          background: "rgba(92,226,231,0.1)", border: "1px solid rgba(92,226,231,0.25)",
          display: "flex", alignItems: "center", gap: "10px",
        }}>
          <span style={{ fontSize: "20px" }}>&#9989;</span>
          <div>
            <div style={{ color: "#5ce2e7", fontWeight: "600", fontSize: "15px" }}>Upgrade complete!</div>
            <div style={{ color: "#8b8fa3", fontSize: "13px" }}>Your new plan is now active. Enjoy faster monitoring and more cloud accounts.</div>
          </div>
        </div>
      )}

      {/* Canceled banner */}
      {canceledParam === "true" && (
        <div style={{
          padding: "14px 20px", borderRadius: "10px", marginBottom: "24px",
          background: "rgba(255,165,0,0.08)", border: "1px solid rgba(255,165,0,0.2)",
          display: "flex", alignItems: "center", gap: "10px",
        }}>
          <span style={{ fontSize: "20px" }}>&#8617;&#65039;</span>
          <div>
            <div style={{ color: "#ffa07a", fontWeight: "600", fontSize: "15px" }}>Checkout canceled</div>
            <div style={{ color: "#8b8fa3", fontSize: "13px" }}>No changes were made to your plan. You can upgrade anytime.</div>
          </div>
        </div>
      )}

      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "32px" }}>
        <div>
          <h1 style={{ fontFamily: "Outfit, sans-serif", fontSize: "28px", fontWeight: "700", color: "#fff", margin: 0 }}>Billing</h1>
          <p style={{ color: "#6b7280", marginTop: "4px" }}>
            Current plan: <span style={{ color: "#5ce2e7", fontWeight: "600" }}>{status?.tier?.toUpperCase()}</span>
          </p>
        </div>
        {status?.subscription && (
          <button onClick={handleManage} style={{ background: "rgba(255,255,255,0.08)", color: "#fff", border: "1px solid rgba(255,255,255,0.15)", padding: "8px 20px", borderRadius: "8px", cursor: "pointer", fontSize: "14px" }}>
            Manage Subscription
          </button>
        )}
      </div>

      {/* Billing toggle */}
      <div style={{ display: "flex", justifyContent: "center", marginBottom: "32px", gap: "8px", alignItems: "center" }}>
        <span style={{ color: !annual ? "#fff" : "#6b7280", fontWeight: "600", fontSize: "14px" }}>Monthly</span>
        <button onClick={() => setAnnual(!annual)} style={{
          width: "48px", height: "26px", borderRadius: "13px", border: "none", cursor: "pointer",
          background: annual ? "#5ce2e7" : "rgba(255,255,255,0.15)", position: "relative", transition: "background 0.2s",
        }}>
          <div style={{
            width: "20px", height: "20px", borderRadius: "50%", background: "#fff",
            position: "absolute", top: "3px", left: annual ? "25px" : "3px", transition: "left 0.2s",
          }} />
        </button>
        <span style={{ color: annual ? "#fff" : "#6b7280", fontWeight: "600", fontSize: "14px" }}>Annual <span style={{ color: "#5ce2e7" }}>(-17%)</span></span>
      </div>

      {/* Plan cards */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(250px, 1fr))", gap: "16px" }}>
        {plans.map(plan => {
          const isCurrent = plan.tier === status?.tier;
          const isHighlighted = planParam === plan.tier;
          const isFree = plan.price === 0 || (!plan.monthlyPrice && !plan.annualPrice && !plan.contactUs);
          const price = isFree ? 0 : (annual ? plan.annualPrice : plan.monthlyPrice);
          const displayPrice = isFree ? 0 : (annual && plan.annualPrice ? Math.round(plan.annualPrice / 12) : plan.monthlyPrice);
          const planKey = plan.priceIds ? (annual ? `guardian_${plan.tier}_annual` : `guardian_${plan.tier}_monthly`) : null;

          return (
            <div key={plan.tier} style={{
              padding: "28px", borderRadius: "12px",
              background: isCurrent ? "rgba(92,226,231,0.05)" : isHighlighted ? "rgba(194,88,0,0.06)" : "rgba(255,255,255,0.03)",
              border: isCurrent ? "2px solid rgba(92,226,231,0.3)" : isHighlighted ? "2px solid rgba(194,88,0,0.4)" : "1px solid rgba(255,255,255,0.06)",
              transition: "border-color 0.3s, background 0.3s",
            }}>
              {isHighlighted && !isCurrent && (
                <div style={{ fontSize: "11px", fontWeight: "700", color: "#c25800", textTransform: "uppercase", letterSpacing: "1px", marginBottom: "8px" }}>
                  Recommended
                </div>
              )}
              <h3 style={{ fontFamily: "Outfit, sans-serif", color: "#fff", marginBottom: "8px" }}>{plan.name}</h3>
              <div style={{ marginBottom: "20px" }}>
                {plan.contactUs ? (
                  <span style={{ color: "#8b8fa3", fontSize: "14px" }}>Contact us</span>
                ) : price === 0 ? (
                  <span style={{ fontFamily: "Outfit, sans-serif", fontSize: "32px", fontWeight: "800", color: "#5ce2e7" }}>Free</span>
                ) : (
                  <>
                    <span style={{ fontFamily: "Outfit, sans-serif", fontSize: "32px", fontWeight: "800", color: "#fff" }}>${displayPrice}</span>
                    <span style={{ color: "#6b7280", fontSize: "14px" }}>/mo</span>
                    {annual && <div style={{ fontSize: "12px", color: "#5ce2e7" }}>Billed ${price}/year</div>}
                  </>
                )}
              </div>
              <ul style={{ listStyle: "none", padding: 0, marginBottom: "24px" }}>
                {plan.features.map((f, i) => (
                  <li key={i} style={{ fontSize: "13px", color: "#c4c5ca", padding: "4px 0", display: "flex", gap: "8px" }}>
                    <span style={{ color: "#5ce2e7" }}>&#10003;</span> {f}
                  </li>
                ))}
              </ul>
              {isCurrent ? (
                <div style={{ textAlign: "center", padding: "10px", color: "#5ce2e7", fontWeight: "600", fontSize: "14px" }}>Current Plan</div>
              ) : planKey ? (
                <button onClick={() => handleCheckout(planKey)} style={{
                  width: "100%", padding: "10px", borderRadius: "8px", border: "none", cursor: "pointer",
                  background: plan.tier === "pro" || isHighlighted ? "#c25800" : "rgba(255,255,255,0.08)",
                  color: "#fff", fontWeight: "600", fontSize: "14px",
                }}>
                  {plan.tier === "pro" ? "Upgrade to Pro" : `Upgrade to ${plan.name}`}
                </button>
              ) : plan.contactUs ? (
                <a href="mailto:support@divinci.ai" style={{
                  display: "block", textAlign: "center", padding: "10px", borderRadius: "8px",
                  border: "1px solid rgba(255,255,255,0.15)", color: "#fff", textDecoration: "none", fontSize: "14px",
                }}>
                  Contact Sales
                </a>
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}
