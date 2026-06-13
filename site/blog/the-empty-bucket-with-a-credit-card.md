---
title: "Your empty S3 bucket has a credit card"
slug: the-empty-bucket-with-a-credit-card
date: 2026-05-30
author: Mike Mooring
tags: [aws, s3, cloud-cost, security]
description: "Maciej Pocwierz created an empty S3 bucket. Two days later he had a $1,300 bill — for ~100 million requests he never made. Here's how the internet can spend your money, and why you need a floor under it."
status: draft   # review before publishing — verify the AWS policy-change claim
---

# Your empty S3 bucket has a credit card

A developer named Maciej Pocwierz created an empty S3 bucket. No data in it. A proof-of-concept, the kind you make and forget.

Two days later, the bill was **over $1,300** — for roughly **100 million requests** he never made. ([His write-up is worth reading in full.](https://medium.com/@maciej.pocwierz/how-an-empty-s3-bucket-can-make-your-aws-bill-explode-934a383cb8b1))

If that sentence doesn't alarm you, sit with it: an empty bucket, doing nothing, ran up an enterprise-grade bill on traffic the owner neither sent nor wanted.

## How an empty bucket spends your money

Two facts about S3 combine into a trap:

1. **AWS bills *failed* requests at the same rate as successful ones.** A denied `403`, an unauthorized `PUT` — you pay ~$0.005 per 1,000 either way. The request didn't store anything, didn't return anything, was rejected on sight. You still get the line item.
2. **Anyone can send requests to your bucket.** No AWS account needed. If they can guess or discover the name, they can knock on the door — millions of times — and *you* pay for every knock, even though every one is turned away.

In Maciej's case the flood came from automated bucket-name scanning plus a popular open-source tool that happened to ship *his* bucket name as a placeholder default in its config. Thousands of machines around the world were dutifully firing requests at a name that turned out to be his.

He did nothing wrong. He just picked a guessable name.

> The internet has write access to your AWS bill, and there is no spending cap to stop it.

To AWS's credit: they waived his bill, and — prompted by exactly this story — later announced they'd stop charging for unauthorized requests you didn't initiate. *(Worth verifying the current policy before you rely on it.)* But the deeper lesson outlived the patch.

## The pattern: you are billed for traffic you can't refuse

This is the same shape as every cloud-cost horror story: **the meter runs on things outside your control, and nothing stops it at a number.** A leaked key. A misconfigured tool. A bot storm. A bucket name in someone's default config. The cost arrives first as silence, then as a statement.

You can't prevent the internet from sending you requests. What you *can* do is put a floor under the damage:

- **Make names unguessable** (add entropy to bucket names — don't use `company-prod`).
- **Watch spend in real time, not at invoice time.** A bucket getting hammered is a spend curve that bends upward hours before the bill lands.
- **Have a circuit breaker.** The difference between a $40 surprise and a $40,000 one is whether *something* was watching and able to act while it was still small.

That last one is why we built [Kill Switch](https://kill-switch.net): it watches your cloud spend and trips before a runaway becomes a five-figure invoice — because AWS won't give you a hard ceiling, so you have to bring your own. Free tier, one account.

An empty bucket shouldn't be able to bankrupt you. Until the cloud agrees, watch the meter.
