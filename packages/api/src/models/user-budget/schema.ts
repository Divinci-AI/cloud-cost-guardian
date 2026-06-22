import mongoose, { Schema, type Document } from "mongoose";
import crypto from "crypto";

export type BudgetPeriod = "hour" | "day" | "week" | "month" | "year";

export interface UserBudgetProps {
  /** Public id exposed to clients */
  id: string;
  guardianAccountId: string;
  name: string;
  period: BudgetPeriod;
  budgetAmountUsd: number;
  /** Threshold percentages at which to fire alerts — e.g. [75, 90, 100] */
  thresholdPcts: number[];
  /** "all" = all enabled channels; string[] = channel names to use */
  channels: "all" | string[];
  enabled: boolean;
  /** Which thresholds have already fired in the current period (edge-triggered) */
  notifiedThresholds: number[];
  /** When the current period started (ms since epoch) */
  periodStartedAt: number;
  createdAt: number;
  updatedAt: number;
}

export type UserBudgetDocument = UserBudgetProps & Document;

const userBudgetSchema = new Schema<UserBudgetDocument>({
  id: { type: String, required: true, unique: true, default: () => `budget-${crypto.randomUUID()}` },
  guardianAccountId: { type: String, required: true, index: true },
  name: { type: String, required: true },
  period: { type: String, required: true, enum: ["hour", "day", "week", "month", "year"], default: "day" },
  budgetAmountUsd: { type: Number, required: true, min: 0.01 },
  thresholdPcts: { type: [Number], required: true, default: [75, 90, 100] },
  channels: { type: Schema.Types.Mixed, required: true, default: "all" },
  enabled: { type: Boolean, required: true, default: true },
  notifiedThresholds: { type: [Number], required: true, default: [] },
  periodStartedAt: { type: Number, required: true, default: () => Date.now() },
  createdAt: { type: Number, default: () => Date.now() },
  updatedAt: { type: Number, default: () => Date.now() },
});

userBudgetSchema.pre("save", function () {
  this.updatedAt = Date.now();
});

export const UserBudgetModel =
  (mongoose.models?.["UserBudget"] as mongoose.Model<UserBudgetDocument>) ||
  mongoose.model<UserBudgetDocument>("UserBudget", userBudgetSchema);
