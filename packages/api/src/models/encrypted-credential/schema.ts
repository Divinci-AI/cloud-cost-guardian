/**
 * Encrypted Credential Storage
 *
 * Stores cloud provider API tokens encrypted with AES-256-GCM.
 * Uses per-credential salt and IV — identical pattern to BYOK encrypted keys.
 *
 * SECURITY:
 * - Credentials are encrypted at rest with GUARDIAN_MASTER_SECRET
 * - Decrypted only in-memory during monitoring checks
 * - Master key stored in Infisical/GCP Secret Manager (never in code)
 * - Minimum required permissions documented per provider
 */

import mongoose, { Schema, Document } from "mongoose";
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "crypto";
import type { ProviderId, DecryptedCredential } from "../../providers/types.js";

const ALGORITHM = "aes-256-gcm";
const SALT_LENGTH = 16;
const IV_LENGTH = 16;
const KEY_LENGTH = 32;

// ─── Encryption ─────────────────────────────────────────────────────────────

function getMasterKey(): string {
  const key = process.env.GUARDIAN_MASTER_SECRET;
  if (!key || key.length < 32) {
    throw new Error("GUARDIAN_MASTER_SECRET must be set (min 32 chars)");
  }
  return key;
}

function encrypt(plaintext: string): { encrypted: string; iv: string; authTag: string; salt: string } {
  const masterKey = getMasterKey();
  const salt = randomBytes(SALT_LENGTH);
  const iv = randomBytes(IV_LENGTH);
  const key = scryptSync(masterKey, salt, KEY_LENGTH, { N: 32768, r: 8, p: 1 });
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return {
    encrypted: encrypted.toString("base64"),
    iv: iv.toString("base64"),
    authTag: authTag.toString("base64"),
    salt: salt.toString("base64"),
  };
}

function decrypt(data: { encrypted: string; iv: string; authTag: string; salt: string }): string {
  const masterKey = getMasterKey();
  const salt = Buffer.from(data.salt, "base64");
  const iv = Buffer.from(data.iv, "base64");
  const authTag = Buffer.from(data.authTag, "base64");
  const encrypted = Buffer.from(data.encrypted, "base64");
  const key = scryptSync(masterKey, salt, KEY_LENGTH, { N: 32768, r: 8, p: 1 });
  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);
  const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
  return decrypted.toString("utf8");
}

// ─── Model ──────────────────────────────────────────────────────────────────

export interface EncryptedCredentialProps {
  guardianAccountId: string;
  provider: ProviderId;
  encrypted: string;
  iv: string;
  authTag: string;
  salt: string;
  keyPreview: string;  // last 4 chars for identification
  createdAt: number;
}

export type EncryptedCredentialDocument = EncryptedCredentialProps & Document;

const encryptedCredentialSchema = new Schema<EncryptedCredentialDocument>({
  guardianAccountId: { type: String, required: true, index: true },
  provider: { type: String, required: true, enum: ["cloudflare", "gcp", "aws"] },
  encrypted: { type: String, required: true },
  iv: { type: String, required: true },
  authTag: { type: String, required: true },
  salt: { type: String, required: true },
  keyPreview: { type: String, required: true },
  createdAt: { type: Number, default: () => Date.now() },
});

export const EncryptedCredentialModel =
  (mongoose.models?.["GuardianEncryptedCredential"] as mongoose.Model<EncryptedCredentialDocument>) ||
  mongoose.model<EncryptedCredentialDocument>("GuardianEncryptedCredential", encryptedCredentialSchema);

// ─── Static Helpers ─────────────────────────────────────────────────────────

/**
 * Store a credential encrypted at rest.
 * Returns the document ID for linking to a CloudAccount.
 */
export async function storeCredential(
  guardianAccountId: string,
  provider: ProviderId,
  credential: DecryptedCredential
): Promise<string> {
  const plaintext = JSON.stringify(credential);

  // Get preview (last 4 chars of the primary token)
  const primaryKey = credential.apiToken || credential.projectId || "";
  const keyPreview = primaryKey.length >= 4 ? primaryKey.slice(-4) : "****";

  const encryptedData = encrypt(plaintext);

  const doc = await EncryptedCredentialModel.create({
    guardianAccountId,
    provider,
    ...encryptedData,
    keyPreview,
  });

  return doc._id.toString();
}

/**
 * Retrieve and decrypt a credential.
 */
export async function getCredential(credentialId: string): Promise<DecryptedCredential | null> {
  const doc = await EncryptedCredentialModel.findById(credentialId);
  if (!doc) return null;

  const plaintext = decrypt({
    encrypted: doc.encrypted,
    iv: doc.iv,
    authTag: doc.authTag,
    salt: doc.salt,
  });

  return JSON.parse(plaintext) as DecryptedCredential;
}

/**
 * Delete a credential permanently.
 */
export async function deleteCredential(credentialId: string): Promise<boolean> {
  const result = await EncryptedCredentialModel.findByIdAndDelete(credentialId);
  return result !== null;
}
