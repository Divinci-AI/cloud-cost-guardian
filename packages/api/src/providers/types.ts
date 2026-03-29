/**
 * Cloud Provider Interface & Security Types
 *
 * Abstracts the differences between Cloudflare, GCP, and future providers
 * behind a common interface. Supports both cost and security kill switches.
 */

export type ProviderId = "cloudflare" | "gcp" | "aws" | "runpod" | "redis" | "mongodb"
  | "openai" | "anthropic" | "xai" | "replicate" | "snowflake" | "vercel" | "datadog";

export type RedisSubType = "redis-cloud" | "elasticache" | "self-hosted";
export type MongoDBSubType = "atlas" | "self-hosted";

// ─── Usage & Cost Monitoring ────────────────────────────────────────────────

export interface UsageMetric {
  name: string;
  value: number;
  unit: string;
  thresholdKey: string;
}

export interface ServiceUsage {
  serviceName: string;
  metrics: UsageMetric[];
  estimatedDailyCostUSD: number;
}

export interface UsageResult {
  provider: ProviderId;
  accountId: string;
  checkedAt: number;
  services: ServiceUsage[];
  totalEstimatedDailyCostUSD: number;
  violations: Violation[];
  securityEvents: SecurityEvent[];
}

export interface Violation {
  serviceName: string;
  metricName: string;
  currentValue: number;
  threshold: number;
  unit: string;
  severity: "warning" | "critical";
}

// ─── Security Monitoring ────────────────────────────────────────────────────

export type SecurityEventType =
  | "request_spike"          // Sudden traffic surge (potential DDoS)
  | "error_spike"            // Burst of 4xx/5xx errors (brute force or attack)
  | "egress_anomaly"         // Unusual outbound data volume (data exfiltration)
  | "auth_failure_spike"     // Mass auth failures (credential stuffing)
  | "new_outbound_domain"    // Worker contacting unknown domain (compromise)
  | "cpu_anomaly"            // Sustained high CPU (crypto mining)
  | "latency_spike"          // Response time degradation (overload)
  | "config_drift"           // Service config changed outside IaC
  | "credential_exposure"    // Token used from unexpected IP/region
  | "rate_limit_breach"      // Rate limiter overwhelmed
  | "gpu_runaway"            // GPU instances left running (GCP/AWS)
  | "lambda_loop"            // Lambda/Cloud Function recursive invocation (AWS/GCP)
  | "storage_exfiltration"   // Mass S3/GCS/R2 download
  | "instance_count_spike";  // Sudden increase in compute instances

export interface SecurityEvent {
  type: SecurityEventType;
  severity: "info" | "warning" | "critical";
  serviceName: string;
  description: string;
  metrics: Record<string, number>;
  detectedAt: number;
}

export type KillAction =
  | "disconnect"          // Remove routes (reversible, CF)
  | "delete"              // Delete worker/resource (nuclear, CF/GCP/AWS)
  | "scale-down"          // Set max instances to 0 (reversible, GCP Cloud Run/Functions)
  | "block-traffic"       // Enable WAF block rule
  | "rotate-creds"        // Rotate API keys/tokens
  | "snapshot"            // Capture forensic snapshot only (no kill)
  | "isolate"             // Network-level isolation
  | "pause-zone"          // Pause entire Cloudflare zone proxy (reversible, CF)
  | "stop-instances"      // Stop compute instances — disks persist (reversible, GCP/AWS)
  | "terminate-instances" // Terminate instances — irreversible (AWS)
  | "set-quota"           // Set service quota to 0 — non-destructive (GCP BigQuery)
  | "disable-service"     // Disable a cloud API via Service Usage (GCP)
  | "disable-billing"     // Detach billing account from project (nuclear, GCP)
  | "throttle-lambda"     // Set Lambda reserved concurrency to 0 (reversible, AWS)
  | "deny-scp"            // Apply deny-all Service Control Policy (nuclear, AWS)
  | "deny-bucket-policy" // Apply deny-all S3 bucket policy (reversible, AWS)
  | "stop-pod"           // Stop a GPU pod — disk persists (reversible, RunPod)
  | "terminate-pod"      // Terminate a GPU pod — irreversible (RunPod)
  | "flush-redis"        // FLUSHALL — clear all data (destructive, Redis)
  | "pause-cluster"      // Pause managed cluster (reversible, Redis Cloud/Atlas)
  | "kill-connections";  // Kill all active connections (Redis/MongoDB)

export interface ActionResult {
  success: boolean;
  action: KillAction;
  serviceName: string;
  details: string;
  forensicSnapshotId?: string;
}

export interface ValidationResult {
  valid: boolean;
  accountId?: string;
  accountName?: string;
  error?: string;
  permissions?: string[];
}

export interface ThresholdConfig {
  // ─── Cloudflare Cost Thresholds ─────────────────────────────────────────────
  doRequestsPerDay?: number;
  doWalltimeHoursPerDay?: number;
  workerRequestsPerDay?: number;
  r2OpsPerDay?: number;              // R2 Class A+B operations
  r2StorageGB?: number;              // R2 total storage
  d1RowsReadPerDay?: number;         // D1 rows read (billed per scan)
  d1RowsWrittenPerDay?: number;      // D1 rows written
  queueOpsPerDay?: number;           // Queues operations (64KB chunks)
  streamMinutesPerDay?: number;      // Stream minutes stored/delivered
  argoGBPerDay?: number;             // Argo Smart Routing GB routed
  pagesRequestsPerDay?: number;      // Pages Functions requests

