/**
 * Database Kill Switch types
 */

export type DatabaseProvider = "mongodb-atlas" | "cloud-sql-postgres" | "redis";

export interface StoreDatabaseCredentialInput {
  provider: DatabaseProvider;
  [key: string]: unknown;
}

export interface KillSequenceStep {
  action: string;
  status: string;
  result?: string;
  timestamp?: number;
}

export interface KillSequence {
  id: string;
  status: "initiated" | "in_progress" | "completed" | "aborted";
  currentStep?: number;
  snapshotId?: string;
  snapshotVerified?: boolean;
  steps: KillSequenceStep[];
}

export interface InitiateKillInput {
  credentialId: string;
  trigger: string;
  actions?: { type: string; target?: string }[];
}

export interface AdvanceKillInput {
  credentialId: string;
  humanApproval?: boolean;
}
