import mongoose, { Schema, Document } from "mongoose";
import type { KillSwitchRule, RuleTrigger } from "../../providers/types.js";

export type KillSwitchRuleDocument = KillSwitchRule & {
  guardianAccountId: string;
  createdAt: number;
  updatedAt: number;
} & Document;

const conditionSchema = new Schema({
  metric:        { type: String, required: true },
  operator:      { type: String, required: true, enum: ["gt", "lt", "gte", "lte", "eq"] },
  value:         { type: Number, required: true },
  windowMinutes: { type: Number },
}, { _id: false });

const actionSchema = new Schema({
  type:            { type: String, required: true },
  target:          { type: String },
  delay:           { type: Number },
  requireApproval: { type: Boolean },
}, { _id: false });

const killSwitchRuleSchema = new Schema<KillSwitchRuleDocument>({
  guardianAccountId: { type: String, required: true, index: true },
  id:                { type: String, required: true },
  name:              { type: String, required: true },
  enabled:           { type: Boolean, default: true },
  trigger:           { type: String, required: true, enum: ["cost", "security", "custom", "api", "agent"] },
  conditions:        { type: [conditionSchema], default: [] },
  conditionLogic:    { type: String, required: true, enum: ["all", "any"], default: "any" },
  actions:           { type: [actionSchema], default: [] },
  cooldownMinutes:   { type: Number, default: 60 },
  lastFiredAt:       { type: Number },
  forensicsEnabled:  { type: Boolean, default: false },
  createdAt:         { type: Number, default: () => Date.now() },
  updatedAt:         { type: Number, default: () => Date.now() },
});

// Unique rule id per org
killSwitchRuleSchema.index({ guardianAccountId: 1, id: 1 }, { unique: true });

killSwitchRuleSchema.pre("save", function () {
  this.updatedAt = Date.now();
});

export const KillSwitchRuleModel =
  (mongoose.models?.["KillSwitchRule"] as mongoose.Model<KillSwitchRuleDocument>) ||
  mongoose.model<KillSwitchRuleDocument>("KillSwitchRule", killSwitchRuleSchema);
