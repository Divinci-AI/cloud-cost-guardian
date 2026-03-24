import { describe, it, expect, vi, beforeEach } from "vitest";
import { awsProvider } from "../../src/providers/aws/checker.js";
import type { DecryptedCredential, ThresholdConfig } from "../../src/providers/types.js";

// Mock all AWS SDK clients
vi.mock("@aws-sdk/client-sts", () => ({
  STSClient: vi.fn().mockImplementation(() => ({
    send: vi.fn().mockResolvedValue({
      Account: "123456789012",
      Arn: "arn:aws:iam::123456789012:user/test-user",
    }),
  })),
  GetCallerIdentityCommand: vi.fn(),
  AssumeRoleCommand: vi.fn(),
}));

vi.mock("@aws-sdk/client-ec2", () => ({
  EC2Client: vi.fn().mockImplementation(() => ({
    send: vi.fn().mockResolvedValue({
      Reservations: [
        {
          Instances: [
            {
              InstanceId: "i-1234567890abcdef0",
              InstanceType: "t3.medium",
              Tags: [{ Key: "Name", Value: "web-server" }],
              status: "running",
            },
            {
              InstanceId: "i-gpu-instance",
              InstanceType: "p3.2xlarge",
              Tags: [{ Key: "Name", Value: "ml-training" }],
              guestAccelerators: [{ acceleratorCount: 1 }],
              status: "running",
            },
          ],
        },
      ],
    }),
  })),
  DescribeInstancesCommand: vi.fn(),
  StopInstancesCommand: vi.fn(),
  TerminateInstancesCommand: vi.fn(),
}));

vi.mock("@aws-sdk/client-lambda", () => ({
  LambdaClient: vi.fn().mockImplementation(() => ({
    send: vi.fn().mockImplementation((cmd: any) => {
      if (cmd.constructor.name === "ListFunctionsCommand" || !cmd.FunctionName) {
        return Promise.resolve({
          Functions: [
            { FunctionName: "api-handler", MemorySize: 256 },
            { FunctionName: "cron-job", MemorySize: 128 },
          ],
        });
      }
      // GetAccountSettingsCommand
      return Promise.resolve({
        AccountLimit: { ConcurrentExecutions: 1000, UnreservedConcurrentExecutions: 900 },
        AccountUsage: { TotalCodeSize: 5000000 },
      });
    }),
  })),
  ListFunctionsCommand: vi.fn(),
  GetAccountSettingsCommand: vi.fn(),
  PutFunctionConcurrencyCommand: vi.fn(),
}));

vi.mock("@aws-sdk/client-rds", () => ({
  RDSClient: vi.fn().mockImplementation(() => ({
    send: vi.fn().mockResolvedValue({
      DBInstances: [
        { DBInstanceIdentifier: "prod-db", DBInstanceClass: "db.r5.large", DBInstanceStatus: "available" },
      ],
    }),
  })),
  DescribeDBInstancesCommand: vi.fn(),
  StopDBInstanceCommand: vi.fn(),
}));

vi.mock("@aws-sdk/client-ecs", () => {
  let ecsCallCount = 0;
  return {
    ECSClient: vi.fn().mockImplementation(() => ({
      send: vi.fn().mockImplementation((cmd: any) => {
        ecsCallCount++;
        // Commands are called in order: ListClusters -> ListServices -> DescribeServices
        const input = cmd.input || cmd;
        if (input.desiredCount !== undefined) {
          return Promise.resolve({}); // UpdateService
        }
        // Check if it has both cluster and services array (DescribeServices)
        if (input.cluster && input.services) {
          return Promise.resolve({ services: [{ serviceName: "api-service", runningCount: 3 }] });
        }
        // Check if it has cluster but no services array (ListServices)
        if (input.cluster) {
          return Promise.resolve({ serviceArns: ["arn:aws:ecs:us-east-1:123:service/cluster/api-service"] });
        }
        // Default: ListClusters
        return Promise.resolve({ clusterArns: ["arn:aws:ecs:us-east-1:123:cluster/prod"] });
      }),
    })),
    ListClustersCommand: vi.fn().mockImplementation((input: any) => ({ input })),
    ListServicesCommand: vi.fn().mockImplementation((input: any) => ({ input })),
    DescribeServicesCommand: vi.fn().mockImplementation((input: any) => ({ input })),
    UpdateServiceCommand: vi.fn().mockImplementation((input: any) => ({ input })),
  };
});

