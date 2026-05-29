/**
 * Agent Guard Event — a budget trip reported by the agent-guard hook or proxy.
 *
 * These are the coding-agent analog of cloud-account kills: when a Claude Code /
 * Cursor / Aider session crosses its per-session or daily-rolling spend cap, the
 * client (@kill-switch/agent-guard) POSTs the event here so it shows up in the
 * dashboard alongside infrastructure kills, and so block-level events fan out
 * through the org's existing alert channels.
 */

import mongoose from "mongoose";

const agentGuardEventSchema = new mongoose.Schema({
  // Tenancy — set from the authenticated API key / session.
  guardianAccountId: { type: String, index: true, required: true },
  orgId: { type: String, index: true },

  // Event payload (mirrors AlertEvent in @kill-switch/agent-guard/src/alert.ts).
  ts: { type: Number, required: true },          // client epoch ms when the trip occurred
  source: { type: String, enum: ["hook", "proxy"], required: true },
  sessionId: { type: String, required: true },
  level: { type: String, enum: ["warn", "block"], required: true },
  sessionUSD: { type: Number, required: true },
  dailyUSD: { type: Number, required: true },
  reasons: { type: [String], default: [] },
  action: { type: String, default: "" },
  cwd: { type: String },

  createdAt: { type: Date, default: Date.now, index: true },
});

// Common query: an account's recent events, newest first.
agentGuardEventSchema.index({ guardianAccountId: 1, createdAt: -1 });

export const AgentGuardEventModel =
  (mongoose.models?.["AgentGuardEvent"] as mongoose.Model<any>) ||
  mongoose.model("AgentGuardEvent", agentGuardEventSchema);
