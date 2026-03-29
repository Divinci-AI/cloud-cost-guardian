import mongoose, { Schema, Document } from "mongoose";
import type { ProviderId, ThresholdConfig } from "../../providers/types.js";

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
  lastCheckAt?: number;
  lastCheckStatus?: "ok" | "violation" | "error";
  lastCheckError?: string;
  lastViolations?: string[];
  createdAt: number;
  updatedAt: number;
}

export type CloudAccountDocument = CloudAccountProps & Document;

const cloudAccountSchema = new Schema<CloudAccountDocument>({
  guardianAccountId: { type: String, required: true, index: true },
  provider: { type: String, required: true, enum: ["cloudflare", "gcp", "aws", "runpod", "redis", "mongodb", "openai", "anthropic", "xai", "replicate", "snowflake", "vercel", "datadog"] },
  name: { type: String, required: true },
  providerAccountId: { type: String, required: true },
  credentialId: { type: String, required: true },
  status: { type: String, required: true, enum: ["active", "paused", "error"], default: "active" },
  thresholds: { type: Schema.Types.Mixed, default: {} },
  protectedServices: { type: [String], default: [] },
  autoDisconnect: { type: Boolean, default: true },
  autoDelete: { type: Boolean, default: false },
  lastCheckAt: { type: Number },
  lastCheckStatus: { type: String, enum: ["ok", "violation", "error"] },
  lastCheckError: { type: String },
  lastViolations: { type: [String] },
  createdAt: { type: Number, default: () => Date.now() },
  updatedAt: { type: Number, default: () => Date.now() },
});

cloudAccountSchema.pre("save", function () {
  this.updatedAt = Date.now();
});

export const CloudAccountModel = (mongoose.models?.["GuardianCloudAccount"] as mongoose.Model<CloudAccountDocument>) ||
  mongoose.model<CloudAccountDocument>("GuardianCloudAccount", cloudAccountSchema);
