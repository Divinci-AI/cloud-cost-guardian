import { describe, it, expect } from "vitest";
import { evaluate, type Budget } from "../src/budget.js";

const B: Budget = { sessionSoftUSD: 5, sessionHardUSD: 20, dailySoftUSD: 25, dailyHardUSD: 100 };

describe("budget.evaluate", () => {
  it("is ok below all soft caps", () => {
    expect(evaluate({ sessionUSD: 1, dailyUSD: 3 }, B).level).toBe("ok");
  });

  it("warns when a soft cap is crossed", () => {
    const v = evaluate({ sessionUSD: 6, dailyUSD: 3 }, B);
    expect(v.level).toBe("warn");
    expect(v.triggers).toHaveLength(1);
    expect(v.triggers[0]).toMatchObject({ scope: "session", level: "warn" });
  });

  it("blocks at the hard cap (>= boundary)", () => {
    expect(evaluate({ sessionUSD: 20, dailyUSD: 3 }, B).level).toBe("block");
    expect(evaluate({ sessionUSD: 1, dailyUSD: 100 }, B).level).toBe("block");
  });

  it("block on either scope wins over warn on the other", () => {
    const v = evaluate({ sessionUSD: 6, dailyUSD: 100 }, B);
    expect(v.level).toBe("block");
    expect(v.triggers.some((t) => t.scope === "daily" && t.level === "block")).toBe(true);
  });

  it("treats a 0 cap as disabled", () => {
    const disabled: Budget = { sessionSoftUSD: 0, sessionHardUSD: 0, dailySoftUSD: 0, dailyHardUSD: 0 };
    expect(evaluate({ sessionUSD: 999, dailyUSD: 999 }, disabled).level).toBe("ok");
  });
});
