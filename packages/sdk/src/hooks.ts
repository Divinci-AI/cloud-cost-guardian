/**
 * SDK Event Hooks — intercept requests for logging, debugging, and observability
 */

import type { KillSwitchError } from "./errors.js";

export interface RequestInfo {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: unknown;
}

export interface ResponseInfo {
  status: number;
  headers: Headers;
  body: unknown;
  durationMs: number;
}

export interface EventHooks {
  /** Called before each HTTP request */
  beforeRequest?: (req: RequestInfo) => void | Promise<void>;
  /** Called after each successful response */
  afterResponse?: (res: ResponseInfo) => void | Promise<void>;
  /** Called on any error */
  onError?: (err: KillSwitchError) => void | Promise<void>;
  /** Called before a retry attempt */
  onRetry?: (attempt: number, err: KillSwitchError) => void | Promise<void>;
}
