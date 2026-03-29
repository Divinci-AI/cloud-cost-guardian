/**
 * Monitoring types
 */

import type { Violation } from "./accounts.js";

export interface SecurityEvent {
  type: string;
  severity: "info" | "warning" | "critical";
  serviceName: string;
  description: string;
  metrics: Record<string, number>;
  detectedAt: number;
}

export interface CheckResult {
  cloudAccountId?: string;
  provider?: string;
  status: string;
  violations?: Violation[];
  securityEvents?: SecurityEvent[];
  timestamp?: string;
}

export interface CheckAllResult {
  status: "checked";
  results: CheckResult[];
  timestamp: string;
}
