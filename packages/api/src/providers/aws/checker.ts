/**
 * AWS Provider
 *
 * Monitors EC2, Lambda, RDS, ECS, EKS, SageMaker, and costs via Cost Explorer.
 * Kill actions include instance stop/terminate, Lambda throttling, ECS/EKS scaling,
 * S3 bucket policy deny, and SCP application.
 *
 * Uses AWS SDK v3 modular clients for minimal bundle size.
 */

import type {
  CloudProvider,
  DecryptedCredential,
  ThresholdConfig,
  UsageResult,
  ActionResult,
  ValidationResult,
  ServiceUsage,
  Violation,
  SecurityEvent,
  KillAction,
} from "../types.js";

// ─── AWS SDK Imports ────────────────────────────────────────────────────────

import { STSClient, GetCallerIdentityCommand, AssumeRoleCommand } from "@aws-sdk/client-sts";
import { EC2Client, DescribeInstancesCommand, StopInstancesCommand, TerminateInstancesCommand } from "@aws-sdk/client-ec2";
import { LambdaClient, ListFunctionsCommand, GetAccountSettingsCommand, PutFunctionConcurrencyCommand } from "@aws-sdk/client-lambda";
import { RDSClient, DescribeDBInstancesCommand, StopDBInstanceCommand } from "@aws-sdk/client-rds";
import { ECSClient, ListClustersCommand, ListServicesCommand, DescribeServicesCommand, UpdateServiceCommand } from "@aws-sdk/client-ecs";
import { EKSClient, ListClustersCommand as EKSListClustersCommand, ListNodegroupsCommand, DescribeNodegroupCommand, UpdateNodegroupConfigCommand } from "@aws-sdk/client-eks";
import { SageMakerClient, ListEndpointsCommand, DeleteEndpointCommand } from "@aws-sdk/client-sagemaker";
import { CostExplorerClient, GetCostAndUsageCommand } from "@aws-sdk/client-cost-explorer";
import { S3Client, PutBucketPolicyCommand } from "@aws-sdk/client-s3";

// ─── Credential Helpers ─────────────────────────────────────────────────────

interface AWSCreds {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  region: string;
}

async function getAWSCredentials(credential: DecryptedCredential): Promise<AWSCreds> {
  const region = credential.awsRegion || "us-east-1";

  if (!credential.awsAccessKeyId || !credential.awsSecretAccessKey) {
    throw new Error("Missing AWS access key ID or secret access key");
  }

  // If role ARN is specified, assume the role
  if (credential.awsRoleArn) {
    const stsClient = new STSClient({
      region,
      credentials: {
        accessKeyId: credential.awsAccessKeyId,
        secretAccessKey: credential.awsSecretAccessKey,
      },
    });

    const response = await stsClient.send(new AssumeRoleCommand({
      RoleArn: credential.awsRoleArn,
      RoleSessionName: "kill-switch-session",
      DurationSeconds: 3600,
    }));

    if (!response.Credentials) {
      throw new Error("Failed to assume role: no credentials returned");
    }

    return {
      accessKeyId: response.Credentials.AccessKeyId!,
      secretAccessKey: response.Credentials.SecretAccessKey!,
      sessionToken: response.Credentials.SessionToken,
      region,
    };
  }

  return {
    accessKeyId: credential.awsAccessKeyId,
    secretAccessKey: credential.awsSecretAccessKey,
    region,
  };
}

function makeCredentials(creds: AWSCreds) {
  return {
    accessKeyId: creds.accessKeyId,
    secretAccessKey: creds.secretAccessKey,
    ...(creds.sessionToken ? { sessionToken: creds.sessionToken } : {}),
  };
}

// GPU instance families
const GPU_FAMILIES = ["p2", "p3", "p4", "p4d", "p5", "g3", "g4", "g4dn", "g5", "g5g", "g6", "inf1", "inf2", "trn1", "dl1"];

function isGPUInstance(instanceType: string): boolean {
  const family = instanceType.split(".")[0];
  return GPU_FAMILIES.includes(family);
}

// ─── Service Query Functions ────────────────────────────────────────────────

