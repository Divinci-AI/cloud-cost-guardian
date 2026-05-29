/**
 * Billing payment-lifecycle policy tests
 *
 * Validates the audit B1 fix: a Stripe subscription status maps to the right action
 * on the account (healthy → apply plan, dead → downgrade, transient → grace period).
 */

import { describe, it, expect } from "vitest";
import { classifySubscriptionStatus } from "../../src/routes/billing/index.js";

describe("classifySubscriptionStatus", () => {
  it("treats active/trialing as apply", () => {
    expect(classifySubscriptionStatus("active")).toBe("apply");
    expect(classifySubscriptionStatus("trialing")).toBe("apply");
  });

  it("downgrades on dead statuses (dunning exhausted / canceled)", () => {
    for (const s of ["unpaid", "canceled", "incomplete_expired"]) {
      expect(classifySubscriptionStatus(s)).toBe("downgrade");
    }
  });

  it("keeps the tier during transient/grace statuses", () => {
    // past_due is the key one: a failed card must NOT instantly drop the tier,
    // but also must not be treated as healthy.
    expect(classifySubscriptionStatus("past_due")).toBe("grace");
    expect(classifySubscriptionStatus("incomplete")).toBe("grace");
    expect(classifySubscriptionStatus("paused")).toBe("grace");
  });
});
