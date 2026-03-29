import { Link } from "react-router-dom";

const providers = [
  {
    id: "cloudflare",
    name: "Cloudflare",
    description: "Monitor Workers, Durable Objects, R2, D1, Queues, Stream, and Zones.",
    color: "#f6821f",
    available: true,
  },
  {
    id: "gcp",
    name: "Google Cloud",
    description: "Monitor Cloud Run, Compute Engine, GKE, BigQuery, Cloud Functions, and Cloud Storage.",
    color: "#4285f4",
    available: true,
  },
  {
    id: "aws",
    name: "Amazon Web Services",
    description: "Monitor EC2, Lambda, RDS, ECS, EKS, S3, SageMaker, and Cost Explorer.",
    color: "#ff9900",
    available: true,
  },
  {
    id: "runpod",
    name: "RunPod",
    description: "Monitor GPU pods, serverless endpoints, and network volumes.",
    color: "#673ab7",
    available: true,
  },
  {
    id: "redis",
    name: "Redis",
    description: "Monitor Redis Cloud, AWS ElastiCache, and self-hosted Redis instances.",
    color: "#dc382d",
    available: true,
  },
  {
    id: "mongodb",
    name: "MongoDB",
    description: "Monitor MongoDB Atlas clusters and self-hosted MongoDB instances.",
    color: "#00684a",
    available: true,
  },
];

export function ConnectProvider() {
  return (
    <div>
      <h1 style={{ fontFamily: "Outfit, sans-serif", fontSize: "24px", fontWeight: "700", color: "#fff", marginBottom: "8px" }}>Connect Cloud Provider</h1>
      <p style={{ color: "#6b7280", marginBottom: "32px", fontSize: "14px" }}>
        Choose a cloud provider to monitor and protect against runaway costs.
      </p>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))", gap: "16px" }}>
        {providers.map(p => (
          <div key={p.id} style={{
            position: "relative",
            padding: "24px",
            background: "rgba(255,255,255,0.03)",
            border: `1px solid ${p.available ? "rgba(255,255,255,0.08)" : "rgba(255,255,255,0.04)"}`,
            borderRadius: "12px",
            opacity: p.available ? 1 : 0.5,
          }}>
            <div style={{
              width: "12px", height: "12px", borderRadius: "50%", background: p.color,
              marginBottom: "16px",
            }} />
            <h3 style={{ color: "#fff", fontFamily: "Outfit, sans-serif", margin: "0 0 8px", fontSize: "18px" }}>
              {p.name}
            </h3>
            <p style={{ color: "#6b7280", fontSize: "13px", margin: "0 0 20px", lineHeight: "1.5" }}>
              {p.description}
            </p>
            {p.available ? (
              <Link
                to={`/accounts/connect/${p.id}`}
                style={{
                  display: "inline-block",
                  background: "rgba(255,255,255,0.08)",
                  color: "#fff",
                  border: "1px solid rgba(255,255,255,0.15)",
                  padding: "8px 20px",
                  borderRadius: "8px",
                  textDecoration: "none",
                  fontSize: "13px",
                  fontWeight: "600",
                }}
              >
                Connect
              </Link>
            ) : (
              <span style={{ fontSize: "13px", color: "#6b7280", fontStyle: "italic" }}>Coming soon</span>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
