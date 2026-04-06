/**
 * Sub-Agent Definitions
 *
 * Six domain-specific agents, each wearing a different hat.
 * All run in parallel via Promise.allSettled to avoid one
 * timeout or API error blocking the entire synthesis.
 */

import Anthropic from "@anthropic-ai/sdk";
import type { ProductContext } from "./context";

export interface AgentOutput {
  name: string;
  role: string;
  content: string;
  error?: string;
}

interface AgentDef {
  name: string;
  role: string;
  systemPrompt: string;
  userPrompt: (ctx: ProductContext) => string;
}

// ─── Agent definitions ────────────────────────────────────────────────────────

const AGENTS: AgentDef[] = [
  {
    name: "Product",
    role: "Senior Product Manager",
    systemPrompt: `You are a senior product manager with 10 years building developer infrastructure and SaaS tools.
You are direct, opinionated, and not afraid to criticize the current product.
Be specific: name real features, real user flows, real gaps.
Avoid generic advice. Be brutally honest about what is missing or broken.`,
    userPrompt: (ctx) => `
Today is ${ctx.date}. Here is the Kill Switch product snapshot:

## What it does
${ctx.product}

## Current feature set
${ctx.features.map((f) => `- ${f}`).join("\n")}

## Supported providers
${ctx.providers.map((p) => `- ${p}`).join("\n")}

## Pricing tiers
${ctx.tiers.map((t) => `- **${t.name}** (${t.price}): ${t.limits}`).join("\n")}

## Target audience
${ctx.targetAudience.map((a) => `- ${a}`).join("\n")}

## Known challenges
${ctx.knownChallenges.map((c) => `- ${c}`).join("\n")}

## What was recently shipped
${ctx.recentWork.map((r) => `- ${r}`).join("\n")}

As a Senior Product Manager, give your **3 highest-impact feature recommendations** for the next 30-60 days.
For each:
1. Name the feature clearly
2. Explain WHY it matters (what user pain it solves)
3. Describe the rough scope (what it would take to build)
4. State the expected impact on retention/conversion/revenue

Then give **2 features you would NOT build right now** and why.

Be specific, opinionated, and critical. No fluff.
`.trim(),
  },

  {
    name: "Marketing",
    role: "Growth Marketer",
    systemPrompt: `You are a growth marketer who has scaled multiple B2B developer tools from 0 to $1M ARR.
You think in acquisition channels, conversion funnels, messaging, and compounding content loops.
You are direct and numbers-oriented. You call out vanity metrics vs real growth levers.
No generic "post on LinkedIn" advice — give specific, actionable growth experiments.`,
    userPrompt: (ctx) => `
Today is ${ctx.date}. Here is the Kill Switch product snapshot:

## What it does
${ctx.product}

## Pricing tiers
${ctx.tiers.map((t) => `- **${t.name}** (${t.price}): ${t.limits}`).join("\n")}

## Target audience
${ctx.targetAudience.map((a) => `- ${a}`).join("\n")}

## Known challenges
${ctx.knownChallenges.map((c) => `- ${c}`).join("\n")}

As a Growth Marketer, provide:

**3 acquisition experiments** to run in the next 30 days (be specific: channel, hook, format, success metric)

**2 messaging improvements** — what is wrong with the current positioning and what should change?

**1 distribution channel** that is being completely ignored and why it could be the biggest lever

Be honest about what isn't working and why. No fluff.
`.trim(),
  },

  {
    name: "Business",
    role: "Business Strategist / CFO",
    systemPrompt: `You are a business strategist who has helped multiple developer-tool startups build sustainable revenue models.
You think about unit economics, pricing psychology, expansion revenue, and strategic partnerships.
You are direct about revenue risks and opportunities. You prioritize sustainable growth over vanity.`,
    userPrompt: (ctx) => `
Today is ${ctx.date}. Here is the Kill Switch product snapshot:

## What it does
${ctx.product}

## Pricing tiers
${ctx.tiers.map((t) => `- **${t.name}** (${t.price}): ${t.limits}`).join("\n")}

## Current features
${ctx.features.map((f) => `- ${f}`).join("\n")}

## Known challenges
${ctx.knownChallenges.map((c) => `- ${c}`).join("\n")}

As a Business Strategist, address:

**Pricing analysis**: Is the current pricing right? What would you change and why? (consider free tier conversion triggers, pro tier value proposition, enterprise pricing signals)

**Top 2 revenue risks**: What could kill revenue growth in the next 6 months?

**Top 2 revenue opportunities**: What untapped monetization angle has the highest expected value?

**1 strategic partnership** that would accelerate growth — who, why, and how to approach them

Be specific and honest. No generic "charge more" advice.
`.trim(),
  },

  {
    name: "Security",
    role: "Security Researcher / CISO",
    systemPrompt: `You are a security researcher who has audited cloud infrastructure SaaS products for startups and enterprises.
You think about trust boundaries, credential security, threat models, and security as a product differentiator.
You are direct and specific. You name real attack vectors, not just categories.
You also understand that security features can be sold — they build trust AND generate revenue.`,
    userPrompt: (ctx) => `
Today is ${ctx.date}. Here is the Kill Switch product snapshot:

## What it does
${ctx.product}

## Tech stack
${ctx.stack.map((s) => `- ${s}`).join("\n")}

## Trust model
Kill Switch connects to users' cloud accounts using their own API keys/credentials.
These are stored encrypted in MongoDB. The auto-kill feature executes actions in users' cloud accounts.
The product has its own Clerk-based auth, rate limiting, CF origin secret, and RBAC.

## Known challenges
${ctx.knownChallenges.map((c) => `- ${c}`).join("\n")}

As a Security Researcher, address:

**Top 3 security risks** in the current architecture — be specific about the threat, not just the category

**2 security features** that would (a) actually improve security AND (b) make prospects more likely to trust and buy Kill Switch

**1 security certification or compliance framework** most worth pursuing given the target market (SOC2, ISO27001, etc.) and why

Be honest and critical. Call out real gaps, not hypotheticals.
`.trim(),
  },

  {
    name: "UX",
    role: "Senior UX Designer / Head of Product Design",
    systemPrompt: `You are a senior UX designer who specializes in developer tools and complex multi-step setup flows.
You've seen where users drop off in onboarding and know how to fix it.
You think in user journeys, mental models, and friction points.
You are critical of unnecessary steps, unclear feedback, and missing delight moments.`,
    userPrompt: (ctx) => `
Today is ${ctx.date}. Here is the Kill Switch product snapshot:

## What it does
${ctx.product}

## Current features
${ctx.features.map((f) => `- ${f}`).join("\n")}

## Onboarding flow (approximate)
1. User signs up on kill-switch.net
2. User creates an org/account
3. User connects a cloud account (requires IAM role creation / API token)
4. User sets thresholds
5. User configures alert channels (Slack webhook URL, PagerDuty routing key, etc.)
6. Kill Switch starts monitoring

## Target audience
${ctx.targetAudience.map((a) => `- ${a}`).join("\n")}

## Known challenges
${ctx.knownChallenges.map((c) => `- ${c}`).join("\n")}

As a Senior UX Designer, provide:

**Top 3 onboarding friction points** you would fix first — be specific about what the user experiences and what the fix is

**2 UX improvements** that would increase trust and confidence in the product (remember: this is a product that auto-kills things in users' cloud accounts — trust is paramount)

**1 delight moment** to add that would make users tell their coworkers about Kill Switch

Be direct and specific. No generic "improve the UI" advice.
`.trim(),
  },

  {
    name: "Competitive",
    role: "Competitive Intelligence Analyst / Strategy Lead",
    systemPrompt: `You are a competitive intelligence analyst who tracks developer tooling, FinOps, and cloud cost management markets.
You have deep knowledge of tools like Infracost, CloudZero, Vantage, CAST AI, Kubecost, and similar products.
You are direct about where Kill Switch is differentiated, where it is behind, and what strategic moves matter.
You do not sugarcoat competitive risks.`,
    userPrompt: (ctx) => `
Today is ${ctx.date}. Here is the Kill Switch product snapshot:

## What it does
${ctx.product}

## Supported providers (13+)
${ctx.providers.slice(0, 8).map((p) => `- ${p}`).join("\n")}

## Pricing
${ctx.tiers.map((t) => `- **${t.name}** (${t.price}): ${t.limits}`).join("\n")}

## Key differentiators
- Auto-kill (not just alert — actually disconnects the service)
- Agent model: edge workers run in customer's own account (zero credential sharing)
- Born from a real $91K billing incident — authentic founder story
- Developer-first: CLI, SDK, API
- Multi-provider: 13+ providers vs. single-cloud competitors

As a Competitive Intelligence Analyst, provide:

**2 direct competitors** most likely to land the same deal Kill Switch is pitching — what is their pitch vs. Kill Switch's? Who wins and why?

**1 adjacent threat** (not a direct competitor today, but could become one) — who is it and what should Kill Switch do about it?

**2 untapped differentiators** — things Kill Switch could lean into that competitors can't easily copy

**1 market trend** that Kill Switch should position itself in front of right now

Be specific, critical, and realistic. Name real companies.
`.trim(),
  },
];

// ─── Runner ───────────────────────────────────────────────────────────────────

/**
 * Run all 6 sub-agents in parallel.
 * Uses allSettled so one failure doesn't abort the whole run.
 */
export async function runAgents(
  ctx: ProductContext,
  client: Anthropic,
  model: string
): Promise<AgentOutput[]> {
  const results = await Promise.allSettled(
    AGENTS.map((agent) => runAgent(agent, ctx, client, model))
  );

  return results.map((result, i) => {
    if (result.status === "fulfilled") return result.value;
    return {
      name: AGENTS[i].name,
      role: AGENTS[i].role,
      content: "",
      error: result.reason instanceof Error ? result.reason.message : String(result.reason),
    };
  });
}

async function runAgent(
  agent: AgentDef,
  ctx: ProductContext,
  client: Anthropic,
  model: string
): Promise<AgentOutput> {
  const msg = await client.messages.create({
    model,
    max_tokens: 1024,
    system: agent.systemPrompt,
    messages: [{ role: "user", content: agent.userPrompt(ctx) }],
  });

  const content = msg.content
    .filter((block) => block.type === "text")
    .map((block) => (block as { type: "text"; text: string }).text)
    .join("\n");

  return { name: agent.name, role: agent.role, content };
}
