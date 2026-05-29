/**
 * Spend ledger — the single source of truth for "how much has been spent".
 *
 * Stored at ~/.kill-switch/agent-guard/ledger.json. Written atomically
 * (tmp file + rename) because the hook and the proxy can both touch it.
 *
 * Daily-rolling cost is *derived*, not separately accumulated: it's the sum of
 * every session whose last activity falls within the trailing 24h window. This
 * makes double-counting impossible — the hook recomputes a session's total from
 * the transcript (authoritative) while the proxy increments deltas, and neither
 * can inflate the daily figure.
 */

import { readFileSync, writeFileSync, renameSync } from "node:fs";
import { ledgerPath, ensureGuardDir } from "./config.js";

export interface SessionRecord {
  startedAt: number;
  lastAt: number;
  costUSD: number;
  inputTokens: number;
  outputTokens: number;
  /** Dedup flags so soft-cap warnings fire once per scope, not every tool call. */
  notified: Record<string, boolean>;
}

export interface Ledger {
  version: 1;
  sessions: Record<string, SessionRecord>;
}

const DAY_MS = 24 * 60 * 60 * 1000;

export function emptyLedger(): Ledger {
  return { version: 1, sessions: {} };
}

export function loadLedger(): Ledger {
  try {
    const data = JSON.parse(readFileSync(ledgerPath(), "utf8")) as Ledger;
    if (data && data.version === 1 && data.sessions) return data;
  } catch {
    /* fall through to empty */
  }
  return emptyLedger();
}

export function saveLedger(ledger: Ledger): void {
  ensureGuardDir();
  const path = ledgerPath();
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(ledger, null, 2));
  renameSync(tmp, path);
}

function ensureSession(ledger: Ledger, id: string, now: number): SessionRecord {
  let s = ledger.sessions[id];
  if (!s) {
    s = { startedAt: now, lastAt: now, costUSD: 0, inputTokens: 0, outputTokens: 0, notified: {} };
    ledger.sessions[id] = s;
  }
  return s;
}

/** Authoritative set — used by the hook after recomputing from the transcript. */
export function setSessionCost(
  ledger: Ledger,
  id: string,
  costUSD: number,
  inputTokens: number,
  outputTokens: number,
  now: number,
): SessionRecord {
  const s = ensureSession(ledger, id, now);
  s.costUSD = costUSD;
  s.inputTokens = inputTokens;
  s.outputTokens = outputTokens;
  s.lastAt = now;
  return s;
}

/** Incremental add — used by the proxy, which sees per-response deltas. */
export function addSessionCost(
  ledger: Ledger,
  id: string,
  deltaUSD: number,
  inputTokens: number,
  outputTokens: number,
  now: number,
): SessionRecord {
  const s = ensureSession(ledger, id, now);
  s.costUSD += deltaUSD;
  s.inputTokens += inputTokens;
  s.outputTokens += outputTokens;
  s.lastAt = now;
  return s;
}

/** Sum of all sessions active within the trailing 24h window. */
export function rollingDailyCost(ledger: Ledger, now: number): number {
  let total = 0;
  for (const s of Object.values(ledger.sessions)) {
    if (now - s.lastAt < DAY_MS) total += s.costUSD;
  }
  return total;
}

/** Drop sessions untouched for `days` to keep the ledger small. */
export function prune(ledger: Ledger, now: number, days = 14): void {
  const cutoff = now - days * DAY_MS;
  for (const [id, s] of Object.entries(ledger.sessions)) {
    if (s.lastAt < cutoff) delete ledger.sessions[id];
  }
}
