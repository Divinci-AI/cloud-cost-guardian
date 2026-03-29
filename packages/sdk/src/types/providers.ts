/**
 * Provider types
 */

import type { ProviderId } from "./common.js";

export interface Provider {
  id: ProviderId;
  name: string;
  defaultThresholds: Record<string, number>;
}

export interface ValidationResult {
  valid: boolean;
  accountId?: string;
  accountName?: string;
  error?: string;
}

export interface ValidateCredentialInput {
  [key: string]: unknown;
}
