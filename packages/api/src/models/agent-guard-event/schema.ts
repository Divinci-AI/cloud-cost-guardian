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

  createdAt: { type: Date, default: Date.now },
});

// Common query: an account's recent events, newest first.
agentGuardEventSchema.index({ guardianAccountId: 1, createdAt: -1 });

// Retention: agent-guard events are high-volume telemetry (every warn/block,
// every session). Auto-expire after 90 days via a TTL index so the collection
// can't grow unbounded. Mongo's background TTL monitor deletes expired docs.
//
// ⚠ MIGRATION NOTE: the previous schema declared `createdAt: { index: true }`,
// which builds a PLAIN index `createdAt_1`. This replaces it with a TTL index on
// the same key. MongoDB will NOT redefine an existing index's options — if a
// plain `createdAt_1` already exists in a collection, building this TTL index
// fails with IndexOptionsConflict (code 85) and retention silently does nothing.
// The prod `agentguardevents` collection is empty as of this change (no agent has
// reported yet), so autoIndex builds the TTL index cleanly on deploy. If any
// environment HAS accrued events under the old schema, drop the stale index once:
//   db.agentguardevents.dropIndex("createdAt_1")
// and the TTL index will build on the next boot.
const RETENTION_DAYS = 90;
agentGuardEventSchema.index({ createdAt: 1 }, { expireAfterSeconds: RETENTION_DAYS * 24 * 60 * 60 });

export const AgentGuardEventModel =
  (mongoose.models?.["AgentGuardEvent"] as mongoose.Model<any>) ||
  mongoose.model("AgentGuardEvent", agentGuardEventSchema);
