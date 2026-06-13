/**
 * Subscription rate-limit awareness — the "how much of my Claude Code plan have
 * I burned" half of the guard, complementary to the dollar ledger.
 *
 * Claude Code on a Pro/Max subscription is NOT billed per token — the scarce
 * resource is the plan's rate-limit quota, measured in two rolling windows:
 *   - a 5-hour window (burst protection), and
 *   - a 7-day window (the real lockout risk, "resets a couple times a month").
 *
 * Anthropic reports exactly where you stand in both windows on every API
 * response, via `anthropic-ratelimit-unified-*` headers. The proxy already sees
 * every response, so it can read these and know the *real* remaining quota and
 * the *real* reset times — no estimation, no guessing when limits reset.
 *
 * This module owns: parsing those headers into a {@link LimitSnapshot}, and the
 * small global state file (`limits.json`) that persists the latest snapshot plus
 * whether we've ever seen subscription headers (so the rest of the guard can
 * switch into alert-only subscription mode).
 *
 * Header formats are owned by Anthropic, not us, and aren't fully contract-
 * documented, so parsing is deliberately defensive: utilization is accepted as
 * either a 0–1 fraction or a 0–100 percent; reset is accepted as an ISO 8601
 * timestamp, an epoch (s or ms), or a relative seconds-until-reset.
 */

import { readFileSync, writeFileSync, renameSync, appendFileSync } from "node:fs";
import { limitsPath, eventsPath, ensureGuardDir } from "./config.js";

export type LimitWindow = "5h" | "weekly";

/** State of one rolling rate-limit window. */
export interface WindowState {
  /** Fraction of the window consumed, 0–1. */
  utilization: number;
  /** Epoch ms when this window resets, or null if the header didn't say. */
  resetAt: number | null;
  /** Raw per-window status string from Anthropic (e.g. "allowed" / "warning"), if any. */
  status?: string;
}

/** A point-in-time read of the account's subscription rate-limit standing. */
export interface LimitSnapshot {
  fiveHour: WindowState | null;
  weekly: WindowState | null;
  /** Raw overall `anthropic-ratelimit-unified-status`, if present. */
  status: string | null;
  /** Epoch ms when this snapshot was observed. */
  observedAt: number;
}

/** Persisted global state (account-wide, not per-session). */
export interface LimitsState {
  version: 1;
  /** True once we've ever observed unified subscription headers. Latches on. */
  subscriptionDetected: boolean;
  snapshot: LimitSnapshot | null;
  /** Dedup flags so a given window/level/reset only alerts once. */
  notified: Record<string, boolean>;
  /** Epoch ms we first logged the raw unified-* headers (write-once diagnostic). */
  headersLoggedAt?: number;
}

/** Nominal window durations, used for pacing math when a reset time is unknown. */
export const WINDOW_MS: Record<LimitWindow, number> = {
  "5h": 5 * 60 * 60 * 1000,
  weekly: 7 * 24 * 60 * 60 * 1000,
};

export function emptyLimitsState(): LimitsState {
  return { version: 1, subscriptionDetected: false, snapshot: null, notified: {} };
}

export function loadLimitsState(): LimitsState {
  try {
    const data = JSON.parse(readFileSync(limitsPath(), "utf8")) as Partial<LimitsState>;
    if (data && data.version === 1) {
      return {
        version: 1,
        subscriptionDetected: data.subscriptionDetected ?? false,
        snapshot: data.snapshot ?? null,
        notified: data.notified ?? {},
        headersLoggedAt: data.headersLoggedAt,
      };
    }
  } catch {
    /* fall through to empty */
  }
  return emptyLimitsState();
}

export function saveLimitsState(state: LimitsState): void {
  ensureGuardDir();
  const path = limitsPath();
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 2));
  renameSync(tmp, path);
}

/** A header bag that works for both a fetch `Headers` and a plain record. */
export interface HeaderGetter {
  get(name: string): string | null | undefined;
}

/** Wrap a plain `Record<string,string>` so it satisfies {@link HeaderGetter}. */
export function recordHeaders(rec: Record<string, string | string[] | undefined>): HeaderGetter {
  const lower: Record<string, string> = {};
  for (const [k, v] of Object.entries(rec)) {
    if (v === undefined) continue;
    lower[k.toLowerCase()] = Array.isArray(v) ? v.join(", ") : v;
  }
  return { get: (name) => lower[name.toLowerCase()] ?? null };
}

