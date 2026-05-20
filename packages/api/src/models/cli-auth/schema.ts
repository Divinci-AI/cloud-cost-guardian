/**
 * CLI Auth Code Model
 *
 * Short-lived codes that back the browser-based device-flow login for the CLI.
 * Lifecycle: pending → (approved | denied | expired). After the CLI polls once
 * for an approved code, the plaintext key is cleared so the code is one-shot.
 */

import mongoose, { Schema, Document } from "mongoose";
import { randomBytes } from "crypto";
import { createApiKey } from "../api-key/schema.js";

export type CliAuthStatus = "pending" | "approved" | "denied" | "expired";

export interface ICliAuthCode extends Document {
  code: string;
  status: CliAuthStatus;
  apiKeyId?: string;
  apiKeyPlaintext?: string;
  userId?: string;
  guardianAccountId?: string;
  hostname?: string;
  cliVersion?: string;
  expiresAt: Date;
  createdAt: Date;
  approvedAt?: Date;
  polledOnceAt?: Date;
}

const CliAuthCodeSchema = new Schema<ICliAuthCode>({
  code: { type: String, required: true, unique: true, index: true },
  status: { type: String, required: true, enum: ["pending", "approved", "denied", "expired"], default: "pending" },
  apiKeyId: { type: String, default: null },
  apiKeyPlaintext: { type: String, default: null },
  userId: { type: String, default: null },
  guardianAccountId: { type: String, default: null },
  hostname: { type: String, default: null },
  cliVersion: { type: String, default: null },
  expiresAt: { type: Date, required: true },
  createdAt: { type: Date, default: Date.now },
  approvedAt: { type: Date, default: null },
  polledOnceAt: { type: Date, default: null },
});

// TTL: Mongo auto-deletes docs once expiresAt passes (sweeper runs every ~60s).
CliAuthCodeSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const CliAuthCodeModel = mongoose.model("CliAuthCode", CliAuthCodeSchema);

// No ambiguous chars (0/O/1/I/L excluded) so users can read codes off a CLI.
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const CODE_TTL_SECONDS = 10 * 60;

function generateCode(): string {
  const bytes = randomBytes(8);
  let out = "";
  for (let i = 0; i < 8; i++) {
    out += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  }
  return `${out.slice(0, 4)}-${out.slice(4)}`;
}

export async function createCliCode(input: {
  hostname?: string;
  cliVersion?: string;
}): Promise<{ code: string; expiresAt: Date }> {
  // Retry on the (vanishingly unlikely) collision with another live code.
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = generateCode();
    const expiresAt = new Date(Date.now() + CODE_TTL_SECONDS * 1000);
    try {
      await CliAuthCodeModel.create({
        code,
        status: "pending",
        hostname: input.hostname,
        cliVersion: input.cliVersion,
        expiresAt,
      });
      return { code, expiresAt };
    } catch (err: any) {
      if (err.code !== 11000) throw err; // 11000 = duplicate key
    }
  }
  throw new Error("Failed to generate unique CLI auth code");
}

export async function approveCliCode(
  code: string,
  userId: string,
  guardianAccountId: string,
  keyName: string,
): Promise<{ apiKeyId: string } | { error: "not_found" | "expired" | "not_pending" }> {
  const doc = await CliAuthCodeModel.findOne({ code });
  if (!doc) return { error: "not_found" };
  if (doc.expiresAt.getTime() < Date.now()) return { error: "expired" };
  if (doc.status !== "pending") return { error: "not_pending" };

  const { id: apiKeyId, key: apiKeyPlaintext } = await createApiKey(guardianAccountId, userId, keyName);

  doc.status = "approved";
  doc.userId = userId;
  doc.guardianAccountId = guardianAccountId;
  doc.apiKeyId = apiKeyId;
  doc.apiKeyPlaintext = apiKeyPlaintext;
  doc.approvedAt = new Date();
  await doc.save();

  return { apiKeyId };
}

export async function denyCliCode(code: string): Promise<boolean> {
  const result = await CliAuthCodeModel.updateOne(
    { code, status: "pending" },
    { $set: { status: "denied" } },
  );
  return result.modifiedCount > 0;
}

type PollResult =
  | { status: "pending" }
  | { status: "approved"; apiKey: string }
  | { status: "denied" }
  | { status: "expired" }
  | { status: "consumed" }
  | { status: "unknown" };

export async function consumeCliCode(code: string): Promise<PollResult> {
  // Atomic claim: only the first poll that sees status=approved AND polledOnceAt=null
  // wins the plaintext key. Subsequent polls fall through to the "consumed" branch.
  const claimed = await CliAuthCodeModel.findOneAndUpdate(
    { code, status: "approved", polledOnceAt: null },
    { $set: { polledOnceAt: new Date() } },
    { new: false },
  );

  if (claimed?.apiKeyPlaintext) {
    const apiKey = claimed.apiKeyPlaintext;
    // Scrub the plaintext from storage now that we've handed it off.
    await CliAuthCodeModel.updateOne(
      { _id: claimed._id },
      { $unset: { apiKeyPlaintext: "" } },
    );
    return { status: "approved", apiKey };
  }

  const doc = await CliAuthCodeModel.findOne({ code });
  if (!doc) return { status: "unknown" };
  if (doc.expiresAt.getTime() < Date.now()) return { status: "expired" };
  if (doc.status === "denied") return { status: "denied" };
  if (doc.status === "approved" && doc.polledOnceAt) return { status: "consumed" };
  return { status: "pending" };
}