vi.mock("@aws-sdk/client-eks", () => ({
  EKSClient: vi.fn().mockImplementation(() => ({
    send: vi.fn().mockResolvedValue({ clusters: [], nodegroups: [] }),
  })),
  ListClustersCommand: vi.fn(),
  ListNodegroupsCommand: vi.fn(),
  DescribeNodegroupCommand: vi.fn(),
  UpdateNodegroupConfigCommand: vi.fn(),
}));

vi.mock("@aws-sdk/client-sagemaker", () => ({
  SageMakerClient: vi.fn().mockImplementation(() => ({
    send: vi.fn().mockResolvedValue({ Endpoints: [] }),
  })),
  ListEndpointsCommand: vi.fn(),
  DeleteEndpointCommand: vi.fn(),
}));

vi.mock("@aws-sdk/client-cost-explorer", () => ({
  CostExplorerClient: vi.fn().mockImplementation(() => ({
    send: vi.fn().mockResolvedValue({
      ResultsByTime: [
        {
          Groups: [
            { Keys: ["Amazon EC2"], Metrics: { UnblendedCost: { Amount: "45.67" } } },
            { Keys: ["AWS Lambda"], Metrics: { UnblendedCost: { Amount: "2.34" } } },
          ],
        },
      ],
    }),
  })),
  GetCostAndUsageCommand: vi.fn(),
}));

vi.mock("@aws-sdk/client-s3", () => ({
  S3Client: vi.fn().mockImplementation(() => ({
    send: vi.fn().mockResolvedValue({}),
  })),
  PutBucketPolicyCommand: vi.fn(),
}));

const credential: DecryptedCredential = {
  provider: "aws",
  awsAccessKeyId: "AKIAIOSFODNN7EXAMPLE",
  awsSecretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
  awsRegion: "us-east-1",
};

const defaultThresholds: ThresholdConfig = awsProvider.getDefaultThresholds();

