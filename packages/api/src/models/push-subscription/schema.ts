import mongoose, { Schema, type Document } from "mongoose";

export interface PushSubscriptionProps {
  guardianAccountId: string;
  userId: string;
  endpoint: string;
  keys: {
    p256dh: string;
    auth: string;
  };
  createdAt: number;
}

export type PushSubscriptionDocument = PushSubscriptionProps & Document;

const pushSubscriptionSchema = new Schema<PushSubscriptionDocument>({
  guardianAccountId: { type: String, required: true, index: true },
  userId: { type: String, required: true, index: true },
  endpoint: { type: String, required: true, unique: true },
  keys: {
    p256dh: { type: String, required: true },
    auth: { type: String, required: true },
  },
  createdAt: { type: Number, default: () => Date.now() },
});

export const PushSubscriptionModel =
  (mongoose.models?.["PushSubscription"] as mongoose.Model<PushSubscriptionDocument>) ||
  mongoose.model<PushSubscriptionDocument>("PushSubscription", pushSubscriptionSchema);
