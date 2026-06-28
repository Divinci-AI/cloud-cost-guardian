# Launch content — "See your real Claude Code limits"

Feature: `agent-guard` / `ks guard` now shows your **real** Claude Code plan limits
(5-hour, weekly all-models, and per-model Sonnet/Opus) in your status bar and warns you
in-session before lockout — pulled from Anthropic's own usage endpoint, no proxy, no
estimation. Token never leaves your machine except to Anthropic.

Brand: 🛡 Kill Switch · navy `#0c1229` / cyan `#5ce2e7` / ember. @KillSwitchCloud.

---

## Tweet / X (≤280)

You can't see your Claude Code weekly limit — until it locks you out mid-refactor on a
Thursday. 🧱

`agent-guard` now puts your *real* limits in your status bar:

🛡 🟢 12%5h · 17%w · 9%d · 5.0wd

5-hour, weekly, per-model. Straight from Anthropic. Warns you before you lock out.

`npx @kill-switch/agent-guard usage`

**Alt thread tweet 2:**
No proxy. No estimating from logs. No screen-scraping `/usage`.
It reads the same numbers Claude Code shows — and your token never leaves your machine
except to Anthropic. Free + MIT. → kill-switch.net

---

## LinkedIn

**You're flying blind on your Claude Code rate limits.**

Anthropic gives Pro/Max plans a 5-hour window *and* a weekly cap. Hit the weekly one and
you're locked out — sometimes for days — usually mid-task, with no warning. There are 15+
open GitHub issues begging for visibility. The data exists; nothing surfaces it while you work.

So we built it into **Agent Guard** (our free, open-source kill switch for coding agents):

🛡 🟢 12%5h · 17%w · 9%d · 5.0wd

Your real limits — the 5-hour window, the weekly all-models cap, *and* the per-model Sonnet/
Opus weekly — live in your status bar, and the guard warns you in-session **before** you lock
out. It reads the same numbers as Claude Code's `/usage`, straight from Anthropic's endpoint.