describe("AWS Provider", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("validateCredential", () => {
    it("returns valid for correct credentials", async () => {
      const result = await awsProvider.validateCredential(credential);

      expect(result.valid).toBe(true);
      expect(result.accountId).toBe("123456789012");
    });

    it("returns invalid for missing credentials", async () => {
      const result = await awsProvider.validateCredential({ provider: "aws" });

      expect(result.valid).toBe(false);
      expect(result.error).toContain("Missing AWS");
    });

    it("returns invalid when STS call throws", async () => {
      const { STSClient: MockSTSClient } = await import("@aws-sdk/client-sts");
      (MockSTSClient as any).mockImplementation(() => ({
        send: vi.fn().mockRejectedValue(new Error("InvalidClientTokenId")),
      }));

      const result = await awsProvider.validateCredential(credential);

      expect(result.valid).toBe(false);
      expect(result.error).toContain("InvalidClientTokenId");
    });
  });

  describe("getDefaultThresholds", () => {
    it("returns sensible defaults for all AWS services", () => {
      const thresholds = awsProvider.getDefaultThresholds();

      expect(thresholds.ec2InstanceCount).toBe(20);
      expect(thresholds.ec2GPUInstanceCount).toBe(0);
      expect(thresholds.lambdaInvocationsPerDay).toBe(1_000_000);
      expect(thresholds.lambdaConcurrentExecutions).toBe(100);
      expect(thresholds.rdsInstanceCount).toBe(5);
      expect(thresholds.ecsTaskCount).toBe(50);
      expect(thresholds.eksNodeCount).toBe(20);
      expect(thresholds.sagemakerEndpointCount).toBe(0);
      expect(thresholds.awsDailyCostUSD).toBe(100);
      expect(thresholds.monthlySpendLimitUSD).toBe(3000);
    });
  });

  describe("checkUsage", () => {
    it("returns usage data from all AWS services", async () => {
      const result = await awsProvider.checkUsage(credential, defaultThresholds);

      expect(result.provider).toBe("aws");
      expect(result.services.length).toBeGreaterThan(0);
      expect(result.checkedAt).toBeGreaterThan(0);
    });

    it("detects GPU instance threshold violation", async () => {
      // Default threshold is 0 GPUs, and our mock returns a p3.2xlarge
      const result = await awsProvider.checkUsage(credential, {
        ...defaultThresholds,
        ec2GPUInstanceCount: 0,
      });

      const gpuViolation = result.violations.find(v => v.metricName === "Total GPU Instances");
      expect(gpuViolation).toBeDefined();
      expect(gpuViolation?.currentValue).toBe(1);
    });

    it("throws on missing credentials", async () => {
      await expect(
        awsProvider.checkUsage({ provider: "aws" }, defaultThresholds)
      ).rejects.toThrow("Missing AWS");
    });

    it("handles Cost Explorer errors gracefully", async () => {
      const { CostExplorerClient: MockCEClient } = await import("@aws-sdk/client-cost-explorer");
      (MockCEClient as any).mockImplementation(() => ({
        send: vi.fn().mockRejectedValue(new Error("AccessDenied")),
      }));

      const result = await awsProvider.checkUsage(credential, defaultThresholds);

      // Should still succeed — cost explorer errors are caught
      expect(result.provider).toBe("aws");
      // Cost service should be absent or empty
      const costService = result.services.find(s => s.serviceName.startsWith("cost:"));
      expect(costService).toBeUndefined();
    });
  });

  describe("executeKillSwitch", () => {
    it("routes stop-instances action for EC2", async () => {
      const result = await awsProvider.executeKillSwitch(
        credential, "ec2:i-1234567890abcdef0", "stop-instances"
      );

      expect(result.action).toBe("stop-instances");
      expect(result.serviceName).toContain("ec2");
    });

    it("routes throttle-lambda action", async () => {
      const result = await awsProvider.executeKillSwitch(
        credential, "lambda:api-handler", "throttle-lambda"
      );

      expect(result.action).toBe("throttle-lambda");
      expect(result.serviceName).toContain("lambda");
    });

    it("routes deny-bucket-policy action for S3", async () => {
      const result = await awsProvider.executeKillSwitch(
        credential, "s3:my-bucket", "deny-bucket-policy"
      );

      expect(result.action).toBe("deny-bucket-policy");
      expect(result.serviceName).toContain("s3");
    });

    it("routes scale-down for ECS services", async () => {
      const result = await awsProvider.executeKillSwitch(
        credential, "ecs:prod/api-service", "scale-down"
      );

      expect(result.action).toBe("scale-down");
      expect(result.serviceName).toContain("ecs");
    });

    it("defaults to stop for unknown EC2 disconnect", async () => {
      const result = await awsProvider.executeKillSwitch(
        credential, "ec2:i-abc123", "disconnect"
      );

      expect(result.action).toBe("stop-instances");
    });

    it("defaults to throttle for unknown Lambda disconnect", async () => {
      const result = await awsProvider.executeKillSwitch(
        credential, "lambda:my-func", "disconnect"
      );

      expect(result.action).toBe("throttle-lambda");
    });

    it("routes terminate-instances action for EC2", async () => {
      const result = await awsProvider.executeKillSwitch(
        credential, "ec2:i-1234567890abcdef0", "terminate-instances"
      );

      expect(result.action).toBe("terminate-instances");
      expect(result.serviceName).toContain("ec2");
      expect(result.success).toBe(true);
      expect(result.details).toContain("TERMINATED");
    });

    it("routes stop-instances action for RDS", async () => {
      const result = await awsProvider.executeKillSwitch(
        credential, "rds:prod-db", "stop-instances"
      );

      expect(result.action).toBe("stop-instances");
      expect(result.serviceName).toContain("rds");
      expect(result.success).toBe(true);
      expect(result.details).toContain("Stopped RDS instance");
    });

    it("routes scale-down for EKS node groups", async () => {
      const result = await awsProvider.executeKillSwitch(
        credential, "eks:my-cluster/my-nodegroup", "scale-down"
      );

      expect(result.action).toBe("scale-down");
      expect(result.serviceName).toContain("eks");
      expect(result.success).toBe(true);
      expect(result.details).toContain("Scaled EKS node group");
    });

    it("routes scale-down to stop EC2 for unknown service type", async () => {
      const result = await awsProvider.executeKillSwitch(
        credential, "ec2:i-abc123", "scale-down"
      );

      expect(result.action).toBe("stop-instances");
      expect(result.serviceName).toContain("ec2");
    });

    it("routes delete action for SageMaker endpoint", async () => {
      const result = await awsProvider.executeKillSwitch(
        credential, "sagemaker:my-endpoint", "delete"
      );

      expect(result.action).toBe("delete");
      expect(result.serviceName).toContain("sagemaker");
      expect(result.success).toBe(true);
      expect(result.details).toContain("Deleted SageMaker endpoint");
    });

    it("returns failure for delete on unsupported service type", async () => {
      const result = await awsProvider.executeKillSwitch(
        credential, "unknown:something", "delete"
      );

      expect(result.success).toBe(false);
      expect(result.action).toBe("delete");
      expect(result.details).toContain("Delete not supported");
    });

    it("routes disconnect for ECS services", async () => {
      const result = await awsProvider.executeKillSwitch(
        credential, "ecs:prod/api-service", "disconnect"
      );

      expect(result.action).toBe("scale-down");
      expect(result.serviceName).toContain("ecs");
    });

    it("routes disconnect for EKS node groups", async () => {
      const result = await awsProvider.executeKillSwitch(
        credential, "eks:my-cluster/my-nodegroup", "disconnect"
      );

      expect(result.action).toBe("scale-down");
      expect(result.serviceName).toContain("eks");
    });

    it("routes disconnect for RDS instances", async () => {
      const result = await awsProvider.executeKillSwitch(
        credential, "rds:prod-db", "disconnect"
      );

      expect(result.action).toBe("stop-instances");
      expect(result.serviceName).toContain("rds");
    });

    it("routes disconnect for SageMaker endpoints", async () => {
      const result = await awsProvider.executeKillSwitch(
        credential, "sagemaker:my-endpoint", "disconnect"
      );

      expect(result.action).toBe("delete");
      expect(result.serviceName).toContain("sagemaker");
    });

    it("returns failure for disconnect on unknown service type", async () => {
      const result = await awsProvider.executeKillSwitch(
        credential, "unknown:something", "disconnect"
      );

      expect(result.success).toBe(false);
      expect(result.details).toContain("Unknown service type");
    });
  });

  describe("getAWSCredentials — AssumeRole flow", () => {
    it("assumes role when awsRoleArn is provided", async () => {
      const { STSClient: MockSTSClient } = await import("@aws-sdk/client-sts");
      const mockSend = vi.fn()
        .mockResolvedValueOnce({
          Credentials: {
            AccessKeyId: "ASIA_ASSUMED_KEY",
            SecretAccessKey: "assumed-secret",
            SessionToken: "assumed-session-token",
          },
        })
        .mockResolvedValueOnce({
          Account: "123456789012",
          Arn: "arn:aws:iam::123456789012:role/assumed-role",
        });
      (MockSTSClient as any).mockImplementation(() => ({ send: mockSend }));

      const roleCredential: DecryptedCredential = {
        provider: "aws",
        awsAccessKeyId: "AKIAIOSFODNN7EXAMPLE",
        awsSecretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
        awsRegion: "us-west-2",
        awsRoleArn: "arn:aws:iam::123456789012:role/test-role",
      };

      const result = await awsProvider.validateCredential(roleCredential);
      expect(result.valid).toBe(true);
    });

    it("throws when AssumeRole returns no credentials", async () => {
      const { STSClient: MockSTSClient } = await import("@aws-sdk/client-sts");
      const mockSend = vi.fn().mockResolvedValueOnce({
        // No Credentials field
      });
      (MockSTSClient as any).mockImplementation(() => ({ send: mockSend }));

      const roleCredential: DecryptedCredential = {
        provider: "aws",
        awsAccessKeyId: "AKIAIOSFODNN7EXAMPLE",
        awsSecretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
        awsRoleArn: "arn:aws:iam::123456789012:role/test-role",
      };

      await expect(
        awsProvider.checkUsage(roleCredential, defaultThresholds)
      ).rejects.toThrow("Failed to assume role");
    });
  });

  describe("listECSServices", () => {
    it("lists ECS services with running tasks across clusters", async () => {
      const result = await awsProvider.checkUsage(credential, defaultThresholds);

      const ecsServices = result.services.filter(s => s.serviceName.startsWith("ecs:"));
      expect(ecsServices.length).toBeGreaterThan(0);

      const taskService = ecsServices.find(s => s.serviceName.includes("api-service"));
      expect(taskService).toBeDefined();

      const allTasks = ecsServices.find(s => s.serviceName === "ecs:all-tasks");
      expect(allTasks).toBeDefined();
      expect(allTasks!.metrics[0].value).toBe(3);
    });
  });

  describe("listEKSNodeGroups", () => {
    it("lists EKS node groups with desired sizes", async () => {
      const { EKSClient: MockEKSClient } = await import("@aws-sdk/client-eks");
      const mockSend = vi.fn()
        .mockResolvedValueOnce({ clusters: ["prod-cluster"] })
        .mockResolvedValueOnce({ nodegroups: ["ng-1", "ng-2"] })
        .mockResolvedValueOnce({ nodegroup: { scalingConfig: { desiredSize: 3 } } })
        .mockResolvedValueOnce({ nodegroup: { scalingConfig: { desiredSize: 5 } } });
      (MockEKSClient as any).mockImplementation(() => ({ send: mockSend }));

      const result = await awsProvider.checkUsage(credential, defaultThresholds);

      const eksServices = result.services.filter(s => s.serviceName.startsWith("eks:"));
      expect(eksServices.length).toBeGreaterThan(0);

      const allNodes = eksServices.find(s => s.serviceName === "eks:all-nodes");
      expect(allNodes).toBeDefined();
      expect(allNodes!.metrics[0].value).toBe(8);
    });
  });

  describe("listSageMakerEndpoints", () => {
    it("lists SageMaker endpoints with aggregate metric", async () => {
      const { SageMakerClient: MockSMClient } = await import("@aws-sdk/client-sagemaker");
      (MockSMClient as any).mockImplementation(() => ({
        send: vi.fn().mockResolvedValue({
          Endpoints: [
            { EndpointName: "my-endpoint-1" },
            { EndpointName: "my-endpoint-2" },
          ],
        }),
      }));

      const result = await awsProvider.checkUsage(credential, defaultThresholds);

      const smServices = result.services.filter(s => s.serviceName.startsWith("sagemaker:"));
      expect(smServices.length).toBeGreaterThanOrEqual(3); // 2 endpoints + 1 aggregate
      const allEndpoints = smServices.find(s => s.serviceName === "sagemaker:all-endpoints");
      expect(allEndpoints).toBeDefined();
      expect(allEndpoints!.metrics[0].value).toBe(2);
    });
  });

  describe("kill action error handling", () => {
    it("returns failure when terminateEC2Instances throws", async () => {
      const { EC2Client: MockEC2Client } = await import("@aws-sdk/client-ec2");
      (MockEC2Client as any).mockImplementation(() => ({
        send: vi.fn().mockRejectedValue(new Error("Access Denied")),
      }));

      const result = await awsProvider.executeKillSwitch(
        credential, "ec2:i-abc123", "terminate-instances"
      );

      expect(result.success).toBe(false);
      expect(result.details).toContain("Failed");
      expect(result.details).toContain("Access Denied");
    });

    it("returns failure when stopRDSInstance throws", async () => {
      const { RDSClient: MockRDSClient } = await import("@aws-sdk/client-rds");
      (MockRDSClient as any).mockImplementation(() => ({
        send: vi.fn().mockRejectedValue(new Error("DBInstanceNotFound")),
      }));

      const result = await awsProvider.executeKillSwitch(
        credential, "rds:prod-db", "stop-instances"
      );

      expect(result.success).toBe(false);
      expect(result.details).toContain("Failed");
      expect(result.details).toContain("DBInstanceNotFound");
    });

    it("returns failure when scaleECSService throws", async () => {
      const { ECSClient: MockECSClient } = await import("@aws-sdk/client-ecs");
      (MockECSClient as any).mockImplementation(() => ({
        send: vi.fn().mockRejectedValue(new Error("ServiceNotFound")),
      }));

      const result = await awsProvider.executeKillSwitch(
        credential, "ecs:prod/api-service", "scale-down"
      );

      expect(result.success).toBe(false);
      expect(result.details).toContain("Failed");
    });

    it("returns failure when scaleEKSNodeGroup throws", async () => {
      const { EKSClient: MockEKSClient } = await import("@aws-sdk/client-eks");
      (MockEKSClient as any).mockImplementation(() => ({
        send: vi.fn().mockRejectedValue(new Error("NodegroupNotFound")),
      }));

      const result = await awsProvider.executeKillSwitch(
        credential, "eks:my-cluster/my-nodegroup", "scale-down"
      );

      expect(result.success).toBe(false);
      expect(result.details).toContain("Failed");
    });

    it("returns failure when deleteSageMakerEndpoint throws", async () => {
      const { SageMakerClient: MockSMClient } = await import("@aws-sdk/client-sagemaker");
      (MockSMClient as any).mockImplementation(() => ({
        send: vi.fn().mockRejectedValue(new Error("EndpointNotFound")),
      }));

      const result = await awsProvider.executeKillSwitch(
        credential, "sagemaker:my-endpoint", "delete"
      );

      expect(result.success).toBe(false);
      expect(result.details).toContain("Failed");
      expect(result.details).toContain("EndpointNotFound");
    });

    it("returns failure when stopEC2Instances throws", async () => {
      const { EC2Client: MockEC2Client } = await import("@aws-sdk/client-ec2");
      (MockEC2Client as any).mockImplementation(() => ({
        send: vi.fn().mockRejectedValue(new Error("UnauthorizedOperation")),
      }));

      const result = await awsProvider.executeKillSwitch(
        credential, "ec2:i-abc123", "stop-instances"
      );

      expect(result.success).toBe(false);
      expect(result.details).toContain("Failed");
      expect(result.details).toContain("UnauthorizedOperation");
    });

    it("returns failure when throttleLambda throws", async () => {
      const { LambdaClient: MockLambdaClient } = await import("@aws-sdk/client-lambda");
      (MockLambdaClient as any).mockImplementation(() => ({
        send: vi.fn().mockRejectedValue(new Error("ThrottlingException")),
      }));

      const result = await awsProvider.executeKillSwitch(
        credential, "lambda:my-func", "throttle-lambda"
      );

      expect(result.success).toBe(false);
      expect(result.details).toContain("Failed");
      expect(result.details).toContain("ThrottlingException");
    });

    it("returns failure when denyS3BucketPolicy throws", async () => {
      const { S3Client: MockS3Client } = await import("@aws-sdk/client-s3");
      (MockS3Client as any).mockImplementation(() => ({
        send: vi.fn().mockRejectedValue(new Error("NoSuchBucket")),
      }));

      const result = await awsProvider.executeKillSwitch(
        credential, "s3:my-bucket", "deny-bucket-policy"
      );

      expect(result.success).toBe(false);
      expect(result.details).toContain("Failed");
      expect(result.details).toContain("NoSuchBucket");
    });
  });
});
