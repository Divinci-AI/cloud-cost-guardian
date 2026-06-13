---
title: "The $91,316 bug: I gave every unit in my RTS its own AI agent"
slug: the-91316-dollar-bug
date: 2026-06-04
author: Mike Mooring
tags: [cloudflare, durable-objects, ai-agents, cloud-cost, origin-story, cursor]
description: "Side-vibing an RTS while Cursor wired every unit to its own Durable Object — connections that never closed. A $91,316 Cloudflare bill and why we built Kill Switch."
hero_image: /blog/assets/poster-the-91316-dollar-bug.webp
poster_image: /blog/assets/poster-the-91316-dollar-bug.webp
---

# The $91,316 bug: I gave every unit in my RTS its own AI agent

I was not heroically load-testing production at 3 a.m.

I was **side-vibing** a real-time strategy game we were building — *As Above, So Below* — clicking around the map, letting units chatter, half-watching the match while **Cursor** kept shipping features in the other window. Normal founder evening. The cloud bill was someone else's problem until it wasn't.

There's a special kind of horror reserved for opening a cloud bill and finding a number with five digits where you expected two. Ours had five digits and a comma.

**$91,316.** From a hobby game. In a few weeks.

Here's exactly how it happened, the commits and all — because the failure was so clean, so *reasonable* at every step, that I think a lot of people building with AI agents right now are one deploy away from the same invoice.

## The dream: a strategy game where every unit is alive

We were building a real-time strategy game called *As Above, So Below*. Not "units that bark a canned voice line" alive — actually alive. Every soldier, every worker, every creature could talk to you, remember what it had seen, overhear nearby units, and carry a personality based on its type.

To do that, each unit needed its own little brain: persistent state, a conversation history, memories. The perfect primitive for that is a **Cloudflare Durable Object** — a single-threaded, stateful actor with its own storage. One per entity. Cloudflare's own Agent SDK is built on exactly this idea.

So we did the obvious thing. One unit → one Durable Object.

Cursor helped us move fast. The exciting half of the pattern shipped first.

## The architecture that felt brilliant

We called the class `UnitAgent`. From the very first commit (`16390d2`, Feb 13), the comment at the top of `unit-agent.ts` reads almost like a pitch:

```ts
/**
 * UnitAgent - Per-unit AI agent for direct voice communication
 *  - Conversation history with the player
 *  - Memories of events and observations
 *  - Personality traits based on unit type
 *  - Overheard messages from nearby units
 *
 * Lazy instantiation: DOs are only created when a unit is first spoken to.
 */
```

Lazy instantiation — that was the part we were proud of. You don't pay for a unit's agent until you actually talk to it. Spin one up on first contact:

```ts
const agentId = env.UNIT_AGENT.idFromName(body.unit_agent_id);
const agent = env.UNIT_AGENT.get(agentId);
await agent.initialize(body.unit_agent_id, body.unit_type, body.unit_name, body.race);
```

It worked beautifully. You'd select a soldier, say something, and it would answer *in character*. Every unit on the map could become its own resident AI. It felt like the future. We kept playtesting. The game side felt *good*.

## The flaw, in one sentence

**We created agents on first contact. We never created a way for them to go away.**

`UnitAgent` had no `close()`, no hibernation, no alarm cleanup. The wiring Cursor landed on kept those objects **warm** — connections open, billing **wall-clock time** per actor, not per clever inference call. A Durable Object that never hibernates is a meter you cannot negotiate with.

And it got worse, because units *die*. The game cleaned up beautifully on death — it stopped the chatter, freed the in-game object:

```gdscript
_on_unit_died(...)
_on_unit_died_chatter_cleanup(...)
```

…but none of those handlers ever told Cloudflare to retire the unit's agent. The soldier was gone from the battlefield. Its brain was still on the clock, in a data center, billing by the second.

Now multiply that. An RTS match has dozens to hundreds of units per side. Every unit that *ever* spoke got a permanent, always-on actor. A few weeks of playtesting with ambient unit chatter turned on, and we'd quietly stood up a standing army of immortal AI agents that nobody was playing with anymore.

## The bill

Cloudflare doesn't have a spending cap. There's no "stop at $100." The meter just runs. By the time we looked, the number was **$91,316**.

The cruelest part: nothing *broke*. There was no crash, no outage, no bug report. The system worked exactly as designed. It was just designed to spawn immortal agents and charge us rent on every one while we were side-vibing matches. **The scariest cloud bills don't come from things failing. They come from things working too well while you're not watching the meter.**

## What we did 38 days later

The first commit of this project — Kill Switch — is dated **March 23, 2026**. We started building the thing we desperately wished had existed on the day that invoice landed: something that watches your cloud spend in real time and **kills runaway services before the bill does**, because the providers won't give you a ceiling, so you have to bring your own.

That's the whole product. It's not clever. It's the seatbelt we got in a wreck without.

## The lessons (steal these so you don't pay $91k for them)

1. **Every per-entity actor needs a lifecycle.** If you can create a Durable Object / agent / connection on demand, you must be able to *retire* it on demand — hibernation, a TTL, cleanup on the entity's death. "Lazy create" without "eager destroy" is a money leak with great UX.
2. **The cloud has no ceiling, so build your own.** AWS has begged-for-a-decade and still won't add a hard spending cap. Cloudflare, GCP, Vercel — same. A budget *alert* fires after the spend. You need a circuit breaker, not a notification.
3. **Watch the things that work.** We had alerts for errors and downtime. We had nothing watching a system that was succeeding its way into bankruptcy.

If you're wiring AI agents into anything right now — a game, an app, a coding workflow — you are exactly where we were on February 13th. It feels amazing right up until the statement.

---

*We built **[Kill Switch](https://kill-switch.net)** so the next person doesn't get the $91,316 education. It monitors your cloud spend and auto-kills runaway services — free tier, one account. And **[agent-guard](https://github.com/Divinci-AI/kill-switch/tree/main/packages/agent-guard)** is our open-source guard (`npm i -g @kill-switch/agent-guard`) that hard-caps runaway coding-agent spend (Claude Code, Cursor, Aider) before the loop bankrupts you. Both are the seatbelt. Put it on before the wreck.*