  // ─── GCP Cost Thresholds ────────────────────────────────────────────────────
  gcpBudgetPercent?: number;
  computeInstanceCount?: number;           // Max Compute Engine instances
  computeGPUCount?: number;                // Max GPU accelerators
  gkeNodeCount?: number;                   // Max GKE nodes across all pools
  bigqueryBytesPerDay?: number;            // Max BigQuery bytes scanned/day
  cloudFunctionInvocationsPerDay?: number; // Max Cloud Function invocations
  gcsEgressGBPerDay?: number;              // Max Cloud Storage egress GB/day

  // ─── AWS Cost Thresholds ────────────────────────────────────────────────────
  ec2InstanceCount?: number;          // Max EC2 running instances
  ec2GPUInstanceCount?: number;       // Max GPU instances (p/g family)
  lambdaInvocationsPerDay?: number;   // Max Lambda invocations/day
  lambdaConcurrentExecutions?: number;// Max Lambda concurrent executions
  rdsInstanceCount?: number;          // Max RDS instances
  ecsTaskCount?: number;              // Max ECS running tasks
  eksNodeCount?: number;              // Max EKS nodes across all groups
  s3RequestsPerDay?: number;          // Max S3 requests/day
  s3EgressGBPerDay?: number;          // Max S3 egress GB/day
  sagemakerEndpointCount?: number;    // Max SageMaker endpoint instances
  awsDailyCostUSD?: number;           // Max daily AWS spend

  // ─── RunPod Cost Thresholds ──────────────────────────────────────────────────
  runpodGPUPodCount?: number;           // Max running GPU pods (on-demand + spot)
  runpodSpotPodCount?: number;          // Max spot/preemptible pods
  runpodServerlessWorkers?: number;     // Max active serverless workers
  runpodServerlessRequestsPerDay?: number; // Max serverless requests/day
  runpodNetworkVolumeGB?: number;       // Max network volume storage GB
  runpodDailyCostUSD?: number;          // Max daily RunPod spend

  // ─── Redis Thresholds ────────────────────────────────────────────────────────
  redisMemoryUsageMB?: number;             // Max Redis memory usage (MB)
  redisConnectedClients?: number;          // Max connected clients
  redisCommandsPerSec?: number;            // Max commands/sec
  redisEvictedKeysPerDay?: number;         // Max evicted keys/day (memory pressure)
  redisDailyCostUSD?: number;              // Max daily Redis spend

  // ─── MongoDB Thresholds ─────────────────────────────────────────────────────
  mongodbStorageSizeGB?: number;           // Max data + index storage (GB)
  mongodbActiveConnections?: number;       // Max active connections
  mongodbOpsPerSec?: number;               // Max operations/sec
  mongodbCollectionCount?: number;         // Max collections (sprawl detection)
  mongodbDailyCostUSD?: number;            // Max daily MongoDB spend

  // ─── OpenAI Thresholds ───────────────────────────────────────────────────────
  openaiTokensPerDay?: number;             // Max tokens (input + output) per day
  openaiRequestsPerDay?: number;           // Max API requests per day
  openaiDailyCostUSD?: number;             // Max daily OpenAI spend

  // ─── Anthropic Thresholds ───────────────────────────────────────────────────
  anthropicTokensPerDay?: number;          // Max tokens per day
  anthropicDailyCostUSD?: number;          // Max daily Anthropic spend

  // ─── xAI Thresholds ────────────────────────────────────────────────────────
  xaiTokensPerDay?: number;               // Max tokens per day
  xaiDailyCostUSD?: number;               // Max daily xAI spend

  // ─── Replicate Thresholds ──────────────────────────────────────────────────
  replicatePredictionsPerDay?: number;     // Max predictions per day
  replicateGpuHoursPerDay?: number;        // Max GPU hours per day
  replicateDailyCostUSD?: number;          // Max daily Replicate spend

  // ─── Snowflake Thresholds ──────────────────────────────────────────────────
  snowflakeCreditsPerDay?: number;         // Max Snowflake credits per day
  snowflakeWarehouseCount?: number;        // Max active warehouses
  snowflakeDailyCostUSD?: number;          // Max daily Snowflake spend

  // ─── Vercel Thresholds ─────────────────────────────────────────────────────
  vercelFunctionInvocationsPerDay?: number;// Max serverless function invocations
  vercelBandwidthGBPerDay?: number;        // Max bandwidth GB per day
  vercelDailyCostUSD?: number;             // Max daily Vercel spend

  // ─── Datadog Thresholds ────────────────────────────────────────────────────
  datadogHostCount?: number;               // Max monitored hosts
  datadogLogIngestGBPerDay?: number;       // Max log ingestion GB per day
  datadogDailyCostUSD?: number;            // Max daily Datadog spend

