/**
 * Parse a Claude Code transcript (JSONL) into total token usage by model.
 *
 * Claude Code passes `transcript_path` in every hook payload. Each line is a
 * JSON event; assistant turns carry `message.usage` with input/output and the
 * two cache buckets, plus `message.model`. We sum per model so the hook can
 * price a mixed-model session correctly. Malformed lines are skipped — a parse
 * error must never wedge the kill switch.
 */

import { readFileSync } from "node:fs";
import type { TokenUsage } from "./cost.js";

export interface TranscriptTotals {
  byModel: Map<string, TokenUsage>;
  lines: number;
}

function addUsage(into: TokenUsage, u: any): void {
  into.inputTokens += u.input_tokens || 0;
  into.outputTokens += u.output_tokens || 0;
  into.cacheCreationTokens = (into.cacheCreationTokens || 0) + (u.cache_creation_input_tokens || 0);
  into.cacheReadTokens = (into.cacheReadTokens || 0) + (u.cache_read_input_tokens || 0);
}

export function parseTranscript(path: string): TranscriptTotals {
  const byModel = new Map<string, TokenUsage>();
  let lines = 0;

  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return { byModel, lines };
  }

  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    lines++;
    let evt: any;
    try {
      evt = JSON.parse(trimmed);
    } catch {
      continue;
    }
    const msg = evt?.message;
    const usage = msg?.usage;
    if (!usage) continue;
    const model = msg.model || "unknown";
    let acc = byModel.get(model);
    if (!acc) {
      acc = { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 };
      byModel.set(model, acc);
    }
    addUsage(acc, usage);
  }

  return { byModel, lines };
}
