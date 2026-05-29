/**
 * Processed Stripe webhook events — for idempotency / de-duplication.
 *
 * Stripe re-delivers the same event (same `id`) on retries. We record an event's
 * id only after it has been processed successfully; a duplicate delivery is then
 * short-circuited. TTL index expires records after 30 days to keep the collection small.
 */

import mongoose, { Schema } from "mongoose";

export interface ProcessedStripeEvent {
  eventId: string;
  type: string;
  createdAt: Date;
}

const processedStripeEventSchema = new Schema<ProcessedStripeEvent>({
  eventId: { type: String, required: true, unique: true, index: true },
  type: { type: String, required: true },
  createdAt: { type: Date, default: Date.now, expires: 60 * 60 * 24 * 30 },
});

export const ProcessedStripeEventModel =
  mongoose.models.ProcessedStripeEvent ||
  mongoose.model<ProcessedStripeEvent>("ProcessedStripeEvent", processedStripeEventSchema);
