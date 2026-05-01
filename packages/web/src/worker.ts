// Cloudflare Access gate for the kill-switch SPA.
// CF Access doesn't inject headers for Workers serving static assets,
// so we validate the CF_Authorization cookie that Access sets post-login.

const TEAM_DOMAIN = 'https://divinci-ai.cloudflareaccess.com';
const ACCESS_AUD = 'acd99393ecd60f20eb4ab76fd9ed4655f6381876b69da2cd8522f92d1dad23fc';
const APP_DOMAIN = 'app.kill-switch.net';

interface Env {
  ASSETS: { fetch: (req: Request) => Promise<Response> };
}

function getCookie(request: Request, name: string): string | null {
  const header = request.headers.get('Cookie') ?? '';
  for (const pair of header.split(';')) {
    const [k, ...rest] = pair.trim().split('=');
    if (k.trim() === name) return rest.join('=').trim();
  }
  return null;
}

function b64UrlDecode(str: string): Uint8Array {
  str = str.replace(/-/g, '+').replace(/_/g, '/');
  while (str.length % 4) str += '=';
  return Uint8Array.from(atob(str), (c) => c.charCodeAt(0));
}

// Isolate-scoped key cache (survives across requests in the same V8 isolate)
let keyCache: Map<string, CryptoKey> | null = null;
let keyCacheExpiry = 0;

async function getPublicKeys(): Promise<Map<string, CryptoKey>> {
  const now = Date.now();
  if (keyCache && now < keyCacheExpiry) return keyCache;

  const resp = await fetch(`${TEAM_DOMAIN}/cdn-cgi/access/certs`);
  const { keys } = (await resp.json()) as { keys: (JsonWebKey & { kid: string })[] };

  const map = new Map<string, CryptoKey>();
  for (const jwk of keys) {
    const key = await crypto.subtle.importKey(
      'jwk',
      jwk,
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      false,
      ['verify'],
    );
    map.set(jwk.kid, key);
  }

  keyCache = map;
  keyCacheExpiry = now + 60 * 60 * 1000; // 1-hour TTL
  return map;
}

async function isValidJwt(token: string): Promise<boolean> {
  const parts = token.split('.');
  if (parts.length !== 3) return false;

  try {
    const header = JSON.parse(atob(parts[0].replace(/-/g, '+').replace(/_/g, '/'))) as {
      kid: string;
    };
    const payload = JSON.parse(atob(parts[1].replace(/-/g, '+').replace(/_/g, '/'))) as {
      aud: string | string[];
      exp: number;
    };

    if (payload.exp < Math.floor(Date.now() / 1000)) return false;

    const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
    if (!aud.includes(ACCESS_AUD)) return false;

    const keys = await getPublicKeys();
    const key = keys.get(header.kid);
    if (!key) return false;

    const data = new TextEncoder().encode(`${parts[0]}.${parts[1]}`);
    const sig = b64UrlDecode(parts[2]).buffer as ArrayBuffer;
    return await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, sig, data);
  } catch {
    return false;
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // Let CF Access callback flow through unblocked
    if (url.pathname.startsWith('/cdn-cgi/')) {
      return env.ASSETS.fetch(request);
    }

    // CF Access injects this header when enforcing at edge level
    const jwt =
      request.headers.get('CF-Access-Jwt-Assertion') ??
      getCookie(request, 'CF_Authorization');

    if (!jwt) {
      const loginUrl = `${TEAM_DOMAIN}/cdn-cgi/access/login/${APP_DOMAIN}?redirect_url=${encodeURIComponent(request.url)}`;
      return Response.redirect(loginUrl, 302);
    }

    if (!(await isValidJwt(jwt))) {
      // Clear stale cookie and redirect to re-auth
      const loginUrl = `${TEAM_DOMAIN}/cdn-cgi/access/login/${APP_DOMAIN}?redirect_url=${encodeURIComponent(request.url)}`;
      return new Response(null, {
        status: 302,
        headers: {
          Location: loginUrl,
          'Set-Cookie': `CF_Authorization=; Path=/; Max-Age=0`,
        },
      });
    }

    return env.ASSETS.fetch(request);
  },
};
