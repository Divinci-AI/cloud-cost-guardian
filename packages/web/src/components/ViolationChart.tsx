export function parseViolation(v: string): { service: string; metric: string; actual: number; threshold: number } | null {
  const m = v.match(/^(.+?):\s+(.+?)\s*=\s*([\d]+)\s*\(threshold:\s*([\d]+)\)/);
  if (!m) return null;
  return { service: m[1], metric: m[2], actual: parseInt(m[3]), threshold: parseInt(m[4]) };
}

export function fmtNum(n: number): string {
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1)}B`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}K`;
  return String(n);
}

export function ViolationChart({ violations, compact = false }: { violations: string[]; compact?: boolean }) {
  const parsed = violations
    .map(parseViolation)
    .filter((p): p is NonNullable<ReturnType<typeof parseViolation>> => p !== null);
  if (!parsed.length) return null;

  const maxVal = Math.max(...parsed.map(p => p.actual));

  return (
    <div style={{ marginTop: compact ? "6px" : "10px" }}>
      {parsed.map((p, i) => {
        const actualPct = (p.actual / maxVal) * 100;
        const thresholdPct = (p.threshold / maxVal) * 100;
        const overRatio = Math.round(p.actual / p.threshold);
        const shortName = p.service.split(":").pop()?.slice(0, compact ? 20 : 28) || p.service;

        return (
          <div key={i} style={{ marginBottom: i < parsed.length - 1 ? (compact ? "8px" : "12px") : 0 }}>
            <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "3px" }}>
              <span
                title={p.service}
                style={{
                  fontSize: compact ? "10px" : "11px",
                  color: "#f87171",
                  fontFamily: "monospace",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                  maxWidth: "60%",
                }}
              >
                {shortName}
              </span>
              <span style={{ fontSize: compact ? "10px" : "11px", color: "#9ca3af", whiteSpace: "nowrap", marginLeft: "6px" }}>
                {fmtNum(p.actual)} <span style={{ color: "#ff6b6b" }}>({overRatio}×)</span>
              </span>
            </div>
            <div style={{
              position: "relative",
              height: compact ? "5px" : "8px",
              background: "rgba(255,255,255,0.06)",
              borderRadius: "4px",
              overflow: "visible",
            }}>
              <div style={{
                position: "absolute", left: 0, top: 0, height: "100%",
                width: `${actualPct}%`,
                background: "linear-gradient(90deg, rgba(255,107,107,0.4), #ff6b6b)",
                borderRadius: "4px",
              }} />
              <div
                title={`Limit: ${fmtNum(p.threshold)}`}
                style={{
                  position: "absolute",
                  top: compact ? "-2px" : "-3px",
                  bottom: compact ? "-2px" : "-3px",
                  left: `${thresholdPct}%`,
                  width: "2px",
                  background: "#fbbf24",
                  borderRadius: "1px",
                }}
              />
            </div>
          </div>
        );
      })}
      {!compact && (
        <p style={{ color: "#9ca3af", fontSize: "11px", margin: "10px 0 0" }}>
          Check the Activity page to see what actions Kill Switch took.
        </p>
      )}
    </div>
  );
}
