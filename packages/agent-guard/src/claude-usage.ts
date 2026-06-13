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

import { execFileSync, spawn } from "node:child_process";
import { readFileSync, writeFileSync, renameSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join } from "node:path";
import { usageMetaPath, ensureGuardDir } from "./config.js";
import {
  loadLimitsState,
  saveLimitsState,
  parseReset,
  type LimitSnapshot,
  type ExtraWindow,
  type WindowState,
} from "./limits.js";

/**
 * Usage-fetch metadata — kept in its own small file (`usage-meta.json`), NOT in
 * limits.json, so claiming the throttle slot can never clobber the snapshot.
 *  - `lastFetchAt`: throttle timestamp.
 *  - `authorized`: set true once a *foreground* command (status/usage) read the
 *    token successfully — the gate that stops background refreshes from popping a
 *    surprise Keychain prompt before the user has opted in.
 */
interface UsageMeta {
  lastFetchAt?: number;
  authorized?: boolean;
}

export function loadUsageMeta(): UsageMeta {
  try {
    return JSON.parse(readFileSync(usageMetaPath(), "utf8")) as UsageMeta;
  } catch {
    return {};
  }
}

export function saveUsageMeta(patch: UsageMeta): void {
  try {
    ensureGuardDir();
    const next = { ...loadUsageMeta(), ...patch };
    const path = usageMetaPath();
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(next));
    renameSync(tmp, path);
  } catch {
    /* best-effort */
  }
}

const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const OAUTH_BETA = "oauth-2025-04-20";
const DEFAULT_THROTTLE_MS = 120_000; // don't hammer the endpoint

/**
 * Best-effort read of the Claude Code OAuth access token from the OS credential
 * store. Returns null (never throws, never logs the token) if unavailable.
 */
function tokenFrom(raw: string): string | null {
  try {
    const j = JSON.parse(raw) as { claudeAiOauth?: { accessToken?: string }; accessToken?: string };
    return j?.claudeAiOauth?.accessToken ?? j?.accessToken ?? null;
  } catch {
    return null;
  }
}

export function readOAuthToken(): string | null {
  // 1) Credentials file (cross-platform; some setups write it, no prompt, testable).
  try {
    const t = tokenFrom(readFileSync(join(homedir(), ".claude", ".credentials.json"), "utf8"));
    if (t) return t;
  } catch {
    /* no file — fall through */
  }
  // 2) macOS Keychain (skippable via AGENT_GUARD_NO_KEYCHAIN; Windows has neither → null).
  if (process.env.AGENT_GUARD_NO_KEYCHAIN) return null;
  if (platform() === "darwin") {
    try {
      const raw = execFileSync("security", ["find-generic-password", "-s", "Claude Code-credentials", "-w"], {
        encoding: "utf8",
        timeout: 4000,
        stdio: ["ignore", "pipe", "ignore"],
      });
      return tokenFrom(raw);
    } catch {
      /* not in keychain */
    }
  }
  return null;
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
      // AGENT_GUARD_USAGE_URL lets you point at a gateway (and lets tests use a local server).
      res = await fetch(process.env.AGENT_GUARD_USAGE_URL || USAGE_URL, {
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
  opts: { force?: boolean; throttleMs?: number; timeoutMs?: number; foreground?: boolean } = {},
): Promise<LimitSnapshot | null> {
  const throttle = opts.throttleMs ?? DEFAULT_THROTTLE_MS;
  const meta = loadUsageMeta();
  if (!opts.force && meta.lastFetchAt && now - meta.lastFetchAt < throttle && loadLimitsState().snapshot) {
    return null; // recent enough — use the cached snapshot
  }
  const token = readOAuthToken();
  if (!token) {
    saveUsageMeta({ lastFetchAt: now }); // don't re-attempt every call when there's no token
    return null;
  }
  // The token read succeeded — if this is a foreground command, the user has
  // (in their own terminal) consented to the Keychain access, so it's now safe
  // to let background refreshes run. This is the gate for G1.
  if (opts.foreground) saveUsageMeta({ authorized: true });

  const usage = await fetchUsage(token, opts.timeoutMs);
  saveUsageMeta({ lastFetchAt: now }); // throttle stamp — separate file, never touches the snapshot
  if (!usage) return null;

  const snapshot = usageToSnapshot(usage, now);
  saveLimitsState({ ...loadLimitsState(), subscriptionDetected: true, snapshot });
  return snapshot;
}

/**
 * Fire a throttled, NON-BLOCKING usage refresh in a detached child process, so
 * the caller (the hook on a tool call, or the statusLine on a render) never
 * blocks on the network. Staleness-gated with an optimistic `lastFetchAt` claim
 * so concurrent calls don't stampede the endpoint. Best-effort; never throws.
 *
 * `cliJsPath` is the absolute path to this package's compiled cli.js (the child
 * runs `<node> <cli.js> _refresh-usage`).
 */
export function triggerBackgroundRefresh(cliJsPath: string, now: number, throttleMs = DEFAULT_THROTTLE_MS): void {
  try {
    const meta = loadUsageMeta();
    // G1: never read the Keychain from a background process until a foreground
    // command (status/usage) has confirmed the user authorized that access —
    // otherwise we'd pop a surprise Keychain prompt mid-session.
    if (!meta.authorized) return;
    if (meta.lastFetchAt && now - meta.lastFetchAt < throttleMs) return; // recent enough

    // Claim the slot so concurrent renders/tool-calls skip the spawn…
    const prev = meta.lastFetchAt;
    saveUsageMeta({ lastFetchAt: now });
    try {
      const child = spawn(process.execPath, [cliJsPath, "_refresh-usage"], { detached: true, stdio: "ignore" });
      child.unref();
    } catch {
      // …but if the spawn itself failed, release the claim so we retry next time (G5).
      saveUsageMeta({ lastFetchAt: prev });
    }
  } catch {
    /* best-effort — a failed refresh just means slightly staler numbers */
  }
}