async function listEC2Instances(creds: AWSCreds): Promise<ServiceUsage[]> {
  const client = new EC2Client({ region: creds.region, credentials: makeCredentials(creds) });
  const response = await client.send(new DescribeInstancesCommand({
    Filters: [{ Name: "instance-state-name", Values: ["running"] }],
  }));

  const services: ServiceUsage[] = [];
  let totalInstances = 0;
  let totalGPUs = 0;

  for (const reservation of response.Reservations || []) {
    for (const instance of reservation.Instances || []) {
      totalInstances++;
      const instanceType = instance.InstanceType || "unknown";
      const isGPU = isGPUInstance(instanceType);
      if (isGPU) totalGPUs++;

      // Rough cost estimate
      const nameTag = instance.Tags?.find(t => t.Key === "Name")?.Value || instance.InstanceId;
      const dailyCost = isGPU ? 59.52 : 1.14; // Very rough

      services.push({
        serviceName: `ec2:${instance.InstanceId}`,
        metrics: [
          { name: `EC2 ${instanceType}`, value: 1, unit: "instances", thresholdKey: "ec2InstanceCount" },
          ...(isGPU ? [{ name: "GPU Instance", value: 1, unit: "instances", thresholdKey: "ec2GPUInstanceCount" }] : []),
        ],
        estimatedDailyCostUSD: dailyCost,
      });
    }
  }

  // Aggregate metric
  if (totalInstances > 0) {
    services.unshift({
      serviceName: "ec2:all-instances",
      metrics: [
        { name: "Total Running Instances", value: totalInstances, unit: "instances", thresholdKey: "ec2InstanceCount" },
        { name: "Total GPU Instances", value: totalGPUs, unit: "instances", thresholdKey: "ec2GPUInstanceCount" },
      ],
      estimatedDailyCostUSD: 0,
    });
  }

  return services;
}

async function listLambdaFunctions(creds: AWSCreds): Promise<ServiceUsage[]> {
  const client = new LambdaClient({ region: creds.region, credentials: makeCredentials(creds) });

  const [functionsRes, settingsRes] = await Promise.all([
    client.send(new ListFunctionsCommand({})),
    client.send(new GetAccountSettingsCommand({})),
  ]);

  const functions = functionsRes.Functions || [];

  // Per-function: report reserved concurrency if set, otherwise just list the function
  const services: ServiceUsage[] = functions.map(fn => ({
    serviceName: `lambda:${fn.FunctionName}`,
    metrics: [
      { name: "Lambda Function", value: 1, unit: "function", thresholdKey: "lambdaInvocationsPerDay" },
    ],
    estimatedDailyCostUSD: 0, // Invocation-based, not estimable from config alone
  }));

  // Account-level: total function count and concurrency limit
  const accountLimit = settingsRes.AccountLimit?.ConcurrentExecutions || 1000;
  const unreservedConcurrency = settingsRes.AccountLimit?.UnreservedConcurrentExecutions || accountLimit;
  services.unshift({
    serviceName: "lambda:account",
    metrics: [
      { name: "Total Lambda Functions", value: functions.length, unit: "functions", thresholdKey: "lambdaInvocationsPerDay" },
      { name: "Unreserved Concurrency", value: unreservedConcurrency, unit: "concurrent", thresholdKey: "lambdaConcurrentExecutions" },
    ],
    estimatedDailyCostUSD: 0,
  });

  return services;
}

async function listRDSInstances(creds: AWSCreds): Promise<ServiceUsage[]> {
  const client = new RDSClient({ region: creds.region, credentials: makeCredentials(creds) });
  const response = await client.send(new DescribeDBInstancesCommand({}));

  const instances = (response.DBInstances || []).filter(i => i.DBInstanceStatus === "available");

  const services: ServiceUsage[] = instances.map(instance => ({
    serviceName: `rds:${instance.DBInstanceIdentifier}`,
    metrics: [
      { name: `RDS ${instance.DBInstanceClass}`, value: 1, unit: "instances", thresholdKey: "rdsInstanceCount" },
    ],
    estimatedDailyCostUSD: 2.00, // Rough estimate
  }));

  if (instances.length > 0) {
    services.unshift({
      serviceName: "rds:all-instances",
      metrics: [
        { name: "Total RDS Instances", value: instances.length, unit: "instances", thresholdKey: "rdsInstanceCount" },
      ],
      estimatedDailyCostUSD: 0,
    });
  }

  return services;
}

