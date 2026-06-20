/**
 * Cloud Account types
 */

import type { ProviderId } from "./common.js";

export interface ThresholdConfig {
  [key: string]: number | undefined;
}

export interface CloudAccount {
  id: string;
  provider: ProviderId;
  name: string;
  providerAccountId: string;
  status: "active" | "paused" | "disconnected";
  thresholds: ThresholdConfig;
  protectedServices: string[];
  autoDisconnect: boolean;
  autoDelete?: boolean;
  /** Violation categories that fire an auto-kill (default ["cost"]). */
  autoKillCategories?: string[];
  /** When true (default), destructive managed-DB actions (pause/delete) are never auto-executed. */
  productionProtected?: boolean;
  lastCheckAt?: string;
  lastCheckStatus?: string;
  lastViolations?: Violation[];
}

export interface Violation {
  serviceName: string;
  metricName: string;
  currentValue: number;
  threshold: number;
  unit: string;
  severity: "warning" | "critical";
}

export interface CreateAccountInput {
  provider: ProviderId;
  name: string;
  credential: CloudflareCredential | GcpCredential | AwsCredential | RunPodCredential | RedisCredential | MongoDBCredential | Neo4jCredential;
}

export interface CloudflareCredential {
  apiToken: string;
  accountId: string;
}

export interface GcpCredential {
  serviceAccountJson: string;
  projectId: string;
}

export interface AwsCredential {
  awsAccessKeyId: string;
  awsSecretAccessKey: string;
  awsRegion: string;
  awsRoleArn?: string;
}

export interface RunPodCredential {
  runpodApiKey: string;
}

export interface RedisCredential {
  redisSubType: "redis-cloud" | "elasticache" | "self-hosted";
  redisCloudAccountKey?: string;
  redisCloudSecretKey?: string;
  redisCloudSubscriptionId?: string;
  redisUrl?: string;
  redisTlsEnabled?: boolean;
  elasticacheClusterId?: string;
  awsAccessKeyId?: string;
  awsSecretAccessKey?: string;
  awsRegion?: string;
}

export interface MongoDBCredential {
  mongodbSubType: "atlas" | "self-hosted";
  atlasPublicKey?: string;
  atlasPrivateKey?: string;
  atlasProjectId?: string;
  atlasClusterName?: string;
  mongodbUri?: string;
  mongodbDatabaseName?: string;
}

export interface Neo4jCredential {
  neo4jClientId: string;
  neo4jClientSecret: string;
  neo4jInstanceId?: string;
}

export interface UpdateAccountInput {
  thresholds?: ThresholdConfig;
  protectedServices?: string[];
  autoDisconnect?: boolean;
  autoDelete?: boolean;
  autoKillCategories?: string[];
  productionProtected?: boolean;
  name?: string;
  status?: "active" | "paused";
}

export interface UsageHistory {
  usage: unknown[];
  days: number;
}
