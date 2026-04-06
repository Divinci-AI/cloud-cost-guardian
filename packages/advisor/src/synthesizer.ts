/**
 * Synthesizer
 *
 * Takes the raw outputs from all 6 sub-agents and runs a final
 * high-quality Claude call that acts as the "CEO reading the weekly briefs"
 * and produces a prioritized, actionable synopsis.
 */

import Anthropic from "@anthropic-ai/sdk";
import type { AgentOutput } from "./agents";
import type { ProductContext } from "./context";

export interface Synopsis {
  date: string;
  weekNumber: number;
  markdown: string;
}

export async function synthesize(
  agentOutputs: AgentOutput[],
  ctx: ProductContext,
  client: Anthropic,
  model: string
): Promise<Synopsis> {
  const agentSections = agentOutputs
    .map((a) => {
      if (a.error) {
        return `### ${a.name} Agent (${a.role})\n_Error: ${a.error} — perspective unavailable this week._`;
      }
      return `### ${a.name} Agent (${a.role})\n${a.content}`;
    })
    .join("\n\n---\n\n");

  const systemPrompt = `You are the CEO and co-founder of Kill Switch, a developer-infrastructure SaaS product.
Every Monday you read the weekly brief from your six domain advisors and synthesize it into a single, prioritized action plan.
You think clearly, cut through noise, and know that execution beats strategy every time.
You are direct, honest about tradeoffs, and ruthlessly prioritize based on impact vs. effort.
You are NOT optimistic by default — you call out real risks and uncomfortable truths.`;

  const userPrompt = `Today is ${ctx.date}.

Here are this week's advisor reports for Kill Switch:

${agentSections}

---

As CEO, synthesize these reports into the **Weekly Strategic Brief**.

The brief must contain these sections (use exactly these headings):

## 🎯 This Week's Top 3 Priorities
The 3 highest-leverage actions the team should take this week. Each priority must:
- Have a clear owner category (Engineering / Marketing / Business / Design)
- State the expected outcome
- Be completable within 1 week

## 🚨 Most Critical Risk Right Now
The single thing that could most hurt Kill Switch in the next 30 days if ignored. Be specific.

## 💡 The Underrated Opportunity
One thing the advisors mentioned that deserves more attention than it's getting. Why is it important?

## 📈 Narrative: Where Kill Switch Is Headed
A 2-3 paragraph honest assessment of where the product stands, what momentum looks like, and what the team needs to believe to win. No corporate speak.

## 🔖 Quick Wins This Week
5 small things (< 1 day each) that would have a disproportionate impact on user trust, conversion, or revenue.

## ⚠️ What NOT to Work On
2-3 things that advisors mentioned that sound good but are distractions right now. Explain why.

---

Write this as if you're sending it to your team in a Slack message: direct, specific, no fluff.
The whole brief should be readable in 5 minutes.`;

  const msg = await client.messages.create({
    model,
    max_tokens: 2048,
    system: systemPrompt,
    messages: [{ role: "user", content: userPrompt }],
  });

  const markdown = msg.content
    .filter((block) => block.type === "text")
    .map((block) => (block as { type: "text"; text: string }).text)
    .join("\n");

  const now = new Date(ctx.date);
  const startOfYear = new Date(now.getFullYear(), 0, 1);
  const weekNumber = Math.ceil(
    ((now.getTime() - startOfYear.getTime()) / 86400000 + startOfYear.getDay() + 1) / 7
  );

  return { date: ctx.date, weekNumber, markdown };
}