async function listECSServices(creds: AWSCreds): Promise<ServiceUsage[]> {
  const client = new ECSClient({ region: creds.region, credentials: makeCredentials(creds) });

  const clustersRes = await client.send(new ListClustersCommand({}));
  const services: ServiceUsage[] = [];
  let totalTasks = 0;

  for (const clusterArn of clustersRes.clusterArns || []) {
    const clusterName = clusterArn.split("/").pop()!;
    const servicesRes = await client.send(new ListServicesCommand({ cluster: clusterArn }));

    if (servicesRes.serviceArns?.length) {
      const descRes = await client.send(new DescribeServicesCommand({
        cluster: clusterArn,
        services: servicesRes.serviceArns,
      }));

      for (const svc of descRes.services || []) {
        const running = svc.runningCount || 0;
        totalTasks += running;
        services.push({
          serviceName: `ecs:${clusterName}/${svc.serviceName}`,
          metrics: [
            { name: "ECS Running Tasks", value: running, unit: "tasks", thresholdKey: "ecsTaskCount" },
          ],
          estimatedDailyCostUSD: running * 1.50, // Rough Fargate estimate
        });
      }
    }
  }

  if (totalTasks > 0) {
    services.unshift({
      serviceName: "ecs:all-tasks",
      metrics: [
        { name: "Total ECS Tasks", value: totalTasks, unit: "tasks", thresholdKey: "ecsTaskCount" },
      ],
      estimatedDailyCostUSD: 0,
    });
  }

  return services;
}

async function listEKSNodeGroups(creds: AWSCreds): Promise<ServiceUsage[]> {
  const client = new EKSClient({ region: creds.region, credentials: makeCredentials(creds) });

  const clustersRes = await client.send(new EKSListClustersCommand({}));
  const services: ServiceUsage[] = [];
  let totalNodes = 0;

  for (const clusterName of clustersRes.clusters || []) {
    const ngRes = await client.send(new ListNodegroupsCommand({ clusterName }));

    for (const ngName of ngRes.nodegroups || []) {
      const descRes = await client.send(new DescribeNodegroupCommand({ clusterName, nodegroupName: ngName }));
      const ng = descRes.nodegroup;
      const desiredSize = ng?.scalingConfig?.desiredSize || 0;
      totalNodes += desiredSize;

      services.push({
        serviceName: `eks:${clusterName}/${ngName}`,
        metrics: [
          { name: "EKS Nodes", value: desiredSize, unit: "nodes", thresholdKey: "eksNodeCount" },
        ],
        estimatedDailyCostUSD: desiredSize * 1.14,
      });
    }
  }

  if (totalNodes > 0) {
    services.unshift({
      serviceName: "eks:all-nodes",
      metrics: [
        { name: "Total EKS Nodes", value: totalNodes, unit: "nodes", thresholdKey: "eksNodeCount" },
      ],
      estimatedDailyCostUSD: 0,
    });
  }

  return services;
}

async function listSageMakerEndpoints(creds: AWSCreds): Promise<ServiceUsage[]> {
  const client = new SageMakerClient({ region: creds.region, credentials: makeCredentials(creds) });
  const response = await client.send(new ListEndpointsCommand({ StatusEquals: "InService" }));

  const endpoints = response.Endpoints || [];
  const services: ServiceUsage[] = endpoints.map(ep => ({
    serviceName: `sagemaker:${ep.EndpointName}`,
    metrics: [
      { name: "SageMaker Endpoint", value: 1, unit: "endpoints", thresholdKey: "sagemakerEndpointCount" },
    ],
    estimatedDailyCostUSD: 24.00, // ml.m5.xlarge ≈ $1.00/hr
  }));

  if (endpoints.length > 0) {
    services.unshift({
      serviceName: "sagemaker:all-endpoints",
      metrics: [
        { name: "Total SageMaker Endpoints", value: endpoints.length, unit: "endpoints", thresholdKey: "sagemakerEndpointCount" },
      ],
      estimatedDailyCostUSD: 0,
    });
  }

  return services;
}

