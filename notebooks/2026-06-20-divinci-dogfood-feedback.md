# Kill-Switch CLI / API dogfood feedback — 2026-06-20 (from Divinci go-live QA)

Captured while using the KS CLI + API to (try to) adjust the Divinci production
Atlas cluster's monitoring during a prod go-live. Each item is concrete +
actionable. Ordered roughly by impact.

---

## 🔴 Design: threshold model + default kill action (the big one)

**What happened:** We spent real effort believing the kill switch had auto-paused
Divinci's prod Mongo Atlas (M30) twice — because (a) `mongodb/checker.ts` has a
`pause-cluster` action, and (b) the `getDefaultThresholds()` comment literally
says *"a 33GB Dedicated M30 immediately triggered a storage kill on onboarding"*.
(It turned out NO account was actually connected — see CLI item #1 — but the
design risk is real and worth fixing regardless.)

1. **`pause-cluster` should never be a DEFAULT action for a managed production DB.**
   Pausing a prod database to "save cost" can cause a far worse outage than the
   spend it saves. Default to `snapshot`/alert; require explicit opt-in for
   destructive actions (pause/delete/flush) on managed DBs.

2. **An absolute `mongodbStorageSizeGB` threshold that triggers a kill is the wrong
   model for fixed-tier dedicated clusters.** On M10+ the cost driver is the TIER
   (and auto-scale), not storage or connection count — you pay the same hourly
   rate at 1GB or 40GB. So the meaningful runaway guards are **tier-change /
   monthly-spend / daily-cost**, not storage-GB. Storage should be an *alert near
   disk capacity*, never a pause.

3. **Make thresholds tier-aware at onboarding.** Read the cluster's real
   `diskSizeGB` + `instanceSize` from the Atlas API when connecting and set the
   storage threshold relative to capacity (e.g. 90% of disk as an ALERT), instead
   of a flat number that's wrong for every tier. We measured the real Divinci M30:
   40GB disk / ~16.8GB used / max 67 conns / ~25 ops/s / ~$450/mo — a flat 10GB
   storage line tripped it; a flat 500GB never would. Neither is "right" — relative
   is.

4. **Add a `production-protected` flag (default ON for prod-tagged accounts)** that
   caps allowed actions to non-destructive (snapshot/alert/scale-down) — mirrors
   the dogfood `PROTECTED_WORKERS` idea but for managed DBs. We had to hand-roll
   this in a `divinci-prod-atlas.config.ts` (see PR #32).

5. **Paused-cluster handling:** confirm the checker detects an *already-paused*
   Atlas cluster via the Atlas API (not via a failed mongo connection, which a
   ServerSelectionTimeout could be misread as a different fault). `checker.ts:473`
   hints this exists for "paused services" — verify it covers the Atlas paused state.

---

## 🟡 CLI usability

1. **`ks accounts list` / `ks status` don't make the ACTIVE ORG obvious — biggest
   confusion of the session.** We had 3 orgs (personal / divinci [free] / zombay
   [team]); active was `zombay` with 0 accounts, but we expected `divinci`'s data.
   `accounts list` just said "No results." with no org context. Fix: print the
   active org in `accounts list` ("Accounts in org 'zombay' (0):") and in `status`.

2. **`ks status` appears to report a different org than `orgs switch` set active.**
   `orgs list` showed active = zombay (team), but `status` showed "Plan: free,
   Accounts: 0/1 max" (that's the *divinci* free org). Reconcile which org `status`
   reflects, and label it.

3. **Add `ks doctor` / `ks whoami --verbose`** showing: active org, ALL orgs + each
   one's account count, and any server-side/dogfood monitors. Would have instantly
   answered "is anything actually monitoring my cluster, and where?" (we had to
   switch into each org one-by-one + hit the raw API to find out).

4. **Command-name inconsistency in hints:** `ks auth status` (unauth) prints
   *"Run: kill-switch auth login --api-key YOUR_KEY"* but the bin is `ks`. Use `ks`
   in hints, and mention the device flow (`ks auth login`, browser by default) — the
   `--api-key` hint hides the nicer path. (The device flow itself worked great.)

## 🟡 CLI capability gaps

5. **`ks accounts add` only supports cloudflare/gcp/aws** (per `--help`), but the
   platform's `checker.ts` + web `OnboardingPage.tsx` support mongodb/redis/neo4j.
   So you can onboard Mongo via the web UI but NOT the CLI. (`atlas-onboarding-
   handoff.md` already notes mongodb CLI onboarding "doesn't complete end-to-end".)
   Wire the same providers into `accounts add`.

6. **No `ks accounts update`** to change thresholds or the kill action per-account.
   You can list/get/add/delete/check — but the one thing we needed (adjust
   thresholds + set action→snapshot) has no CLI verb; only the web UI or a raw
   `PUT /cloud-accounts/:id`. Add e.g.
   `ks accounts update <id> --set-threshold mongodbStorageSizeGB=100 --action snapshot`.

## 🟡 API / SDK

7. **Response-envelope inconsistency:** writing the setup script I had to guard
   `list.accounts ?? list` because `GET /cloud-accounts` shape wasn't obvious.
   Standardize + document the envelope (`{ accounts: [...] }` vs bare array).

8. **No "integration-as-code" helper for non-CF providers.** `dogfood/config.ts` +
   `setup.ts` is a clean config-as-code pattern but is CF-self-monitoring only. We
   mirrored it by hand for Mongo (`divinci-prod-atlas.config.ts` + `.setup.ts`,
   PR #32). A generic `buildAccountConfig({provider, credential, thresholds, rules,
   protectedServices})` + a setup runner that find-or-updates the existing account
   would make repeatable, reviewable onboarding a first-class thing.

---

## Net
The CLI auth (device flow) and the API were solid once oriented. The two things
that cost the most time: (a) **no org-context in `accounts list`/`status`** (sent us
chasing a "missing" account that was just in another org), and (b) the
**threshold/`pause-cluster` design** for managed prod DBs. Fixing #A1–A4 +
#B1–B3 would prevent the whole class of confusion + risk we hit.
