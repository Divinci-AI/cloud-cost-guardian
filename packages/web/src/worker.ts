// Static asset server for the kill-switch SPA.
//
// app.kill-switch.net is a public product surface: authentication is handled
// inside the app by Clerk (and by the API via Clerk JWT / ks_ API keys), so the
// Worker does NOT gate requests. (It previously redirected every request to a
// Cloudflare Access app in the divinci-ai Zero Trust org; that app was removed,
// which hard-locked the entire dashboard — including the CLI /cli-auth page.)

interface Env {
  ASSETS: { fetch: (req: Request) => Promise<Response> };
}

// Defense-in-depth headers on every asset response. The CSP is intentionally
// permissive about https: sources (Clerk injects scripts, iframes, and
// workers at runtime) — tightening to a per-host allowlist must be verified
// against a real sign-in flow first.
const SECURITY_HEADERS: Record<string, string> = {
  'Content-Security-Policy':
    "default-src 'self' https: data: blob: 'unsafe-inline' 'unsafe-eval'; object-src 'none'; frame-ancestors 'none'; base-uri 'self'",
  'X-Frame-Options': 'DENY',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'accelerometer=(), camera=(), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), payment=(), usb=()',
  'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
};

function withSecurityHeaders(response: Response): Response {
  const wrapped = new Response(response.body, response);
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
    wrapped.headers.set(name, value);
  }
  return wrapped;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    return withSecurityHeaders(await env.ASSETS.fetch(request));
  },
};
