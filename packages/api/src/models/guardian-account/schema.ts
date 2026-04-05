import crypto from "crypto";
import mongoose, { Schema, Document } from "mongoose";

export type GuardianTier = "free" | "pro" | "team" | "enterprise";
export type OrgType = "personal" | "organization";

export interface AlertChannel {
  type: "pagerduty" | "discord" | "slack" | "email" | "webhook" | "github";
  name: string;
  config: {
    routingKey?: string;    // PagerDuty
    webhookUrl?: string;    // Discord, Slack, webhook
    email?: string;         // Email
    githubToken?: string;   // GitHub PAT (repo + workflow scopes)
    repoOwner?: string;     // GitHub org or user (e.g. "acme-corp")
    repoName?: string;      // Repository name (e.g. "my-app")
    workflowFile?: string;  // Workflow filename (e.g. "kill-switch-remediate.yml")
    branchRef?: string;     // Branch to dispatch on (default: "main")
  };
  enabled: boolean;
}

export interface GuardianAccountProps {
  ownerUserId: string;
  name: string;
  slug: string;
  type: OrgType;
  tier: GuardianTier;
  stripeCustomerId?: string;
  stripeSubscriptionId?: string;
  alertChannels: AlertChannel[];
  onboardingCompleted: boolean;
  settings: {
    checkIntervalMinutes: number;
    timezone?: string;
    dailyReportEnabled: boolean;
  };
  createdAt: number;
  updatedAt: number;
}

export type GuardianAccountDocument = GuardianAccountProps & Document;

const alertChannelSchema = new Schema<AlertChannel>({
  type: { type: String, required: true, enum: ["pagerduty", "discord", "slack", "email", "webhook", "github"] },
  name: { type: String, required: true },
  config: { type: Schema.Types.Mixed, required: true },
  enabled: { type: Boolean, default: true },
}, { _id: false });

const guardianAccountSchema = new Schema<GuardianAccountDocument>({
  ownerUserId: { type: String, required: true, index: true },
  name: { type: String, required: true },
  slug: { type: String, required: true, unique: true, index: true },
  type: { type: String, required: true, enum: ["personal", "organization"], default: "personal" },
  tier: { type: String, required: true, enum: ["free", "pro", "team", "enterprise"], default: "free" },
  stripeCustomerId: { type: String },
  stripeSubscriptionId: { type: String },
  alertChannels: { type: [alertChannelSchema], default: [] },
  onboardingCompleted: { type: Boolean, default: false },
  settings: {
    checkIntervalMinutes: { type: Number, default: 360 }, // 6h for free tier
    timezone: { type: String },
    dailyReportEnabled: { type: Boolean, default: false },
  },
  createdAt: { type: Number, default: () => Date.now() },
  updatedAt: { type: Number, default: () => Date.now() },
});

guardianAccountSchema.pre("save", function () {
  this.updatedAt = Date.now();
  // Auto-generate slug if not set
  if (!this.slug) {
    const base = this.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    this.slug = `${base}-${crypto.randomBytes(6).toString("hex")}`;
  }
});

/** Generate a URL-safe slug from a name */
export function generateSlug(name: string): string {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return `${base}-${crypto.randomBytes(6).toString("hex")}`;
}

export const GuardianAccountModel = (mongoose.models?.["GuardianAccount"] as mongoose.Model<GuardianAccountDocument>) ||
  mongoose.model<GuardianAccountDocument>("GuardianAccount", guardianAccountSchema);
