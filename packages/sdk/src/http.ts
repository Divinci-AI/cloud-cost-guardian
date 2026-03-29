/**
 * HTTP Transport Layer
 *
 * Wraps fetch with auth, retry, rate-limit handling, and timeout.
 * Zero runtime dependencies — uses standard Web APIs.
 */

import {
  ApiError,
  AuthenticationError,
  ForbiddenError,
  NetworkError,
  NotFoundError,
  RateLimitError,
  TimeoutError,
} from "./errors.js";
import type { EventHooks, RequestInfo, ResponseInfo } from "./hooks.js";

export interface HttpClientOptions {
  baseUrl: string;
  apiKey?: string;
  jwtToken?: string;
  orgId?: string;
  timeout?: number;
  maxRetries?: number;
  fetch?: typeof globalThis.fetch;
  hooks?: EventHooks;
}

export class HttpClient {
  private readonly baseUrl: string;
  private readonly timeout: number;
  private readonly maxRetries: number;
  private readonly fetchFn: typeof globalThis.fetch;
  private readonly hooks?: EventHooks;
  private apiKey?: string;
  private jwtToken?: string;
  private orgId?: string;

  constructor(options: HttpClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, "");
    this.apiKey = options.apiKey;
    this.jwtToken = options.jwtToken;
    this.orgId = options.orgId;
    this.timeout = options.timeout ?? 30_000;
    this.maxRetries = options.maxRetries ?? 2;
    this.fetchFn = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.hooks = options.hooks;
  }

  /** Update the API key at runtime (e.g., after auth flow) */
  setApiKey(key: string): void {
    this.apiKey = key;
  }

  /** Update the JWT token at runtime */
  setJwtToken(token: string): void {
    this.jwtToken = token;
  }

  /** Update the org context */
  setOrgId(orgId: string): void {
    this.orgId = orgId;
  }

  async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };

    if (this.apiKey) {
      headers["Authorization"] = `Bearer ${this.apiKey}`;
    } else if (this.jwtToken) {
      headers["Authorization"] = `Bearer ${this.jwtToken}`;
    }

    if (this.orgId) {
      headers["X-Org-Id"] = this.orgId;
    }

    const reqInfo: RequestInfo = { method, url, headers, body };

    let lastError: Error | undefined;

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      if (attempt > 0 && lastError) {
        await this.hooks?.onRetry?.(attempt, lastError as any);
        await sleep(backoffMs(attempt));
      }

      try {
        await this.hooks?.beforeRequest?.(reqInfo);
        const start = Date.now();

        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), this.timeout);

        let res: Response;
        try {
          res = await this.fetchFn(url, {
            method,
            headers,
            body: body !== undefined ? JSON.stringify(body) : undefined,
            signal: controller.signal,
          });
        } catch (err: any) {
          clearTimeout(timer);
          if (err.name === "AbortError") {
            throw new TimeoutError(this.timeout);
          }
          throw new NetworkError(err, this.baseUrl);
        } finally {
          clearTimeout(timer);
        }

        const durationMs = Date.now() - start;
        const text = await res.text();
        let data: unknown;
        try {
          data = JSON.parse(text);
        } catch {
          data = text;
        }

        const resInfo: ResponseInfo = {
          status: res.status,
          headers: res.headers,
          body: data,
          durationMs,
        };

        if (res.ok) {
          await this.hooks?.afterResponse?.(resInfo);
          return data as T;
        }

        // Rate limited — retry if we have attempts left
        if (res.status === 429) {
          const retryAfter = parseRetryAfter(res.headers.get("Retry-After"));
          const err = new RateLimitError(retryAfter, data);
          if (attempt < this.maxRetries) {
            lastError = err;
            await sleep(retryAfter * 1000);
            continue;
          }
          await this.hooks?.onError?.(err);
          throw err;
        }

        // Server errors — retry
        if (res.status >= 500 && attempt < this.maxRetries) {
          lastError = new ApiError(res.status, data, errorMessage(data, res.status));
          continue;
        }

        // Client errors — don't retry
        const error = mapClientError(res.status, data);
        await this.hooks?.onError?.(error);
        throw error;
      } catch (err) {
        if (err instanceof TimeoutError || err instanceof NetworkError) {
          if (attempt < this.maxRetries) {
            lastError = err;
            continue;
          }
          await this.hooks?.onError?.(err as any);
          throw err;
        }
        // Re-throw mapped errors
        throw err;
      }
    }

    // Should not reach here, but just in case
    throw lastError || new Error("Request failed");
  }

  /** Convenience methods */
  get<T>(path: string): Promise<T> {
    return this.request<T>("GET", path);
  }

  post<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>("POST", path, body);
  }

  put<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>("PUT", path, body);
  }

  patch<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>("PATCH", path, body);
  }

  delete<T>(path: string): Promise<T> {
    return this.request<T>("DELETE", path);
  }
}

function mapClientError(status: number, body: unknown): ApiError {
  const msg = errorMessage(body, status);
  switch (status) {
    case 401:
      return new AuthenticationError(body);
    case 403:
      return new ForbiddenError(body, msg);
    case 404:
      return new NotFoundError(body, msg);
    default:
      return new ApiError(status, body, msg);
  }
}

function errorMessage(body: unknown, status: number): string {
  if (typeof body === "object" && body !== null && "error" in body) {
    return (body as { error: string }).error;
  }
  return `API error: ${status}`;
}

function parseRetryAfter(header: string | null): number {
  if (!header) return 1;
  const seconds = Number(header);
  return Number.isFinite(seconds) ? seconds : 1;
}

function backoffMs(attempt: number): number {
  return Math.min(1000 * 2 ** (attempt - 1), 10_000);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
