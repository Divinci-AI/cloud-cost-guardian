/**
 * Kill Switch API Proxy
 *
 * Lightweight CF Worker that proxies api.kill-switch.net to Cloud Run.
 * Rewrites the Host header so Cloud Run recognizes the request.
 * Injects the x-origin-secret header for origin verification.
 *
 * Why: CF Free plan doesn't support Origin Rules (Host header rewrite).
 * This worker is the free-tier alternative.
 */

interface Env {
  CF_ORIGIN_SECRET: { get(): Promise<string> };
}

const CLOUD_RUN_HOST = "guardian-api-150038457816.us-central1.run.app";
const CLOUD_RUN_ORIGIN = `https://${CLOUD_RUN_HOST}`;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const targetUrl = `${CLOUD_RUN_ORIGIN}${url.pathname}${url.search}`;

    const headers = new Headers(request.headers);
    headers.set("Host", CLOUD_RUN_HOST);

    if (env.CF_ORIGIN_SECRET) {
      const secret = await env.CF_ORIGIN_SECRET.get();
      if (secret) headers.set("x-origin-secret", secret);
    }

    const response = await fetch(targetUrl, {
      method: request.method,
      headers,
      body: request.method !== "GET" && request.method !== "HEAD"
        ? request.body
        : undefined,
      redirect: "follow",
    });

    const respHeaders = new Headers(response.headers);
    const origin = request.headers.get("Origin");
    const allowedOrigins = [
      "https://kill-switch.net",
      "https://www.kill-switch.net",
      "https://app.kill-switch.net",
      "http://localhost:3000",
      "http://localhost:5173",
    ];
    if (origin && allowedOrigins.includes(origin)) {
      respHeaders.set("Access-Control-Allow-Origin", origin);
      respHeaders.set("Access-Control-Allow-Credentials", "true");
    }

    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: respHeaders,
    });
  },
};
