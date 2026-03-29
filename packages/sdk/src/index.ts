/**
 * @kill-switch/sdk — Kill Switch SDK
 *
 * Zero-dependency TypeScript client for the Kill Switch API.
 *
 * @example
 * ```ts
 * import { KillSwitchClient } from "@kill-switch/sdk";
 *
 * const client = new KillSwitchClient({ apiKey: "ks_live_..." });
 * const accounts = await client.accounts.list();
 * ```
 */

// Main client
export { KillSwitchClient } from "./client.js";

// Errors
export {
  KillSwitchError,
  ApiError,
  AuthenticationError,
  ForbiddenError,
  NotFoundError,
  RateLimitError,
  TimeoutError,
  NetworkError,
} from "./errors.js";

// Hooks
export type { RequestInfo, ResponseInfo, EventHooks } from "./hooks.js";

// All types
export type * from "./types/index.js";
