/**
 * Database Kill Sequence — persistent state for the step-by-step database
 * kill switch. Replaces the old in-process Map so sequences survive server
 * restarts and are visible to every Cloud Run instance, and so a destructive
 * step can be claimed atomically (no double-execution from concurrent
 * /advance calls).
 */

import mongoose, { Schema, type Document } from "mongoose";

export interface KillSequenceStepProps {
  action: string;
  status: "pending" | "running" | "completed" | "failed" | "skipped";
  result?: string;
  timestamp?: number;
}

export interface KillSequenceProps {
  /** Public id (dbkill-<uuid>) — exposed to clients instead of _id */
  id: string;
  guardianAccountId: string;
  provider: string;
  target: string;
  trigger: string;
  steps: KillSequenceStepProps[];
  currentStep: number;
  status: "running" | "awaiting-confirmation" | "completed" | "failed" | "aborted";
  snapshotId?: string;
  snapshotVerified: boolean;
  startedAt: number;
  /** True while an /advance call is executing a step (in-flight lock) */
  executing: boolean;
  /** When the in-flight step started — used to recover from a crashed instance */
  stepStartedAt?: number;
  /** Set when the sequence reaches a terminal status; drives TTL cleanup */
  finishedAt?: Date;
}

export type KillSequenceDocument = KillSequenceProps & Document;

const stepSchema = new Schema<KillSequenceStepProps>(
  {
    action: { type: String, required: true },
    status: { type: String, required: true, enum: ["pending", "running", "completed", "failed", "skipped"], default: "pending" },
    result: { type: String },
    timestamp: { type: Number },
  },
  { _id: false },
);

const killSequenceSchema = new Schema<KillSequenceDocument>({
  id: { type: String, required: true, unique: true },
  guardianAccountId: { type: String, required: true, index: true },
  provider: { type: String, required: true },
  target: { type: String, required: true },
  trigger: { type: String, required: true },
  steps: { type: [stepSchema], required: true },
  currentStep: { type: Number, required: true, default: 0 },
  status: { type: String, required: true, enum: ["running", "awaiting-confirmation", "completed", "failed", "aborted"], default: "running" },
  snapshotId: { type: String },
  snapshotVerified: { type: Boolean, required: true, default: false },
  startedAt: { type: Number, required: true },
  executing: { type: Boolean, required: true, default: false },
  stepStartedAt: { type: Number },
  finishedAt: { type: Date },
});

// Auto-delete finished sequences 7 days after they reach a terminal status.
killSequenceSchema.index({ finishedAt: 1 }, { expireAfterSeconds: 7 * 24 * 60 * 60 });

export const KillSequenceModel =
  (mongoose.models?.["GuardianKillSequence"] as mongoose.Model<KillSequenceDocument>) ||
  mongoose.model<KillSequenceDocument>("GuardianKillSequence", killSequenceSchema);
