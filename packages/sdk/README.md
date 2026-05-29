# @kill-switch/sdk

Zero-dependency TypeScript client for the [Kill Switch](https://kill-switch.net) API — monitor cloud spend and trip kill switches on runaway services programmatically.

```sh
npm install @kill-switch/sdk
```

## Quick start

```ts
import { KillSwitchClient } from "@kill-switch/sdk";

const client = new KillSwitchClient({ apiKey: "ks_live_..." });

// List connected cloud accounts
const accounts = await client.accounts.list();

// Run a monitoring check across all accounts
const result = await client.monitoring.checkAll();

// Apply a protection preset
await client.rules.applyPreset("cost-runaway");
```

Get a personal API key (`ks_live_…`) from the dashboard at
[app.kill-switch.net](https://app.kill-switch.net) → Settings → API Keys.

## Client options

```ts
new KillSwitchClient({
  apiKey,        // ks_live_… or ks_test_… key
  jwtToken,      // Clerk JWT — alternative to apiKey
  orgId,         // scope requests to an organization
  baseUrl,       // default: https://api.kill-switch.net
  timeout,       // request timeout in ms (default: 30000)
  maxRetries,    // retries for 5xx/429/network errors (default: 2)
  fetch,         // custom fetch (testing / edge runtimes)
  hooks,         // request/response event hooks for logging
});
```

You can update credentials after construction with `setApiKey()`, `setJwtToken()`,
and `setOrgId()`.

## Resources

The client exposes one accessor per API area:

| Accessor | Covers |
|---|---|
| `client.account` | Current account / plan |
| `client.accounts` | Connected cloud accounts (CRUD) |
| `client.rules` | Kill-switch rules & shield presets |
| `client.alerts` | Alert channels (PagerDuty, Slack, Discord, email, webhook, GitHub) |
| `client.database` | Database kill sequences |
| `client.auth` | API keys & auth |
| `client.billing` | Plan & billing |
| `client.teams` | Team members & roles |
| `client.orgs` | Organizations |
| `client.activity` | Audit / activity log |
| `client.analytics` | FinOps analytics |
| `client.monitoring` | On-demand monitoring checks |
| `client.providers` | Supported providers & credential validation |

## Errors

All failures throw a subclass of `KillSwitchError`, so you can branch on type:

```ts
import {
  KillSwitchError,
  ApiError,
  AuthenticationError,
  ForbiddenError,
  NotFoundError,
  RateLimitError,
  TimeoutError,
  NetworkError,
} from "@kill-switch/sdk";

try {
  await client.accounts.list();
} catch (err) {
  if (err instanceof AuthenticationError) {
    // invalid or missing API key
  } else if (err instanceof RateLimitError) {
    // back off and retry
  }
}
```

## Links

- Website: <https://kill-switch.net>
- API reference: <https://kill-switch.net/docs>
- CLI: [`@kill-switch/cli`](https://www.npmjs.com/package/@kill-switch/cli)

MIT © Kill Switch
