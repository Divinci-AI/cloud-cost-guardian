# Newsletter subscribe (Beehiiv)

The marketing site Worker (`cloud-switch-site`) exposes `POST /api/subscribe`, which
proxies a signup to Beehiiv so the API key never reaches the browser. The on-brand
form lives in the Bill Shock Wall section (`public/index.html`, `assets/newsletter.js`).

## One-time setup

1. Create a Beehiiv account + publication, then grab:
   - **API key** — Beehiiv dashboard → Settings → API
   - **Publication ID** — looks like `pub_xxxxxxxxxxxx`
2. Set them as Worker secrets (production):
   ```sh
   cd site
   env -u CLOUDFLARE_API_TOKEN -u CLOUDFLARE_EMAIL -u CLOUDFLARE_ACCOUNT_ID wrangler secret put BEEHIIV_API_KEY
   env -u CLOUDFLARE_API_TOKEN -u CLOUDFLARE_EMAIL -u CLOUDFLARE_ACCOUNT_ID wrangler secret put BEEHIIV_PUBLICATION_ID
   ```
   For staging, add `--config wrangler.staging.toml` to each command.
3. Deploy: `npm run deploy:site` (prod) or the staging deploy command in `wrangler.staging.toml`.

Until both secrets are set, `/api/subscribe` returns `{ok:false, error:"not_configured"}`
and the form shows "Signups open shortly — try again soon."

## Endpoint contract

`POST /api/subscribe`  body: `{ "email": "you@x.com", "company": "" }`
(`company` is a honeypot — leave blank; bots that fill it get a silent 200.)

Responses: `{ok:true}` on success; otherwise `{ok:false, error:"invalid_email|not_configured|provider_error|…"}`.