  // ─── Shared Thresholds ──────────────────────────────────────────────────────
  monthlySpendLimitUSD?: number;
  requestsPerMinute?: number;       // DDoS detection
  errorRatePercent?: number;        // Error spike detection (% of total)
  authFailuresPerMinute?: number;   // Brute force detection
  latencyP99Ms?: number;            // Overload detection
  egressGBPerHour?: number;         // Exfiltration detection
  [key: string]: number | undefined;
}

export interface DecryptedCredential {
  provider: ProviderId;
  // Cloudflare
  apiToken?: string;
  accountId?: string;
  // GCP
  serviceAccountJson?: string;
  projectId?: string;
  region?: string;
  // AWS
  awsAccessKeyId?: string;
  awsSecretAccessKey?: string;
  awsRegion?: string;
  awsRoleArn?: string;  // Optional: for cross-account assume-role
  // RunPod
  runpodApiKey?: string;
  // Redis
  redisSubType?: RedisSubType;
  redisCloudAccountKey?: string;
  redisCloudSecretKey?: string;
  redisCloudSubscriptionId?: string;
  redisUrl?: string;              // redis://user:pass@host:port (self-hosted)
  redisTlsEnabled?: boolean;
  elasticacheClusterId?: string;  // ElastiCache reuses awsAccessKeyId/awsSecretAccessKey/awsRegion
  // MongoDB
  mongodbSubType?: MongoDBSubType;
  atlasPublicKey?: string;
  atlasPrivateKey?: string;
  atlasProjectId?: string;
  atlasClusterName?: string;
  mongodbUri?: string;            // mongodb+srv://... (self-hosted)
  mongodbDatabaseName?: string;
  // OpenAI
  openaiApiKey?: string;
  openaiOrgId?: string;
  // Anthropic
  anthropicApiKey?: string;
  anthropicWorkspaceId?: string;
  // xAI (Grok)
  xaiApiKey?: string;
  // Replicate
  replicateApiToken?: string;
  // Snowflake
  snowflakeAccountName?: string;  // e.g., xy12345.us-east-1
  snowflakeUsername?: string;
  snowflakePassword?: string;
  snowflakeWarehouseName?: string;
  snowflakeRole?: string;
  // Vercel
  vercelApiToken?: string;
  vercelTeamId?: string;
  // Datadog
  datadogApiKey?: string;
  datadogApplicationKey?: string;
  datadogSite?: "us" | "eu";
}

// ─── Forensic Snapshot ──────────────────────────────────────────────────────

export interface ForensicSnapshot {
  id: string;
  incidentId: string;
  capturedAt: number;
  provider: ProviderId;
  serviceName: string;
  trigger: string;
  data: {
    serviceConfig?: Record<string, unknown>;
    recentLogs?: string[];
    recentMetrics?: Record<string, number[]>;
    activeConnections?: number;
    environmentVariables?: string[];  // Names only, not values
    networkRules?: Record<string, unknown>;
    databaseSnapshot?: { snapshotId: string; status: string };
  };
  integrityHash: string;
}

// ─── Kill Switch Rule Engine ────────────────────────────────────────────────

export type RuleTrigger = "cost" | "security" | "custom" | "api" | "agent";

export interface KillSwitchRule {
  id: string;
  name: string;
  enabled: boolean;
  trigger: RuleTrigger;
  conditions: RuleCondition[];
  conditionLogic: "all" | "any";  // AND or OR
  actions: RuleAction[];
  cooldownMinutes: number;        // Don't re-fire within this window
  lastFiredAt?: number;
  forensicsEnabled: boolean;      // Capture snapshot when rule fires
}

export interface RuleCondition {
  metric: string;           // e.g., "doRequestsPerDay", "errorRatePercent", "requestsPerMinute"
  operator: "gt" | "lt" | "gte" | "lte" | "eq";
  value: number;
  windowMinutes?: number;   // Evaluation window (e.g., last 5 minutes)
}

export interface RuleAction {
  type: KillAction;
  target?: string;          // Specific service, or "*" for all non-protected
  delay?: number;           // Seconds to wait before executing (grace period)
  requireApproval?: boolean; // Pause and wait for human approval
}

// ─── Provider Interface ─────────────────────────────────────────────────────

export interface CloudProvider {
  id: ProviderId;
  name: string;

  /** Check current usage and security metrics against thresholds */
  checkUsage(
    credential: DecryptedCredential,
    thresholds: ThresholdConfig
  ): Promise<UsageResult>;

  /** Execute kill switch action on a specific service */
  executeKillSwitch(
    credential: DecryptedCredential,
    serviceName: string,
    action: KillAction
  ): Promise<ActionResult>;

  /** Validate that credentials work and have required permissions */
  validateCredential(
    credential: DecryptedCredential
  ): Promise<ValidationResult>;

  /** Capture a forensic snapshot of a service's current state */
  captureForensicSnapshot?(
    credential: DecryptedCredential,
    serviceName: string,
    trigger: string
  ): Promise<ForensicSnapshot>;

  /** Return sensible default thresholds for new accounts */
  getDefaultThresholds(): ThresholdConfig;
}