async function queryCostExplorer(creds: AWSCreds): Promise<ServiceUsage[]> {
  const client = new CostExplorerClient({ region: "us-east-1", credentials: makeCredentials(creds) }); // Cost Explorer is global

  const now = new Date();
  const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const start = yesterday.toISOString().split("T")[0];
  const end = now.toISOString().split("T")[0];

  try {
    const response = await client.send(new GetCostAndUsageCommand({
      TimePeriod: { Start: start, End: end },
      Granularity: "DAILY",
      Metrics: ["UnblendedCost"],
      GroupBy: [{ Type: "DIMENSION", Key: "SERVICE" }],
    }));

    let totalCost = 0;
    const services: ServiceUsage[] = [];

    for (const result of response.ResultsByTime || []) {
      for (const group of result.Groups || []) {
        const serviceName = group.Keys?.[0] || "Unknown";
        const cost = parseFloat(group.Metrics?.UnblendedCost?.Amount || "0");
        totalCost += cost;
      }
    }

    services.push({
      serviceName: "cost:daily-total",
      metrics: [
        { name: "Daily AWS Cost", value: totalCost, unit: "USD", thresholdKey: "awsDailyCostUSD" },
      ],
      estimatedDailyCostUSD: totalCost,
    });

    return services;
  } catch {
    return [];
  }
}

// ─── Kill Switch Actions ────────────────────────────────────────────────────

async function stopEC2Instances(creds: AWSCreds, instanceIds: string[]): Promise<ActionResult> {
  const client = new EC2Client({ region: creds.region, credentials: makeCredentials(creds) });
  try {
    await client.send(new StopInstancesCommand({ InstanceIds: instanceIds }));
    return {
      success: true,
      action: "stop-instances",
      serviceName: `ec2:${instanceIds.join(",")}`,
      details: `Stopped ${instanceIds.length} EC2 instance(s): ${instanceIds.join(", ")}`,
    };
  } catch (e: any) {
    return { success: false, action: "stop-instances", serviceName: `ec2:${instanceIds[0]}`, details: `Failed: ${e.message}` };
  }
}

async function terminateEC2Instances(creds: AWSCreds, instanceIds: string[]): Promise<ActionResult> {
  const client = new EC2Client({ region: creds.region, credentials: makeCredentials(creds) });
  try {
    await client.send(new TerminateInstancesCommand({ InstanceIds: instanceIds }));
    return {
      success: true,
      action: "terminate-instances",
      serviceName: `ec2:${instanceIds.join(",")}`,
      details: `TERMINATED ${instanceIds.length} EC2 instance(s): ${instanceIds.join(", ")}`,
    };
  } catch (e: any) {
    return { success: false, action: "terminate-instances", serviceName: `ec2:${instanceIds[0]}`, details: `Failed: ${e.message}` };
  }
}

async function throttleLambda(creds: AWSCreds, functionName: string): Promise<ActionResult> {
  const client = new LambdaClient({ region: creds.region, credentials: makeCredentials(creds) });
  try {
    await client.send(new PutFunctionConcurrencyCommand({
      FunctionName: functionName,
      ReservedConcurrentExecutions: 0,
    }));
    return {
      success: true,
      action: "throttle-lambda",
      serviceName: `lambda:${functionName}`,
      details: `Throttled Lambda ${functionName} (concurrency set to 0)`,
    };
  } catch (e: any) {
    return { success: false, action: "throttle-lambda", serviceName: `lambda:${functionName}`, details: `Failed: ${e.message}` };
  }
}

async function stopRDSInstance(creds: AWSCreds, dbInstanceId: string): Promise<ActionResult> {
  const client = new RDSClient({ region: creds.region, credentials: makeCredentials(creds) });
  try {
    await client.send(new StopDBInstanceCommand({ DBInstanceIdentifier: dbInstanceId }));
    return {
      success: true,
      action: "stop-instances",
      serviceName: `rds:${dbInstanceId}`,
      details: `Stopped RDS instance ${dbInstanceId} (note: auto-restarts after 7 days)`,
    };
  } catch (e: any) {
    return { success: false, action: "stop-instances", serviceName: `rds:${dbInstanceId}`, details: `Failed: ${e.message}` };
  }
}

