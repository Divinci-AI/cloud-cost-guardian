/**
 * Kill Switch SDK Error Hierarchy
 */

export class KillSwitchError extends Error {
  constructor(
    message: string,
    public readonly code: string,
  ) {
    super(message);
    this.name = "KillSwitchError";
  }
}

export class ApiError extends KillSwitchError {
  constructor(
    public readonly status: number,
    public readonly body: unknown,
    message: string,
  ) {
    super(message, "API_ERROR");
    this.name = "ApiError";
  }

  /** Tier upgrade info if the error is a tier limit (403) */
  get tierInfo(): { currentTier?: string; limit?: number; upgradeUrl?: string } | undefined {
    if (this.status === 403 && typeof this.body === "object" && this.body !== null) {
      const b = this.body as Record<string, unknown>;
      if (b.currentTier || b.upgradeUrl) {
        return {
          currentTier: b.currentTier as string | undefined,
          limit: b.limit as number | undefined,
          upgradeUrl: b.upgradeUrl as string | undefined,
        };
      }
    }
    return undefined;
  }
}

export class AuthenticationError extends ApiError {
  constructor(body: unknown) {
    super(401, body, "Authentication failed. Check your API key.");
    this.name = "AuthenticationError";
    (this as { code: string }).code = "AUTHENTICATION_ERROR";
  }
}

export class ForbiddenError extends ApiError {
  constructor(body: unknown, message?: string) {
    super(403, body, message || "Insufficient permissions.");
    this.name = "ForbiddenError";
    (this as { code: string }).code = "FORBIDDEN";
  }
}

export class NotFoundError extends ApiError {
  constructor(body: unknown, message?: string) {
    super(404, body, message || "Resource not found.");
    this.name = "NotFoundError";
    (this as { code: string }).code = "NOT_FOUND";
  }
}

export class RateLimitError extends ApiError {
  constructor(
    public readonly retryAfter: number,
    body: unknown,
  ) {
    super(429, body, `Rate limited. Retry after ${retryAfter}s.`);
    this.name = "RateLimitError";
    (this as { code: string }).code = "RATE_LIMITED";
  }
}

export class TimeoutError extends KillSwitchError {
  constructor(public readonly timeoutMs: number) {
    super(`Request timed out after ${timeoutMs}ms.`, "TIMEOUT");
    this.name = "TimeoutError";
  }
}

export class NetworkError extends KillSwitchError {
  constructor(
    public readonly cause: Error,
    baseUrl: string,
  ) {
    super(`Could not reach API at ${baseUrl}. Check your connection.`, "NETWORK_ERROR");
    this.name = "NetworkError";
  }
}