/**
 * Parse a utilization header value into a 0–1 fraction.
 * Accepts "0.62", "62", "62%". Values >1.5 are treated as percentages.
 */
export function parseUtilization(raw: string | null | undefined): number | null {
  if (raw == null) return null;
  const n = Number(String(raw).replace(/%$/, "").trim());
  if (!Number.isFinite(n) || n < 0) return null;
  const frac = n > 1.5 ? n / 100 : n;
  return Math.max(0, Math.min(1, frac));
}

/**
 * Parse a reset header value into an absolute epoch-ms timestamp.
 * Accepts ISO 8601 ("2026-06-13T18:00:00Z"), epoch seconds, epoch ms, or a
 * relative seconds-until-reset (small numbers). `now` anchors the relative case.
 */
export function parseReset(raw: string | null | undefined, now: number): number | null {
  if (raw == null) return null;
  const s = String(raw).trim();
  if (!s) return null;

  // Numeric: disambiguate ms / seconds / relative-seconds by magnitude.
  if (/^\d+(\.\d+)?$/.test(s)) {
    const n = Number(s);
    if (!Number.isFinite(n)) return null;
    if (n > 1e12) return Math.round(n); // epoch ms
    if (n > 1e9) return Math.round(n * 1000); // epoch seconds
    return Math.round(now + n * 1000); // relative seconds-until-reset
  }

  const t = Date.parse(s);
  return Number.isNaN(t) ? null : t;
}

function parseWindow(h: HeaderGetter, prefix: string, key: LimitWindow, now: number): WindowState | null {
  const util = parseUtilization(h.get(`${prefix}-${key === "5h" ? "5h" : "7d"}-utilization`));
  const reset = parseReset(h.get(`${prefix}-${key === "5h" ? "5h" : "7d"}-reset`), now);
  const status = h.get(`${prefix}-${key === "5h" ? "5h" : "7d"}-status`) || undefined;
  if (util == null && reset == null && !status) return null;
  return { utilization: util ?? 0, resetAt: reset, status };
}

/**
 * Read the `anthropic-ratelimit-unified-*` family into a {@link LimitSnapshot}.
 * Returns null when no unified headers are present (i.e. not a subscription
 * session, or an endpoint that doesn't emit them) — callers use that null to
 * mean "stay in dollar mode for this response".
 */
export function parseUnifiedHeaders(h: HeaderGetter, now: number): LimitSnapshot | null {
  const prefix = "anthropic-ratelimit-unified";
  const fiveHour = parseWindow(h, prefix, "5h", now);
  const weekly = parseWindow(h, prefix, "weekly", now);
  const status = h.get(`${prefix}-status`) || null;

  if (!fiveHour && !weekly && !status) return null;
  return { fiveHour, weekly, status, observedAt: now };
}

/** Stable dedup key for a pacing alert: re-alerts when the window resets. */
export function limitNotifyKey(window: LimitWindow, level: string, resetAt: number | null): string {
  return `${window}:${level}:${resetAt ?? 0}`;
}

/**
 * Pull every `anthropic-ratelimit-unified-*` header out of a raw record, verbatim.
 * Used for the write-once diagnostic — Anthropic's value *formats* (fraction vs.
 * percent, ISO vs. epoch reset) aren't fully documented, so capturing the raw
 * strings the first time we see them makes verification a single `cat` away.
 */
export function unifiedHeaderDump(rec: Record<string, string | string[] | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(rec)) {
    if (v == null) continue;
    const key = k.toLowerCase();
    if (key.startsWith("anthropic-ratelimit-unified")) out[key] = Array.isArray(v) ? v.join(", ") : v;
  }
  return out;
}

/** Append a one-time raw-header diagnostic to events.jsonl. Best-effort, never throws. */
export function logUnifiedHeaders(dump: Record<string, string>, now: number): void {
  try {
    ensureGuardDir();
    appendFileSync(
      eventsPath(),
      JSON.stringify({ ts: now, kind: "unified-headers-observed", headers: dump }) + "\n",
    );
  } catch {
    /* diagnostic only */
  }
}
