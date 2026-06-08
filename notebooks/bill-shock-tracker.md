# Bill Shock Wall — Outreach Tracker

Curated real-world "surprise cloud / AI bill" incidents used in the **Why This Exists** section
of the marketing site (`site/index.html`), plus a reply/outreach log.

**Goal:** social proof of the *problem* (not testimonials for us), and a respectful place to share
the free + open-source kill switch with people who just got burned.

**Outreach account:** [@KillSwitchCloud](https://x.com/KillSwitchCloud) (X) — post replies from here.
**Story inbox:** hello@kill-switch.net → Proton (CF Email Routing).
**Site "Tell us" link:** pre-filled tweet → `https://x.com/intent/post?text=Hey%20%40KillSwitchCloud...`

**Reply etiquette (read before posting):**
- Help first, pitch second. Lead with empathy + a concrete tip; mention the tool once, briefly.
- One reply per post. Never copy-paste the same text across threads (spam/astroturfing risk).
- Disclose the affiliation ("I work on…"). Don't reply to posts that are already resolved/old unless it adds value.
- You post from your own accounts. Mark status here so we never double-reply.

Legend — **Status:** `todo` · `drafted` · `posted` · `skip` (too old / resolved / off-topic)

---

## Embeddable social posts (on the site now)

| # | Source | Person | $ | Post URL | Embed | Reply status |
|---|--------|--------|---|----------|-------|--------------|
| 1 | X | Jingna Zhang (@zemotion) — Cara/Vercel | $96,280 | https://x.com/zemotion/status/1798558292681343039 | ✅ live | todo |
| 2 | X | Jason Lemkin (@jasonlk) — Replit DB wipe | data loss | https://x.com/jasonlk/status/1946069562723897802 | ✅ live | skip* |
| 3 | Reddit r/webdev | u/laubonghaudoi — Netlify | $104,500 | https://www.reddit.com/r/webdev/comments/1b14bty/netlify_just_sent_me_a_104k_bill_for_a_simple/ | ✅ live | skip* |

\* #2 and #3 are old/resolved and high-profile; replying now reads as opportunistic. Use as wall proof only.

---

## Cited cards (article/news — on the site as linked story-cards)

| # | Incident | $ | Source URL | Reply-able? |
|---|----------|---|------------|-------------|
| 4 | AI agent retried failing call 11,000× overnight | $50,000 | https://dev.to/lfariaus/building-irl-from-a-50k-aws-horror-story-to-human-centered-ai-governance-1jdg | author blog — maybe |
| 5 | Two agents in recursive loop | $47,000 | https://dev.to/utibe_okodi_339fb47a13ef5/the-ai-agent-that-cost-47000-while-everyone-thought-it-was-working-1lg6 | DEV comment |
| 6 | Claude Code left running overnight | $6,000 | https://www.makeuseof.com/someone-left-claude-code-running-overnight-and-it-cost-6000/ | no (news) |
| 7 | Replit agent ran unattended | $607 | https://blog.vibecoder.me/607-replit-bill-avoiding-runaway-ai-costs | blog |
| 8 | Recursive tool-call loop, 14k requests | $437 | https://earezki.com/ai-news/2026-04-29-i-let-my-ai-agent-run-overnight-it-cost-437/ | author blog |
| 9 | AWS Bedrock + Claude Opus despite cost cap | $30,000 | https://www.theregister.com/ai-ml/2026/05/18/surprise-ai-bills-leave-aws-and-google-cloud-users-aghast/ | no (news) |
| 10 | AU dev, $10k despite spending limits | $10,000 | https://www.theregister.com/ai-ml/2026/05/18/surprise-ai-bills-leave-aws-and-google-cloud-users-aghast/ | no (news) |
| 11 | Firebase 2-yr-old mistake → AI bill overnight | €3,167 | https://medium.com/flutter-community/how-a-two-year-old-firebase-mistake-led-to-a-3-167-ai-bill-overnight-89adfab1dad3 | Medium |
| 12 | Uber burned full-year AI budget in 4 months (Claude Code) | enterprise | https://www.theregister.com/ai-ml/2026/05/18/surprise-ai-bills-leave-aws-and-google-cloud-users-aghast/ | no (news) |

---

## Reply drafts

### #1 — Jingna Zhang / Cara (X) — `todo`
> Gut-wrenching to read — going viral shouldn't mean a $96K surprise. The core problem is that none
> of these platforms ship a real spending *cap*, just alerts after the fact. We built a free + open-source
> kill switch for exactly this: it watches spend across Vercel/AWS/GCP/CF and auto-pauses the runaway
> resource before the bill lands. No affiliation pressure — it's OSS, self-host it: kill-switch.net.
> (I work on it; happy to help you wire it up.)

### #5 — $47K recursive-loop story (DEV comment) — `todo`
> The "everyone thought it was working" part is the scary bit — agentic loops burn quietly. We made a
> free OSS tool (`agent-guard`) that meters token spend per session + per rolling day and hard-stops the
> agent at a cap you set, plus cloud-side kill switches for the infra. Disclosure: I work on it —
> kill-switch.net. Hope it saves the next person the $47K.

### #8 — $437 overnight tool-call loop (author blog) — `todo`
> "Agentic brakes" is exactly the right frame. We shipped a free, open-source version: a Claude Code hook
> + token-metering proxy that caps per-session and daily LLM spend, plus auto-kill on the cloud side.
> (I work on it, it's OSS: kill-switch.net.) Your 14k-redundant-requests breakdown is a great case study —
> mind if we link it on our incidents wall?

> _Reuse note:_ each draft is intentionally different. Tailor the first line to what THEY said before posting.

---

## To find next round (fresh, reply-able posts)
Web search surfaced mostly news write-ups; the live, recent, reply-able threads need on-platform search:
- [ ] r/aws, r/SaaS, r/webdev, r/selfhosted — sort by New, query "bill" / "overnight" / "AI agent"
- [ ] r/Cursor, r/ClaudeAI, r/ChatGPTCoding — "credits gone", "token usage", "API bill"
- [ ] X search: `vercel bill`, `aws bill overnight`, `claude code $`, `cursor credits` (filter: latest)
- [ ] HN: Algolia search "surprise bill" past month
- [ ] Add a screenshot/permalink the moment you find one — posts get deleted.

## Fresh reply targets — research pass (May 2026)
HN items verified via Algolia API (real IDs/authors/dates); Cursor forum threads fetched & confirmed.
Reddit/X permalinks could NOT be verified in this pass (reddit blocked to fetch, X needs login) — see gaps below.
Reply from [@KillSwitchCloud](https://x.com/KillSwitchCloud). Lead with help; disclose affiliation; one reply each.

| Pri | platform | url | poster | date | $ | hook | status |
|-----|----------|-----|--------|------|---|------|--------|
| ⭐ | HN | https://news.ycombinator.com/item?id=47933355 | Zephyr0x | 2026-04-28 | $37,901 | AWS Bedrock prompt-cache miss, "allowed to fail silently," wants hard caps | todo |
| ⭐ | HN | https://news.ycombinator.com/item?id=48120294 | serial_dev | 2026-05-13 | €3,167 | Firebase mistake → overnight AI bill (Flutter); low comments | todo |
| ⭐ | HN | https://news.ycombinator.com/item?id=47943738 | — | 2026-04-29 | $67k | Google API change → $67k Gemini bill in 19h; 0 comments | todo |
| ⭐ | HN | https://news.ycombinator.com/item?id=48200057 | shanirshad | 2026-05-19 | fear | Show HN PrismoDev — worried about Claude Code surprise bills | todo |
| ◦ | HN | https://news.ycombinator.com/item?id=48176365 | — | 2026-05-18 | $10k+ | "Surprise AI bills leave AWS & GCP users aghast" (Register) thread | todo |
| ◦ | HN | https://news.ycombinator.com/item?id=47820834 | — | 2026-04-19 | fear | "Budget alerts come to Cloudflare" — note: alerts ≠ auto-pause | todo |
| ◦ | HN | https://news.ycombinator.com/item?id=47704305 | — | 2026-04-09 | fear | Show HN BillSpike — adjacent founder, collab angle | todo |
| ◦ | HN | https://news.ycombinator.com/item?id=46966879 | hardwellvibe | 2026-02-10 | ~$42+ | Cursor silent pay-per-token overage complaint | todo |
| ◦ | HN | https://news.ycombinator.com/item?id=46544838 | throwawayround | 2026-01-08 | $500+ | Cancelled Cursor Ultra — $60→$500 via hidden cache billing | todo |
| ◦ | HN (viral) | https://news.ycombinator.com/item?id=47791871 | zanbezi | 2026-04-16 | €54k | Unrestricted Firebase key → Gemini; ~297 comments (saturated) | todo |
| ◦ | Cursor | https://forum.cursor.com/t/it-is-unacceptable-that-in-1-day-monthly-credits-are-gone/149522 | Maxim | 2026-01-21 | $20 plan/1 day | Credits gone in a day on Agent+Opus | todo |
| ◦ | Cursor | https://forum.cursor.com/t/running-out-of-ultra-plan-credits-before-renewal/150012 | huynh_ductrung | 2026-01-27 | Ultra/20d | Burned Ultra before renewal, wants caps | todo |
| ⚠ | Reddit | r/ClaudeAI `1t11mmy` — **UNVERIFIED permalink** (from MakeUseOf article) | unknown | ~May 2026 | ~$6,000 | `/loop` ran 46× overnight on Opus 4.7 → $6k | verify-first |

**Named victims w/o linkable post (track down handles manually):** Rod Danan ($10,138 Gemini in ~30 min) and Isuru Fonseka (~AUD $17k despite believed $250 cap) — from The Register (2026-05-13 / 05-18).

**Gaps to close next round (needs logged-in access):**
- [ ] Reddit: r/aws, r/Cursor, r/Firebase, r/Supabase, r/ClaudeAI — use Reddit's own search or API (fetch was blocked here).
- [ ] X/Twitter: search behind login for recent first-person bill posts.
- [ ] Richest fresh veins: leaked Google Maps→Gemini API-key bills (Feb–May 2026) and AI-coding-agent overruns (Claude Code loops, Cursor on-demand, Bedrock cache misses).

## Tweet carousel — verified embeddable tweets (syndication-CDN confirmed)
Live in the homepage "Straight From the Source" carousel (6): @KillSwitchCloud (pinned), @mikeumus,
@zemotion (Cara $96k), @jasonlk (Replit), @tamarajtran (Firebase ~$70k), @GergelyOrosz (AWS, wants hard caps).

Verified alternates to swap in (all status IDs confirmed via cdn.syndication.twimg.com):
- @rtwlz/2020957597810254052 — Jmail/Vercel ~$46–50k (the creator)
- @MatthewBerman/2043851194301592022 — "this @vercel bill came as an absolute surprise" + screenshot
- @radjathaher/2021021709630148667 — "$46K for serving static content is demonic" (Jmail reaction)
- @zak123/2021035298667495465 — "never use vercel… you owe absurd amounts" (reaction)
- @theburningmonk/1798703655908192570 — Yan Cui commentary on Vercel surprises
Couldn't verify an X status ID (excluded): $82k stolen-Gemini-key (origin Reddit), Cursor "$71/day" (forum).

## Meta (our own dogfood story — consider posting!)
While building this very wall, our own `agent-guard` kill switch tripped its $300 daily hard cap and
halted the research session. On-brand proof the thing works. Candidate for a "we killed our own agent" post.
