import mongoose, { Schema, Document } from "mongoose";
import type { ProviderId, ThresholdConfig, MetricCategory } from "../../providers/types.js";

export interface CloudAccountProps {
  guardianAccountId: string;
  provider: ProviderId;
  name: string;
  providerAccountId: string;
  credentialId: string;
  status: "active" | "paused" | "error";
  thresholds: ThresholdConfig;
  protectedServices: string[];
  autoDisconnect: boolean;
  autoDelete: boolean;
  /**
   * Which violation categories fire an auto-kill action.
   * Default: ["cost"] — only cost-runaway breaches kill. Operators wanting
   * kill-on-storage / kill-on-load semantics can extend this list (e.g.
   * ["cost", "storage"]). An empty array disables auto-kill entirely
   * (alert-only mode). Defaulting at the schema level means existing
   * accounts that don't have this field automatically get the safer
   * cost-only behavior on the next check cycle.
   */
  autoKillCategories: MetricCategory[];
  lastCheckAt?: number;
  lastCheckStatus?: "ok" | "violation" | "error";
  lastCheckError?: string;
  lastViolations?: string[];
  /** Hash of the last violations we alerted on — used for dedup. */
  lastAlertHash?: string;
  /** Timestamp of the last alert sent for the current violation hash. */
  lastAlertedAt?: number;
  createdAt: number;
  updatedAt: number;
}

export type CloudAccountDocument = CloudAccountProps & Document;

const cloudAccountSchema = new Schema<CloudAccountDocument>({
  guardianAccountId: { type: String, required: true, index: true },
  provider: { type: String, required: true, enum: ["cloudflare", "gcp", "aws", "runpod", "redis", "mongodb", "openai", "anthropic", "xai", "replicate", "snowflake", "vercel", "datadog", "neon", "neo4j"] },
  name: { type: String, required: true },
  providerAccountId: { type: String, required: true },
  credentialId: { type: String, required: true },
  status: { type: String, required: true, enum: ["active", "paused", "error"], default: "active" },
  thresholds: { type: Schema.Types.Mixed, default: {} },
  protectedServices: { type: [String], default: [] },
  autoDisconnect: { type: Boolean, default: true },
  autoDelete: { type: Boolean, default: false },
  autoKillCategories: {
    type: [String],
    enum: ["cost", "load", "storage", "count", "security"],
    default: ["cost"],
  },
  lastCheckAt: { type: Number },
  lastCheckStatus: { type: String, enum: ["ok", "violation", "error"] },
  lastCheckError: { type: String },
  lastViolations: { type: [String] },
  lastAlertHash: { type: String },
  lastAlertedAt: { type: Number },
  createdAt: { type: Number, default: () => Date.now() },
  updatedAt: { type: Number, default: () => Date.now() },
});

cloudAccountSchema.pre("save", function () {
  this.updatedAt = Date.now();
});

export const CloudAccountModel = (mongoose.models?.["GuardianCloudAccount"] as mongoose.Model<CloudAccountDocument>) ||
  mongoose.model<CloudAccountDocument>("GuardianCloudAccount", cloudAccountSchema);
