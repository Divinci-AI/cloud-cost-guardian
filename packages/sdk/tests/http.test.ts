import { describe, it, expect, vi } from "vitest";
import { HttpClient } from "../src/http.js";
import {
  ApiError,
  AuthenticationError,
  ForbiddenError,
  NotFoundError,
  RateLimitError,
  TimeoutError,
  NetworkError,
} from "../src/errors.js";

function mockFetch(response: {
  status?: number;
  body?: unknown;
  headers?: Record<string, string>;
}) {
  const status = response.status ?? 200;
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(response.headers ?? {}),
    text: () => Promise.resolve(JSON.stringify(response.body ?? {})),
  });
}

function createClient(fetchFn: any, options?: Partial<ConstructorParameters<typeof HttpClient>[0]>) {
  return new HttpClient({
    baseUrl: "https://api.test.com",
    apiKey: "ks_test_123",
    fetch: fetchFn,
    maxRetries: 0,
    ...options,
  });
}

describe("HttpClient", () => {
  it("sends GET requests with auth header", async () => {
    const fetch = mockFetch({ body: { ok: true } });
    const client = createClient(fetch);

    const result = await client.get<{ ok: boolean }>("/test");

    expect(result).toEqual({ ok: true });
    expect(fetch).toHaveBeenCalledWith(
      "https://api.test.com/test",
      expect.objectContaining({
        method: "GET",
        headers: expect.objectContaining({
          Authorization: "Bearer ks_test_123",
          "Content-Type": "application/json",
        }),
      }),
    );
  });

  it("sends POST requests with body", async () => {
    const fetch = mockFetch({ status: 201, body: { id: "abc" } });
    const client = createClient(fetch);

    const result = await client.post<{ id: string }>("/items", { name: "test" });

    expect(result).toEqual({ id: "abc" });
    expect(fetch).toHaveBeenCalledWith(
      "https://api.test.com/items",
      expect.objectContaining({
        method: "POST",
        body: '{"name":"test"}',
      }),
    );
  });

  it("sends X-Org-Id header when orgId is set", async () => {
    const fetch = mockFetch({ body: {} });
    const client = createClient(fetch, { orgId: "org_123" });

    await client.get("/test");

    expect(fetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        headers: expect.objectContaining({ "X-Org-Id": "org_123" }),
      }),
    );
  });

  it("throws AuthenticationError on 401", async () => {
    const fetch = mockFetch({ status: 401, body: { error: "Invalid key" } });
    const client = createClient(fetch);

    await expect(client.get("/test")).rejects.toThrow(AuthenticationError);
  });

  it("throws ForbiddenError on 403", async () => {
    const fetch = mockFetch({
      status: 403,
      body: { error: "Upgrade required", currentTier: "free", upgradeUrl: "/billing" },
    });
    const client = createClient(fetch);

    try {
      await client.get("/test");
      expect.fail("should throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ForbiddenError);
      const apiErr = err as ForbiddenError;
      expect(apiErr.tierInfo?.currentTier).toBe("free");
      expect(apiErr.tierInfo?.upgradeUrl).toBe("/billing");
    }
  });

  it("throws NotFoundError on 404", async () => {
    const fetch = mockFetch({ status: 404, body: { error: "Not found" } });
    const client = createClient(fetch);

    await expect(client.get("/test")).rejects.toThrow(NotFoundError);
  });

  it("throws RateLimitError on 429", async () => {
    const fetch = mockFetch({
      status: 429,
      body: { error: "Too many requests" },
      headers: { "Retry-After": "5" },
    });
    const client = createClient(fetch);

    try {
      await client.get("/test");
      expect.fail("should throw");
    } catch (err) {
      expect(err).toBeInstanceOf(RateLimitError);
      expect((err as RateLimitError).retryAfter).toBe(5);
    }
  });

  it("throws ApiError on other 4xx", async () => {
    const fetch = mockFetch({ status: 400, body: { error: "Bad request" } });
    const client = createClient(fetch);

    try {
      await client.get("/test");
      expect.fail("should throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError);
      expect((err as ApiError).status).toBe(400);
    }
  });

  it("retries on 5xx errors", async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 500,
        headers: new Headers(),
        text: () => Promise.resolve('{"error":"Internal"}'),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: new Headers(),
        text: () => Promise.resolve('{"ok":true}'),
      });

    const client = createClient(fetch, { maxRetries: 1 });
    const result = await client.get<{ ok: boolean }>("/test");

    expect(result).toEqual({ ok: true });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("retries on 429 with Retry-After", async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 429,
        headers: new Headers({ "Retry-After": "0" }),
        text: () => Promise.resolve('{"error":"Rate limited"}'),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: new Headers(),
        text: () => Promise.resolve('{"ok":true}'),
      });

    const client = createClient(fetch, { maxRetries: 1 });
    const result = await client.get<{ ok: boolean }>("/test");

    expect(result).toEqual({ ok: true });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("calls event hooks", async () => {
    const beforeRequest = vi.fn();
    const afterResponse = vi.fn();
    const fetch = mockFetch({ body: { ok: true } });

    const client = createClient(fetch, {
      hooks: { beforeRequest, afterResponse },
    });

    await client.get("/test");

    expect(beforeRequest).toHaveBeenCalledWith(
      expect.objectContaining({ method: "GET", url: "https://api.test.com/test" }),
    );
    expect(afterResponse).toHaveBeenCalledWith(
      expect.objectContaining({ status: 200 }),
    );
  });

  it("calls onError hook on failure", async () => {
    const onError = vi.fn();
    const fetch = mockFetch({ status: 400, body: { error: "Bad" } });

    const client = createClient(fetch, { hooks: { onError } });

    await expect(client.get("/test")).rejects.toThrow();
    expect(onError).toHaveBeenCalled();
  });

  it("supports setApiKey at runtime", async () => {
    const fetch = mockFetch({ body: {} });
    const client = createClient(fetch, { apiKey: undefined });

    client.setApiKey("ks_new_key");
    await client.get("/test");

    expect(fetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: "Bearer ks_new_key" }),
      }),
    );
  });
});
