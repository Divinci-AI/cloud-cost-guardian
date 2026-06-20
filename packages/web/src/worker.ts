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
// The ENFORCED CSP stays permissive about https: sources because Clerk injects
// scripts, iframes, and workers at runtime, and a wrong per-host allowlist would
// re-lock the dashboard (see the 2026-06-20 Access-gate lockout). To tighten it
// safely we ship the per-host allowlist as Content-Security-Policy-Report-Only
// FIRST: it blocks nothing, only reports what it *would* block. Watch the browser
// console through a real Clerk sign-in (+ Stripe checkout); once the report-only
// policy is violation-free, promote it into 'Content-Security-Policy' and drop
// the permissive one. Hosts below: Clerk FAPI (clerk.kill-switch.net, from the
// pk_live key) + clerk.accounts.dev, Turnstile (challenges.cloudflare.com),
// Stripe, Google Fonts, and the API.
const CSP_REPORT_ONLY = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://clerk.kill-switch.net https://*.clerk.accounts.dev https://challenges.cloudflare.com https://js.stripe.com",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' data: https://fonts.gstatic.com",
  "img-src 'self' data: blob: https://img.clerk.com https://*.clerk.accounts.dev https://*.kill-switch.net",
  "connect-src 'self' https://clerk.kill-switch.net https://*.clerk.accounts.dev https://api.kill-switch.net https://*.kill-switch.net https://*.stripe.com",
  "frame-src 'self' https://challenges.cloudflare.com https://js.stripe.com https://hooks.stripe.com https://*.clerk.accounts.dev",
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'self'",
  "frame-ancestors 'none'",
].join('; ');

const SECURITY_HEADERS: Record<string, string> = {
  'Content-Security-Policy':
    "default-src 'self' https: data: blob: 'unsafe-inline' 'unsafe-eval'; object-src 'none'; frame-ancestors 'none'; base-uri 'self'",
  'Content-Security-Policy-Report-Only': CSP_REPORT_ONLY,
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
