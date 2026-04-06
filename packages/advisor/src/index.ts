/**
 * Kill Switch Strategic Advisor
 *
 * A Cloudflare Worker cron that runs every Monday at 9:00 AM UTC.
 *
 * What it does:
 * 1. Assembles a product context snapshot
 * 2. Spins up 6 domain-specific sub-agents in parallel (Product, Marketing,
 *    Business, Security, UX, Competitive) — each backed by Claude
 * 3. Synthesizes all perspectives with a final high-quality Claude pass
 * 4. Publishes the synopsis as a GitHub Issue + stores in KV
 *
 * Manual trigger (for testing):
 *   npm run dev               # start local dev server
 *   npm run trigger           # hit /__scheduled to fire immediately
 *
 * Or in production:
 *   curl -X POST 'https://advisor.kill-switch.net/__scheduled?cron=*+*+*+*+*'
 */

import Anthropic from "@anthropic-ai/sdk";
import { buildContext } from "./context";
import { runAgents } from "./agents";
import { synthesize } from "./synthesizer";
import { publish, type AdvisorEnv } from "./publish";

export default {
  // ── Cron trigger ───────────────────────────────────────────────────────────
  async scheduled(_event: ScheduledEvent, env: AdvisorEnv, ctx: ExecutionContext) {
    ctx.waitUntil(run(env));
  },

  // ── HTTP trigger (for manual testing / health check) ───────────────────────
  async fetch(request: Request, env: AdvisorEnv, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    // GET / — health check
    if (request.method === "GET" && url.pathname === "/") {
      return Response.json({
        service: "kill-switch-advisor",
        status: "healthy",
        schedule: "Mondays 09:00 UTC",
        trigger: "POST /__scheduled?cron=*+*+*+*+*",
      });
    }

    // POST /__scheduled — manual trigger (wrangler dev uses this)
    if (request.method === "POST" && url.pathname === "/__scheduled") {
      ctx.waitUntil(run(env));
      return Response.json({ status: "triggered", message: "Advisor run started" });
    }

    // GET /history — list recent synopses stored in KV
    if (request.method === "GET" && url.pathname === "/history") {
      const list = await env.ADVISOR_KV.list({ prefix: "synopsis:" });
      const entries = await Promise.all(
        list.keys.map(async (k) => {
          const val = await env.ADVISOR_KV.get(k.name);
          return val ? JSON.parse(val) : null;
        })
      );
      return Response.json({ synopses: entries.filter(Boolean) });
    }

    return new Response("Not found", { status: 404 });
  },
};

// ─── Core run logic ───────────────────────────────────────────────────────────

async function run(env: AdvisorEnv): Promise<void> {
  console.log("[advisor] Starting weekly strategic analysis...");
  const startMs = Date.now();

  try {
    // 1. Build product context
    const ctx = buildContext();
    console.log(`[advisor] Context built for ${ctx.date}`);

    // 2. Initialize Anthropic client
    // Support both sk-ant-... API keys and Claude Code OAuth tokens
    const credential = env.ANTHROPIC_API_KEY;
    const client = credential.startsWith("sk-ant-")
      ? new Anthropic({ apiKey: credential })
      : new Anthropic({ authToken: credential });
    const agentModel = env.AGENT_MODEL ?? "claude-sonnet-4-6";
    const synthModel = env.SYNTH_MODEL ?? "claude-opus-4-6";

    // 3. Run all 6 domain agents in parallel
    console.log(`[advisor] Running 6 sub-agents in parallel (model: ${agentModel})...`);
    const agentOutputs = await runAgents(ctx, client, agentModel);

    const succeeded = agentOutputs.filter((a) => !a.error).length;
    const failed = agentOutputs.filter((a) => a.error).length;
    console.log(`[advisor] Agents complete: ${succeeded} succeeded, ${failed} failed`);
    if (failed > 0) {
      agentOutputs
        .filter((a) => a.error)
        .forEach((a) => console.warn(`[advisor] Agent ${a.name} failed: ${a.error}`));
    }

    // Abort if too many agents failed — synthesis would be low-quality
    if (succeeded < 3) {
      throw new Error(`Only ${succeeded}/6 agents succeeded — aborting synthesis`);
    }

    // 4. Synthesize with the CEO perspective
    console.log(`[advisor] Synthesizing with ${synthModel}...`);
    const synopsis = await synthesize(agentOutputs, ctx, client, synthModel);
    console.log(`[advisor] Synthesis complete (${synopsis.markdown.length} chars)`);

    // 5. Publish to KV + GitHub Issues
    console.log("[advisor] Publishing...");
    const result = await publish(synopsis, agentOutputs, env);

    if (result.alreadyPublished) {
      console.log(`[advisor] Already published for ${ctx.date}, skipping.`);
    } else {
      console.log(`[advisor] Published GitHub Issue #${result.issueNumber}: ${result.issueUrl}`);
    }

    const elapsed = ((Date.now() - startMs) / 1000).toFixed(1);
    console.log(`[advisor] Done in ${elapsed}s`);

  } catch (err) {
    const elapsed = ((Date.now() - startMs) / 1000).toFixed(1);
    console.error(`[advisor] Run failed after ${elapsed}s:`, err);
    // Don't re-throw — cron failure logging is enough, no need to crash the worker
  }
}
