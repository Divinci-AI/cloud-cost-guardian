# Feedback from the Divinci self-hosted deployment (2026-06-16/17)

> **Status (2026-06-17):** Addressed on branch `feat/cf-ai-coverage-and-kill-safety`.
> - **`packages/kill-switch-cf`** (self-hosted worker): #1, #2, #3, #4, #5, #8, #9, #10, #11, #12 implemented.
> - **`packages/api`** (managed engine): #1, #2, #9 mirrored. #4 (6h cooldown) and #5
>   (metric-category gating) already existed here.
> - Deferred: #6/#7 (uniform $/day thresholds + cross-cloud catch-all clarity) — mostly
>   docs/UI; the managed engine already computes `estimatedDailyCostUSD` per service.


Real-world findings from running a fork of `kill-switch-cf` in production against
a busy Cloudflare + GCP account (Workers, DO, R2, D1, Queues, **Workers AI**, AI
Gateway, Vectorize + Cloud Run). Ordered roughly by impact. Each is a candidate
issue/PR for the upstream repo.

---

## 1. No Workers AI (Neurons) monitoring — biggest coverage gap (HIGH)

The CF coverage (Workers/DO/R2/D1/Queues/Stream/Pages) omits **Workers AI
inference**, which is today's scariest cost runaway. Our single worst spike was
Workers AI: one model did **3.67M Neurons (~$40) in a day** vs a <$0.35/day
baseline — and nothing watched it.

Add the `aiInferenceAdaptiveGroups` dataset:
- dimensions: `modelId`, `neurons`, `errorCode`, `requestSource`, `tag`
- sum: `totalNeurons`, `totalInputTokens`, `totalOutputTokens`, `totalInferenceTimeMs`
- top-level: `count` (request count)
- pricing: **$0.011 per 1,000 Neurons**

