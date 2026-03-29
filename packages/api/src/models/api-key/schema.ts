/**
 * Personal API Key Model
 *
 * Allows CLI and programmatic access without Clerk JWT tokens.
 * Keys are hashed with SHA-256 before storage — the plaintext
 * is returned only once at creation time.
 */

import mongoose, { Schema, Document } from "mongoose";
import { randomBytes, createHash } from "crypto";

export interface IPersonalApiKey extends Document {
  guardianAccountId: string;
  userId: string;
  name: string;
  keyHash: string;
  keyPrefix: string; // First 8 chars for identification
  lastUsedAt: Date | null;
  createdAt: Date;
}

const PersonalApiKeySchema = new Schema<IPersonalApiKey>({
  guardianAccountId: { type: String, required: true, index: true },
  userId: { type: String, required: true },
  name: { type: String, required: true },
  keyHash: { type: String, required: true, unique: true },
  keyPrefix: { type: String, required: true },
  lastUsedAt: { type: Date, default: null },
  createdAt: { type: Date, default: Date.now },
});

export const PersonalApiKeyModel = mongoose.model("PersonalApiKey", PersonalApiKeySchema);

/**
 * Generate a new API key. Returns the plaintext key (shown once)
 * and stores the hash.
 */
export async function createApiKey(
  guardianAccountId: string,
  userId: string,
  name: string
): Promise<{ key: string; id: string }> {
  const raw = randomBytes(32).toString("hex");
  const key = `ks_live_${raw}`;
  const keyHash = hashKey(key);
  const keyPrefix = key.substring(0, 16);

  const doc = await PersonalApiKeyModel.create({
    guardianAccountId,
    userId,
    name,
    keyHash,
    keyPrefix,
  });

  return { key, id: doc._id.toString() };
}

/**
 * Validate an API key. Returns the associated account info or null.
 */
export async function validateApiKey(
  key: string
): Promise<{ userId: string; guardianAccountId: string } | null> {
  if (!key.startsWith("ks_")) return null;

  const keyHash = hashKey(key);
  const doc = await PersonalApiKeyModel.findOne({ keyHash });
  if (!doc) return null;

  // Update last used (fire and forget)
  PersonalApiKeyModel.updateOne({ _id: doc._id }, { lastUsedAt: new Date() }).catch(() => {});

  return {
    userId: doc.userId,
    guardianAccountId: doc.guardianAccountId,
  };
}

/**
 * List API keys for an account (returns metadata only, not the key itself).
 */
export async function listApiKeys(guardianAccountId: string) {
  return PersonalApiKeyModel.find({ guardianAccountId })
    .select("name keyPrefix lastUsedAt createdAt")
    .lean();
}

/**
 * Delete an API key.
 */
export async function deleteApiKey(id: string, guardianAccountId: string): Promise<boolean> {
  const result = await PersonalApiKeyModel.findOneAndDelete({ _id: id, guardianAccountId });
  return result !== null;
}

function hashKey(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}
