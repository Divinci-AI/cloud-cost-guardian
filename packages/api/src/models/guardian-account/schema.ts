import mongoose, { Schema, Document } from "mongoose";

export type GuardianTier = "free" | "pro" | "team" | "enterprise";

export interface AlertChannel {
  type: "pagerduty" | "discord" | "slack" | "email" | "webhook";
  name: string;
  config: {
    routingKey?: string;    // PagerDuty
    webhookUrl?: string;    // Discord, Slack, webhook
    email?: string;         // Email
  };
  enabled: boolean;
}

export interface GuardianAccountProps {
  ownerUserId: string;
  name: string;
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
  type: { type: String, required: true, enum: ["pagerduty", "discord", "slack", "email", "webhook"] },
  name: { type: String, required: true },
  config: { type: Schema.Types.Mixed, required: true },
  enabled: { type: Boolean, default: true },
}, { _id: false });

const guardianAccountSchema = new Schema<GuardianAccountDocument>({
  ownerUserId: { type: String, required: true, unique: true, index: true },
  name: { type: String, required: true },
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
});

export const GuardianAccountModel = (mongoose.models?.["GuardianAccount"] as mongoose.Model<GuardianAccountDocument>) ||
  mongoose.model<GuardianAccountDocument>("GuardianAccount", guardianAccountSchema);