Threshold on daily total Neurons (we used 500k ≈ $5.50/day). Detect-and-alert
only — there's no CF API to throttle Workers AI per-model, so document that the
mitigation is in-app (drop the model from the caller's fallback chain).

## 2. AI Gateway cost monitoring (HIGH for anyone using it as an LLM proxy)

`aiGatewayRequestsAdaptiveGroups` has a `sum.cost` that attributes **upstream
provider** cost (OpenAI/Anthropic/Gemini/Vertex) for traffic routed through AI
Gateway. This catches external LLM spend that neither Workers AI Neurons nor the
CF bill can see.
- dimensions: `gateway`, `provider`, `model`, `cached`, `error`, `rateLimited`, `statusCode`
- sum: `cost`, `erroredRequests`, `cachedRequests`, `uncachedTokensIn/Out`, `cachedTokensIn/Out`
- Gotcha: `cost` is **$0 for the `workers-ai` provider** (Neurons bills that
  separately) — combine #1 and #2 to avoid double-counting and to avoid blind spots.

## 3. Vectorize monitoring (LOW, but easy)

`vectorizeQueriesAdaptiveGroups`:
- dimensions: `vectorizeIndexId` only
- sum: `queriedVectorDimensions`
- **Gotcha: this dataset has NO top-level `count` field** (querying it errors). 
- pricing: $0.01 per 1M queried dimensions.

## 4. Alert de-dup / edge-triggering should be built into the self-hosted worker (HIGH)

With a 5-min cron and **daily-cumulative** thresholds (requests/neurons/rows that
accumulate over the UTC day), once a threshold is crossed it STAYS crossed for the
rest of the day → the same alert re-fires every 5 min (~288×/day). PagerDuty
self-dedups via `dedup_key`, but **Discord/Slack/custom webhooks do not** — we
got an all-day alert stream on Slack. The managed `monitoring-engine` has a 6h
cooldown; the self-hosted `kill-switch-cf` should ship the same. We implemented it
with a KV namespace keyed by a **digit-stripped signature** of the violation set
(so the changing numbers in messages don't defeat the key), TTL = cooldown,
PagerDuty exempt.

## 5. Separate the ALERT threshold from the KILL threshold (HIGH — caused an outage)

Gating auto-disconnect on the SAME threshold as alerting means either (a) any
over-threshold service is auto-killed, or (b) you raise the threshold and lose
early alerting. **This caused a production incident for us:** a legitimate
high-traffic Durable Object (a voice agent, ~1.5M reqs/day = **$0.23/day**) was
**auto-disconnected** because the default DO threshold (1M reqs) doubled as the
kill threshold. A $0.23 cost signal took down a live service at 2am.

Fix we adopted: a `DISCONNECT_THRESHOLD_MULTIPLIER` (default 10) — alerts fire at
1× the threshold, auto-disconnect/delete only above N×. Strongly recommend the
self-hosted package **default to alert-only**, or ship this multiplier defaulting
high. (This is a simpler cousin of the managed product's metric-category gating.)

## 6. Default thresholds should be dollar-calibrated, not raw counts (MED)

`DO_REQUEST_THRESHOLD` default of 1M reqs = **$0.15/day** — not a meaningful cost
signal, yet it triggered a kill. The product already computes
`estimatedDailyCostUSD` per service in `UsageResult`; consider letting operators
threshold on **$/day uniformly** instead of per-metric raw counts, or at least
pick raw-count defaults that map to a sane dollar floor.

## 7. Catch-all "total spend" threshold semantics (MED)

A cross-cloud "total daily spend" catch-all that includes a dominant provider
(GCP Cloud Run, ~$130/day for us) alongside CF (~$12/day) fires constantly if you
size it against CF intuition (we mis-set $50 vs a $140 baseline). Either scope
catch-alls per-provider, or make the docs/UI loudly state the total is cross-cloud
and show the current baseline when setting it.

## 8. Batch GraphQL datasets into one query — rate limits (MED)

Firing many sequential GraphQL queries per check (we now have ~9) hits CF GraphQL
Analytics rate limits (**10429**), which `cfGraphQLSafe` swallows → silent
monitoring gaps. The GraphQL API supports multiple top-level dataset fields under
one `account {}` selection in a single request — batching cuts request count ~8×
and dodges the limit.

## 9. Silent auth-error blindness (HIGH — security/reliability)

A CF token missing **`Account Analytics:Read`** returns `10000 Authentication
error`, which `cfGraphQLSafe` swallows → the **entire CF half reads empty** and
the operator believes they're protected. We were blind for an unknown period
without noticing (only GCP was working). Recommendations:
- Surface a prominent `analyticsAuth: "FAILING"` status on the health/`/spend`
  endpoint instead of silently returning zeros.
- Document the EXACT token scopes: **Account Analytics:Read** (monitoring) +
  **Workers Scripts:Edit** + **Workers Routes:Edit** (auto-disconnect).

## 10. `disconnectWorker` doesn't remove zone Workers Routes (MED — correctness)

The disconnect path disables the workers.dev subdomain and deletes custom
domains, but does **not** remove zone Workers **routes** (`[[routes]]` patterns).
A worker served via a route (not workers.dev) would NOT actually be disconnected,
despite the docs claiming "Workers Routes: Edit" is required. Either implement
route removal or fix the docs so operators don't over-trust the kill.

## 11. No restore/undo for false positives (MED — operability)

When auto-disconnect fires on a false positive there's no built-in recovery — we
had to manually `POST /workers/scripts/<name>/subdomain {enabled:true}`. A
`kill-switch restore <service>` CLI/endpoint (re-enable subdomain, re-add removed
domains/routes from the forensic snapshot) would make false positives recoverable
in seconds.

## 12. Endpoints fail-open without ADMIN_SECRET (MED — security)

The self-hosted worker's HTTP endpoints (`/spend`, `/usage`, `/check`,
`/test-alert`) are **unauthenticated unless `ADMIN_SECRET` is set**, and `/check`
can trigger destructive actions while `/test-alert` can be spammed. Default to
**fail-closed** (refuse if no `ADMIN_SECRET` configured) rather than fail-open.

---

### Net
The product's biggest near-term value-add is **LLM cost coverage** (#1, #2) —
that's the runaway everyone fears in 2026 and it's currently unmonitored. The
biggest safety bug is **alert-threshold == kill-threshold** (#5), which turned a
$0.23 signal into an outage. Everything else is polish.

_— Compiled from the Divinci billing-monitor deployment, 2026-06-17._
