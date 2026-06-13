---
title: "The $1M default: how WebSockets quietly taxed Recall.ai"
slug: the-websocket-tax
date: 2026-05-30
author: Mike Mooring
tags: [aws, cloud-cost, architecture, performance]
description: "Recall.ai moved video between processes with a local WebSocket server — a completely reasonable default. At scale it cost them ~$1M/year. The cloud doesn't bill your bugs. It bills your inefficiency."
status: draft   # review before publishing
---

# The $1M default: how WebSockets quietly taxed Recall.ai

Most cloud-cost disasters are *failures* — a leak, a loop, a bot storm. This one is scarier, because nothing failed. The system worked perfectly. It was just a little bit slow, at enormous scale, for a year.

[Recall.ai wrote up](https://www.recall.ai/blog/how-websockets-cost-us-1m-on-our-aws-bill) how an ordinary engineering choice cost them **about $1,000,000 a year** — and they only found it because someone went looking.

## The reasonable decision that cost a million dollars

Recall runs bots that sit in video meetings and record them. To do that, they had to move *raw decoded video* out of a headless Chromium process into their encoder — a lot of it, on the order of 100+ MB/s per bot.

How do you move bytes between two processes on the same machine? They reached for a local **WebSocket** server over loopback. Totally standard. WebSockets are the default answer to "stream data between two things" for a generation of developers.

The catch is in the protocol. WebSockets **mask every single byte** they send — an extra full pass over the data — plus memory copies on the way through. For a chat app moving a few KB, that overhead is invisible. For a fleet of bots shoveling video at 100+ MB/s, it became the dominant consumer of CPU.

And here's the part that makes it a *cost* story instead of a *performance* story: **on the cloud, CPU is the bill.** More CPU per bot means bigger instances, or more of them, to do the exact same work. The inefficiency didn't show up as an error or a slowdown anyone noticed. It showed up as a fleet that was roughly twice as large as it needed to be — and an invoice to match.

Their fix was to stop using a network protocol to talk to themselves: they switched the transport to **shared memory with a ring buffer**. CPU usage dropped by up to ~50%, and the AWS bill fell by **over $1M/year**. ([InfoQ has a good summary too.](https://www.infoq.com/news/2024/11/aws-websockets-costs/))

## The lesson: the cloud bills your inefficiency, brutally

> A 2x-too-slow default doesn't crash. It doesn't page anyone. It just quietly doubles your fleet — and the bill is the last place you find out.

That's the uncomfortable truth on-demand infrastructure makes literal: **every wasted CPU cycle has a price, and it compounds with scale.** On a single server, a sloppy IPC choice is free. On a thousand servers running 24/7, it's a salary. Then a team. Then a million dollars.

You don't fix this with a spending cap — a cap can't tell a $1M-of-real-work fleet from a $1M-of-waste fleet. You fix it with **observability and a habit**: watch cost *per unit of work*, treat a slow upward drift as a bug report, and go looking before the year-end statement does the looking for you.

That's the half of cost control that isn't about runaway spikes — it's about the slow tax. (The other half — the sudden, catastrophic runaway — is what [Kill Switch](https://kill-switch.net) is for: it trips before a spike becomes a five-figure surprise. Different failure mode, same principle: don't let the bill be the first time you find out.)

Recall's million-dollar default is the best kind of cautionary tale: nobody was negligent. They made a normal choice, it scaled, and the cloud sent them the difference. Go look at your hottest path. Ask what it costs *per byte*. You might be paying a tax you never budgeted for.