async function scaleECSService(creds: AWSCreds, cluster: string, serviceName: string): Promise<ActionResult> {
  const client = new ECSClient({ region: creds.region, credentials: makeCredentials(creds) });
  try {
    await client.send(new UpdateServiceCommand({
      cluster,
      service: serviceName,
      desiredCount: 0,
    }));
    return {
      success: true,
      action: "scale-down",
      serviceName: `ecs:${cluster}/${serviceName}`,
      details: `Scaled ECS service ${serviceName} to 0 tasks`,
    };
  } catch (e: any) {
    return { success: false, action: "scale-down", serviceName: `ecs:${cluster}/${serviceName}`, details: `Failed: ${e.message}` };
  }
}

async function scaleEKSNodeGroup(creds: AWSCreds, cluster: string, nodeGroup: string): Promise<ActionResult> {
  const client = new EKSClient({ region: creds.region, credentials: makeCredentials(creds) });
  try {
    await client.send(new UpdateNodegroupConfigCommand({
      clusterName: cluster,
      nodegroupName: nodeGroup,
      scalingConfig: { minSize: 0, maxSize: 0, desiredSize: 0 },
    }));
    return {
      success: true,
      action: "scale-down",
      serviceName: `eks:${cluster}/${nodeGroup}`,
      details: `Scaled EKS node group ${nodeGroup} to 0`,
    };
  } catch (e: any) {
    return { success: false, action: "scale-down", serviceName: `eks:${cluster}/${nodeGroup}`, details: `Failed: ${e.message}` };
  }
}

async function denyS3BucketPolicy(creds: AWSCreds, bucketName: string): Promise<ActionResult> {
  const client = new S3Client({ region: creds.region, credentials: makeCredentials(creds) });
  const denyPolicy = JSON.stringify({
    Version: "2012-10-17",
    Statement: [{
      Sid: "KillSwitchDenyAll",
      Effect: "Deny",
      Principal: "*",
      Action: "s3:*",
      Resource: [`arn:aws:s3:::${bucketName}`, `arn:aws:s3:::${bucketName}/*`],
    }],
  });

  try {
    await client.send(new PutBucketPolicyCommand({ Bucket: bucketName, Policy: denyPolicy }));
    return {
      success: true,
      action: "deny-bucket-policy",
      serviceName: `s3:${bucketName}`,
      details: `Applied deny-all policy to S3 bucket ${bucketName}`,
    };
  } catch (e: any) {
    return { success: false, action: "deny-bucket-policy", serviceName: `s3:${bucketName}`, details: `Failed: ${e.message}` };
  }
}

async function deleteSageMakerEndpoint(creds: AWSCreds, endpointName: string): Promise<ActionResult> {
  const client = new SageMakerClient({ region: creds.region, credentials: makeCredentials(creds) });
  try {
    await client.send(new DeleteEndpointCommand({ EndpointName: endpointName }));
    return {
      success: true,
      action: "delete",
      serviceName: `sagemaker:${endpointName}`,
      details: `Deleted SageMaker endpoint ${endpointName}`,
    };
  } catch (e: any) {
    return { success: false, action: "delete", serviceName: `sagemaker:${endpointName}`, details: `Failed: ${e.message}` };
  }
}

// ─── Provider Implementation ────────────────────────────────────────────────