No proxy. No estimating from local logs (which can't be accurate — we tried, and proved it).
No screen-scraping. Your OAuth token is read from your OS credential store and only ever sent
to Anthropic — never logged, never stored.

One command:

    npx @kill-switch/agent-guard usage

Same engine that already caps runaway agent spend. Free, MIT, works with Claude Code today.

→ kill-switch.net

#ClaudeCode #AItools #DeveloperTools #FinOps #OpenSource

---

## Blog post (markdown source) — slug: see-your-claude-code-limits

# The rate limit you can't see is the one that locks you out

It always happens on a Thursday.

You're three files into a refactor, the agent is humming, and then — nothing. *You've reached
your weekly limit.* Not the 5-hour one you half-keep-track-of. The **weekly** one. The one you
had no way to see coming. Now you're benched until the reset, mid-thought, with a half-applied
change and no idea how close you were an hour ago.

Anthropic's Pro and Max plans run on two rolling windows: a **5-hour** burst window and a
**7-day** cap (plus a separate weekly cap per model). It's a fair system. The problem isn't the
limits — it's that **you can't see them while you work.** `/usage` will tell you if you stop and
ask. Your status bar won't. And there are 15+ open GitHub issues asking for exactly this.

We kept hitting it ourselves. So we fixed it.

## Your real limits, in your status bar

<!-- Hero: looping webm video, webp poster fallback (hosted on Cloudflare R2) -->
<!-- poster: https://pub-dafd3adb7e7747059d5a3e43d8e0faa5.r2.dev/blog/see-your-claude-code-limits/poster.webp -->
<!-- video:  https://pub-dafd3adb7e7747059d5a3e43d8e0faa5.r2.dev/blog/see-your-claude-code-limits/video.webm  (mp4 fallback alongside) -->
<video autoplay loop muted playsinline poster="https://pub-dafd3adb7e7747059d5a3e43d8e0faa5.r2.dev/blog/see-your-claude-code-limits/poster.webp" style="width:100%;border-radius:12px">
  <source src="https://pub-dafd3adb7e7747059d5a3e43d8e0faa5.r2.dev/blog/see-your-claude-code-limits/video.webm" type="video/webm">
  <source src="https://pub-dafd3adb7e7747059d5a3e43d8e0faa5.r2.dev/blog/see-your-claude-code-limits/video.mp4" type="video/mp4">
</video>

`agent-guard` (the free, open-source kill switch for coding agents) now shows your **real**
Claude Code limits:

    🛡 🟢 12%5h · 17%w · 9%d · 5.0wd

Run it once:

    npx @kill-switch/agent-guard usage

    🟢 Claude Code plan limits  ·  observed just now
      [██░░░░░░░░░░░░░░░░░░]  5-hour limit 12% used, resets 9:19 AM
      [███░░░░░░░░░░░░░░░░░]  weekly limit 17% used, resets Tue 7:59 PM, ~83% left over 5.0d (~17%/day vs ~14%/day budget)
      [░░░░░░░░░░░░░░░░░░░░]  weekly · Sonnet   1%

That's the 5-hour window, the weekly all-models cap, **and** the per-model Sonnet/Opus weekly —
each with its real reset time. Wire `agent-guard statusline` into Claude Code and that little
`🛡 🟢 12%5h · 17%w · 9%d · 5.0wd` lives in your status bar, refreshing quietly in the background. When
you're burning fast enough to lock out before the reset, the guard says so — **in-session,
before it happens.**

## How it's actually accurate

Here's the part we're a little proud of, because we did it the hard way first.

The obvious approach is to estimate from local logs — count your tokens, divide by your plan's
budget. Every tool that does this (ccusage, TokenUse, our own first attempt) hits the same wall:
**API-equivalent dollars don't map to Anthropic's internal rate-limit units.** We proved it —
the numbers come out *impossible* (a 5-hour ceiling higher than the weekly one). And Claude Code
never writes the real `/usage` numbers to disk, so there's nothing local to read.

The accurate source is Anthropic's own usage endpoint — the same one `/usage` calls.
`agent-guard` reads your existing Claude Code OAuth token from your OS credential store (macOS
Keychain or `~/.claude/.credentials.json`), asks Anthropic for your usage, and shows you the
real numbers. **The token is only ever sent to Anthropic — never logged, never stored, and it
physically cannot be sent anywhere else** (we allowlist the destination). Background refresh
stays off until you opt in with a foreground command, so no surprise credential prompts.

## It's the same guard that stops runaway bills

Agent Guard already exists to cap runaway coding-agent spend — the `$4,200-weekend`,
`$87k-month` kind of story. Subscription limit awareness is the other half of the same idea:
**know where you stand before the wall, not after.** Dollars for pay-as-you-go, real rate
limits for Pro/Max — alert-only, because it's a plan you already paid for.

It's free, MIT-licensed, and works with Claude Code today:

    npm i -g @kill-switch/agent-guard
    agent-guard usage

Stop getting benched on Thursdays.

→ [kill-switch.net](https://kill-switch.net)

---

## Image prompt (nano-banana / Imagen, 16:9, no text)

> Editorial poster illustration, wide 16:9. A sleek darkened cockpit / heads-up display floating
> in deep space; front and center, three horizontal glowing fuel-gauge meters stacked like a
> status bar, each partly filled with luminous cyan that warms to amber near the end, a small
> glowing shield emblem to their left. Behind them, a towering dark storm-wall of red energy
> looms but is held back by the calm glow of the gauges. Premium, confident, cinematic. Deep
> navy (#0c1229) background, electric cyan (#5ce2e7) rim-light, warm ember-orange highlights on
> the gauges, subtle film grain, high contrast, vector-poster style, no text.

## Motion prompt (Veo 3.1 image-to-video, 6s, no audio)

> Slow cinematic push-in. The three glowing gauge bars gently pulse and tick upward a hair; the
> shield emblem glints once; the distant red storm-wall flickers and surges but is held back by
> the steady cyan glow. Faint ember particles drift upward. Calm, premium, confident — the feeling
> of being in control.
