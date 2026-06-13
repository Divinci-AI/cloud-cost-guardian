/**
 * Real subscription usage from Anthropic's OAuth usage endpoint.
 *
 * This is the authoritative, structured source for Claude Code Pro/Max limits —
 * the same data the `/usage` command shows — without a proxy, a screen-scrape, or
 * a (hopeless) local estimate. It's the endpoint the polished community status-
 * line tools settled on. One caveat: it's **undocumented**, so Anthropic could
 * change or gate it; every call here fails soft (returns null) and the caller
 * falls back to the proxy / "unknown".
 *
 * Token handling: the OAuth access token is read from the OS credential store
 * (macOS Keychain `Claude Code-credentials`, or `~/.claude/.credentials.json` on
 * Linux), used only as a Bearer header on the GET, and **never logged or
 * persisted** by us.
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join } from "node:path";
import {
  loadLimitsState,
  saveLimitsState,
  parseReset,
  type LimitSnapshot,
  type ExtraWindow,
  type WindowState,
} from "./limits.js";

const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const OAUTH_BETA = "oauth-2025-04-20";
const DEFAULT_THROTTLE_MS = 120_000; // don't hammer the endpoint

/**
 * Best-effort read of the Claude Code OAuth access token from the OS credential
 * store. Returns null (never throws, never logs the token) if unavailable.
 */
export function readOAuthToken(): string | null {
  try {
    let raw: string;
    if (platform() === "darwin") {
      raw = execFileSync("security", ["find-generic-password", "-s", "Claude Code-credentials", "-w"], {
        encoding: "utf8",
        timeout: 4000,
        stdio: ["ignore", "pipe", "ignore"],
      });
    } else {
      raw = readFileSync(join(homedir(), ".claude", ".credentials.json"), "utf8");
    }
    const j = JSON.parse(raw) as { claudeAiOauth?: { accessToken?: string }; accessToken?: string };
    return j?.claudeAiOauth?.accessToken ?? j?.accessToken ?? null;
  } catch {
    return null;
  }
}

interface UsageWindow {
  utilization?: number | null;
  resets_at?: string | null;
}

export interface UsageResponse {
  five_hour?: UsageWindow | null;
  seven_day?: UsageWindow | null;
  seven_day_sonnet?: UsageWindow | null;
  seven_day_opus?: UsageWindow | null;
  extra_usage?: { is_enabled?: boolean; monthly_limit?: number; used_credits?: number } | null;
}

/** GET the usage endpoint with the given token. Returns null on any failure. */
export async function fetchUsage(token: string, timeoutMs = 8000): Promise<UsageResponse | null> {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    let res: Response;
    try {
      res = await fetch(USAGE_URL, {
        headers: {
          authorization: `Bearer ${token}`,
          "anthropic-beta": OAUTH_BETA,
          "content-type": "application/json",
        },
        signal: ctrl.signal,
      });
    } finally {
      clearTimeout(t);
    }
    if (!res.ok) return null;
    return (await res.json()) as UsageResponse;
  } catch {
    return null;
  }
}

/**
 * Convert one endpoint window to a {@link WindowState}. The endpoint's
 * `utilization` is an integer **percent** (0–100) — including small values like
 * 1 (= 1%), so we always divide by 100 (NOT the header parser's ambiguous
 * >1.5 heuristic, which would read 1 as 100%).
 */
function toWindow(u: UsageWindow | null | undefined, now: number): WindowState | null {
  if (!u || typeof u.utilization !== "number") return null;
  return {
    utilization: Math.max(0, Math.min(1, u.utilization / 100)),
    resetAt: parseReset(u.resets_at ?? null, now),
  };
}

/** Map the OAuth usage response into a {@link LimitSnapshot}. */
export function usageToSnapshot(u: UsageResponse, now: number): LimitSnapshot {
  const extras: ExtraWindow[] = [];
  const addExtra = (label: string, w: UsageWindow | null | undefined) => {
    const s = toWindow(w, now);
    if (s) extras.push({ label, utilization: s.utilization, resetAt: s.resetAt });
  };
  addExtra("weekly · Sonnet", u.seven_day_sonnet);
  addExtra("weekly · Opus", u.seven_day_opus);

  return {
    fiveHour: toWindow(u.five_hour, now),
    weekly: toWindow(u.seven_day, now),
    status: "oauth-usage",
    observedAt: now,
    extras: extras.length ? extras : undefined,
  };
}

/**
 * Fetch real usage and persist it as the live snapshot, throttled. Returns the
 * fresh snapshot on a successful fetch, or null if we skipped (throttled) or
 * couldn't fetch (no token / endpoint down — caller falls back gracefully).
 */
export async function refreshUsage(
  now: number,
  opts: { force?: boolean; throttleMs?: number } = {},
): Promise<LimitSnapshot | null> {
  const throttle = opts.throttleMs ?? DEFAULT_THROTTLE_MS;
  const state = loadLimitsState();
  if (!opts.force && state.lastFetchAt && now - state.lastFetchAt < throttle && state.snapshot) {
    return null; // recent enough — use the cached snapshot
  }
  const token = readOAuthToken();
  if (!token) return null;
  const usage = await fetchUsage(token);
  if (!usage) {
    // mark the attempt so we don't retry every call when the endpoint is down
    saveLimitsState({ ...loadLimitsState(), lastFetchAt: now });
    return null;
  }
  const snapshot = usageToSnapshot(usage, now);
  const fresh = loadLimitsState();
  saveLimitsState({ ...fresh, subscriptionDetected: true, snapshot, lastFetchAt: now });
  return snapshot;
}
