# Paid-Service Audit — Kill Switch (end-to-end)

Date: 2026-05-29. Scope: signup → subscribe → payment → provisioning → gated access, across
`packages/api` + `packages/web`. Read-only audit (3 parallel passes: billing, entitlements, signup/UX).

## Verdict
The paid funnel is **fundamentally sound**: JIT account creation works, Stripe webhook signature
verification + raw-body handling are correct, tier is derived from the **verified price ID** (not
client metadata) and read from a trusted DB source, and most limits are enforced **server-side**
(so `ks_live_` API keys are gated identically to the UI). **Not yet "100%"** — 2 billing BLOCKERs and
one security HIGH should be fixed before charging real cards at scale.

## Flow map
1. **Signup** — Clerk hosted signup → first authed call hits `resolveOrg`, which upserts a personal
   `GuardianAccount` (tier `free`) + `UserProfile` (`middleware/auth.ts:214-251`). No orphaned-user gap.
2. **Onboarding** — 6-step wizard; a free user can reach a working monitored account (1 account, 6h checks).
3. **Billing entry** — `/billing?plan=pro` only *highlights* a card; upgrade click → `POST /billing/checkout`
   → Stripe Checkout → redirect (correct).
4. **Provisioning** — webhook `checkout.session.completed` sets tier/sub IDs/check-interval from the
   verified price ID (`billing/index.ts:218-256`). Automatic, no manual step.
5. **Gating** — cloud accounts, alert channels, team members, org creation, check interval all enforced
   in the API. Pricing matches marketing (Pro $29/$290, Team $99/$990, Enterprise custom).

## Gap list (severity-ranked)

### BLOCKER — fix before charging at scale
- **B1. No payment-failure handling.** `customer.subscription.updated` only acts on `status==="active"`,
  and `invoice.payment_failed` isn't handled → a failed card stays on the paid tier indefinitely
  (`routes/billing/index.ts:259-273`). Fix: handle `invoice.payment_failed` + non-active statuses;
  downgrade/flag after a grace period.
- **B2. Stripe v17 field-location bug.** `/billing/status` reads `current_period_end` /
  `cancel_at_period_end` off the top-level Subscription, but SDK v17's default API version moved them
  onto subscription items → UI gets `undefined` renewal/cancel info (`billing/index.ts:87-88`). Root cause:
  no explicit `apiVersion` pin on the billing client (`billing/index.ts:16`; cf. `app.ts:338` which pins).

### HIGH
- **H1 (security). Activity Log is UI-gated only.** `GET /activity` checks role but not tier
  (`routes/activity/index.ts:22`), so a free/pro owner/admin can read the full audit log via direct API /
  `ks_live_` key, though it's marketed Team/Enterprise-only. Fix: add a `requireTier("team","enterprise")`
  check on the route.
- **H2 (conversion). `/billing?plan=` doesn't launch checkout** — only sets a CSS highlight
  (`web/.../BillingPage.tsx:149`); marketing "Upgrade" buttons imply one-click. Fix: auto-call
  `handleCheckout` when `?plan=` matches a paid tier (or a one-click "Continue to checkout" CTA).
- **H3. Hardcoded test-mode fallback price IDs.** If `STRIPE_PRICE_*` env vars are unset in prod,
  checkout silently uses baked-in `price_1TE2hN...` test IDs (`billing/index.ts:20-23`). Fix: throw on
  startup if missing in production.
- **H4. No webhook idempotency / event de-dup.** Stripe retries re-run handlers (`billing/index.ts:216-287`).
  Fix: persist processed `event.id`s and short-circuit duplicates.
- **H5. No explicit `apiVersion` pin** on the billing Stripe client (root cause of B2) — behavior floats on
  `npm update` (`billing/index.ts:16`).

### MEDIUM
- **M1.** No `subscriptionStatus`/`currentPeriodEnd` persisted; every status read hits Stripe live
  (`models/guardian-account/schema.ts:29-30`). Persist from webhooks.
- **M2.** Downgrade doesn't reconcile overages — excess cloud accounts/alert channels left active after
  dropping to free (enforcement only triggers on new POSTs).
- **M3.** Free-tier expectation mismatch — marketing pricing lists only Pro/Team/Enterprise; no Free card,
  yet signup lands on a usable Free tier (`site/index.html:1176-1219`).
- **M4.** Onboarding offers only email/discord/slack channels; platform also supports PagerDuty/GitHub.

### LOW
- **L1.** `enforceTierLimits("alertChannels")` branch is **dead code** — the alertChannels limit is actually
  enforced separately in `routes/alerts/index.ts:70` (so channels *are* gated; the billing-side branch is
  just unused). Remove the unused param/branch.
- **L2.** `requireTeamTier` duplicated in `team/index.ts:18` and inline in `orgs/index.ts:94,312` — extract a
  shared `requireTier(...)` middleware (also fixes H1 cleanly).
- **L3.** Team-member limit hardcoded `{team:10,enterprise:100}` in `team/index.ts:115` instead of `TIER_LIMITS`.
- **L4.** `success=true` banner says "plan active" before the async webhook may have landed
  (`BillingPage.tsx:80`) — poll/refetch status a few times.
- **L5.** Webhook handler `console.error` on success paths; 500-on-error + no idempotency → double-apply risk.

## Correct as-is (no action)
Webhook signature verification (fail-closed) + raw-body preservation; tier derived from verified price ID;
tier read only from DB (never client headers/body); RBAC `requirePermission` on all mutations; IDOR/ownership
checks on org routes; redirect-URL allowlisting; account deletion cancels Stripe subs; check-interval not
user-editable; dev auth-bypass triple-gated to non-prod; API-key path gated identically to UI.
