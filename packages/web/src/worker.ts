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

// Defense-in-depth headers on every asset response.
//
// ENFORCED per-host CSP. Replaces the old `default-src 'self' https:` wildcard
// (which let ANY https origin inject scripts) with an allowlist of exactly what
// the app loads. Verified 2026-06-20 via browser automation across the welcome,
// settings, dashboard, and billing views: the only origins loaded are self,
// api/clerk.kill-switch.net, img.clerk.com, and static.cloudflareinsights.com —
// all covered below, with zero securitypolicyviolation events. clerk.accounts.dev
// / Turnstile / Stripe are included defensively for the logged-out sign-in +
// checkout flows. `unsafe-inline`/`unsafe-eval` are kept — Clerk + the bundler
// need them; removing those is a separate, report-only-first step.
// Rollback: restore the previous `default-src 'self' https: data: blob:
// 'unsafe-inline' 'unsafe-eval'` line and redeploy.
const CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://clerk.kill-switch.net https://*.clerk.accounts.dev https://challenges.cloudflare.com https://js.stripe.com https://static.cloudflareinsights.com",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' data: https://fonts.gstatic.com",
  "img-src 'self' data: blob: https://img.clerk.com https://*.clerk.accounts.dev https://*.kill-switch.net",
  "connect-src 'self' https://clerk.kill-switch.net https://*.clerk.accounts.dev https://api.kill-switch.net https://*.kill-switch.net https://*.stripe.com https://static.cloudflareinsights.com",
  "frame-src 'self' https://challenges.cloudflare.com https://js.stripe.com https://hooks.stripe.com https://*.clerk.accounts.dev",
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'self'",
  "frame-ancestors 'none'",
].join('; ');

const SECURITY_HEADERS: Record<string, string> = {
  'Content-Security-Policy': CSP,
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
    const res = withSecurityHeaders(await env.ASSETS.fetch(request));
    // The SPA's HTML entry must not be edge/browser-cached, or a stale cache
    // masks deploys — including security-header changes like CSP (which is
    // exactly what happened promoting the tightened policy). Content-hashed
    // JS/CSS assets keep their own immutable caching.
    if ((res.headers.get('content-type') || '').includes('text/html')) {
      res.headers.set('Cache-Control', 'no-cache, must-revalidate');
    }
    return res;
  },
};
