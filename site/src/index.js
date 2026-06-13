/**
 * cloud-switch-site Worker.
 *
 * Serves the static marketing site (via the ASSETS binding) and adds one
 * dynamic endpoint: POST /api/subscribe, which proxies a newsletter signup to
 * Beehiiv server-side so the API key is never exposed to the browser.
 *
 * Required secrets (set with `wrangler secret put …`, see site/README-newsletter.md):
 *   BEEHIIV_API_KEY          — Beehiiv API v2 key
 *   BEEHIIV_PUBLICATION_ID   — e.g. "pub_xxxxxxxx"
 * Until both are set, /api/subscribe returns {ok:false, error:"not_configured"}.
 */

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

async function handleSubscribe(request, env) {
  let email = "";
  let trap = "";
  try {
    const body = await request.json();
    email = (body.email || "").trim().toLowerCase();
    trap = (body.company || "").trim(); // honeypot: real users never fill this
  } catch {
    return json({ ok: false, error: "bad_request" }, 400);
  }

  // Honeypot tripped → pretend success, drop silently.
  if (trap) return json({ ok: true });

  if (!EMAIL_RE.test(email) || email.length > 254) {
    return json({ ok: false, error: "invalid_email" }, 400);
  }

  if (!env.BEEHIIV_API_KEY || !env.BEEHIIV_PUBLICATION_ID) {
    return json({ ok: false, error: "not_configured" }, 503);
  }

  let res;
  try {
    res = await fetch(
      `https://api.beehiiv.com/v2/publications/${env.BEEHIIV_PUBLICATION_ID}/subscriptions`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${env.BEEHIIV_API_KEY}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          email,
          reactivate_existing: true,
          send_welcome_email: true,
          utm_source: "kill-switch.net",
          referring_site: "kill-switch.net",
        }),
      }
    );
  } catch {
    return json({ ok: false, error: "provider_unreachable" }, 502);
  }

  if (!res.ok) {
    return json({ ok: false, error: "provider_error", status: res.status }, 502);
  }

  return json({ ok: true });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/api/subscribe") {
      if (request.method !== "POST") {
        return json({ ok: false, error: "method_not_allowed" }, 405);
      }
      return handleSubscribe(request, env);
    }

    // Everything else → static assets.
    return env.ASSETS.fetch(request);
  },
};
