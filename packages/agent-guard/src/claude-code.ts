/**
 * Read what Claude Code persists locally about the account.
 *
 * Claude Code stores the user's plan tier in `~/.claude.json` under
 * `oauthAccount` — so we can auto-detect it instead of making the user pass
 * `--plan`. Note: Claude Code does NOT persist the live `/usage` rate-limit
 * percentages anywhere readable (they're fetched from Anthropic and rendered in
 * the TUI only) — the proxy's `unified-*` response headers remain the single
 * source of truth for real utilization. This module is best-effort and never
 * throws; a missing/unreadable file just means "unknown".
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** The subscription tiers agent-guard knows about (a subset of LimitsConfig.plan). */
export type SubscriptionTier = "pro" | "max5" | "max20";

/** Map a Claude Code rate-limit-tier string (e.g. "default_claude_max_20x") to our tier. */
export function mapRateLimitTier(raw: string | null | undefined): SubscriptionTier | null {
  if (!raw) return null;
  const s = raw.toLowerCase();
  if (/max[_-]?20x/.test(s)) return "max20";
  if (/max[_-]?5x/.test(s)) return "max5";
  if (s.includes("pro")) return "pro";
  // Anything else (free, team, enterprise, unknown) → no estimate-tier mapping.
  return null;
}

/**
 * Best-effort read of the user's plan tier from `~/.claude.json`. Prefers the
 * per-user tier over the org default when present. Returns null if absent.
 */
export function detectPlanTier(claudeJsonPath = join(homedir(), ".claude.json")): SubscriptionTier | null {
  try {
    const j = JSON.parse(readFileSync(claudeJsonPath, "utf8")) as {
      oauthAccount?: { userRateLimitTier?: string | null; organizationRateLimitTier?: string | null };
    };
    const acct = j.oauthAccount;
    if (!acct) return null;
    return mapRateLimitTier(acct.userRateLimitTier) ?? mapRateLimitTier(acct.organizationRateLimitTier);
  } catch {
    return null;
  }
}

/** Human label for a tier. */
export function tierLabel(tier: SubscriptionTier): string {
  return tier === "max20" ? "Max 20x" : tier === "max5" ? "Max 5x" : "Pro";
}
