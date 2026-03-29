/**
 * Common SDK types
 */

import type { EventHooks } from "../hooks.js";

export type ProviderId = "cloudflare" | "gcp" | "aws" | "runpod" | "redis" | "mongodb";
export type GuardianTier = "free" | "pro" | "team" | "enterprise";
export type TeamRole = "owner" | "admin" | "member" | "viewer";

export interface ClientOptions {
  /** API key (ks_live_... or ks_test_...) */
  apiKey?: string;
  /** JWT token (Clerk) — alternative to apiKey */
  jwtToken?: string;
  /** Organization ID to scope requests */
  orgId?: string;
  /** API base URL (default: https://api.kill-switch.net) */
  baseUrl?: string;
  /** Request timeout in ms (default: 30000) */
  timeout?: number;
  /** Max retry attempts for 5xx/429/network errors (default: 2) */
  maxRetries?: number;
  /** Custom fetch implementation (for testing or edge runtimes) */
  fetch?: typeof globalThis.fetch;
  /** Event hooks for logging/debugging */
  hooks?: EventHooks;
}

export interface PaginatedResponse<T> {
  entries: T[];
  page: number;
  total: number;
  limit: number;
}

export interface PaginationOptions {
  page?: number;
  limit?: number;
}