export const awsProvider: CloudProvider = {
  id: "aws",
  name: "Amazon Web Services",

  async checkUsage(credential, thresholds): Promise<UsageResult> {
    const creds = await getAWSCredentials(credential);

    const [ec2, lambda, rds, ecs, eks, sagemaker, costs] = await Promise.all([
      listEC2Instances(creds).catch(() => []),
      listLambdaFunctions(creds).catch(() => []),
      listRDSInstances(creds).catch(() => []),
      listECSServices(creds).catch(() => []),
      listEKSNodeGroups(creds).catch(() => []),
      listSageMakerEndpoints(creds).catch(() => []),
      queryCostExplorer(creds).catch(() => []),
    ]);

    const services = [...ec2, ...lambda, ...rds, ...ecs, ...eks, ...sagemaker, ...costs];
    const violations: Violation[] = [];

    for (const service of services) {
      for (const metric of service.metrics) {
        const threshold = thresholds[metric.thresholdKey];
        if (threshold !== undefined && metric.value > threshold) {
          violations.push({
            serviceName: service.serviceName,
            metricName: metric.name,
            currentValue: metric.value,
            threshold,
            unit: metric.unit,
            severity: metric.value > threshold * 2 ? "critical" : "warning",
          });
        }
      }
    }

    const totalDailyCost = services.reduce((sum, s) => sum + s.estimatedDailyCostUSD, 0);

    return {
      provider: "aws",
      accountId: credential.awsAccessKeyId?.slice(-4) || "unknown",
      checkedAt: Date.now(),
      services,
      totalEstimatedDailyCostUSD: totalDailyCost,
      violations,
      securityEvents: [],
    };
  },

  async executeKillSwitch(credential, serviceName, action): Promise<ActionResult> {
    const creds = await getAWSCredentials(credential);
    const [serviceType, ...rest] = serviceName.split(":");
    const serviceId = rest.join(":");

    switch (action) {
      case "stop-instances":
        if (serviceType === "rds") return stopRDSInstance(creds, serviceId);
        return stopEC2Instances(creds, [serviceId]);

      case "terminate-instances":
        return terminateEC2Instances(creds, [serviceId]);

      case "throttle-lambda":
        return throttleLambda(creds, serviceId);

      case "deny-bucket-policy":
        return denyS3BucketPolicy(creds, serviceId);

      case "delete":
        if (serviceType === "sagemaker") return deleteSageMakerEndpoint(creds, serviceId);
        return { success: false, action: "delete", serviceName, details: `Delete not supported for ${serviceType}` };

      case "scale-down":
        if (serviceType === "ecs") {
          const [cluster, svc] = serviceId.split("/");
          return scaleECSService(creds, cluster, svc);
        }
        if (serviceType === "eks") {
          const [cluster, nodeGroup] = serviceId.split("/");
          return scaleEKSNodeGroup(creds, cluster, nodeGroup);
        }
        // Default: stop EC2 instances
        return stopEC2Instances(creds, [serviceId]);

      case "disconnect":
      default:
        // Default action: stop instances for EC2, throttle for Lambda
        if (serviceType === "lambda") return throttleLambda(creds, serviceId);
        if (serviceType === "ec2") return stopEC2Instances(creds, [serviceId]);
        if (serviceType === "ecs") {
          const [cluster, svc] = serviceId.split("/");
          return scaleECSService(creds, cluster, svc);
        }
        if (serviceType === "eks") {
          const [cluster, nodeGroup] = serviceId.split("/");
          return scaleEKSNodeGroup(creds, cluster, nodeGroup);
        }
        if (serviceType === "rds") return stopRDSInstance(creds, serviceId);
        if (serviceType === "sagemaker") return deleteSageMakerEndpoint(creds, serviceId);
        return { success: false, action, serviceName, details: `Unknown service type: ${serviceType}` };
    }
  },

  async validateCredential(credential): Promise<ValidationResult> {
    if (!credential.awsAccessKeyId || !credential.awsSecretAccessKey) {
      return { valid: false, error: "Missing AWS access key ID or secret access key" };
    }

    try {
      const creds = await getAWSCredentials(credential);
      const stsClient = new STSClient({ region: creds.region, credentials: makeCredentials(creds) });
      const identity = await stsClient.send(new GetCallerIdentityCommand({}));

      return {
        valid: true,
        accountId: identity.Account,
        accountName: identity.Arn?.split("/").pop() || `AWS ${identity.Account}`,
      };
    } catch (e: any) {
      return { valid: false, error: e.message };
    }
  },

  getDefaultThresholds(): ThresholdConfig {
    return {
      ec2InstanceCount: 20,
      ec2GPUInstanceCount: 0,
      lambdaInvocationsPerDay: 1_000_000,
      lambdaConcurrentExecutions: 100,
      rdsInstanceCount: 5,
      ecsTaskCount: 50,
      eksNodeCount: 20,
      sagemakerEndpointCount: 0,
      awsDailyCostUSD: 100,
      monthlySpendLimitUSD: 3000,
    };
  },
};
