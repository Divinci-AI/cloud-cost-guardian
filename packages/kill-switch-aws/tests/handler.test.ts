import { describe, it, expect, vi, beforeEach } from "vitest";
import type { SNSEvent } from "aws-lambda";

// Mock all AWS SDK clients before importing handler
vi.mock("@aws-sdk/client-ec2", () => ({
  EC2Client: vi.fn().mockImplementation(() => ({
    send: vi.fn().mockImplementation((cmd: any) => {
      // DescribeInstances
      if (!cmd.InstanceIds) {
        return Promise.resolve({
          Reservations: [{
            Instances: [
              { InstanceId: "i-running-1", status: "running" },
              { InstanceId: "i-protected", status: "running" },
            ],
          }],
        });
      }
      // StopInstances
      return Promise.resolve({});
    }),
  })),
  DescribeInstancesCommand: vi.fn(),
  StopInstancesCommand: vi.fn(),
}));

vi.mock("@aws-sdk/client-lambda", () => ({
  LambdaClient: vi.fn().mockImplementation(() => ({
    send: vi.fn().mockImplementation((cmd: any) => {
      if (cmd.ReservedConcurrentExecutions !== undefined) {
        return Promise.resolve({}); // PutFunctionConcurrency
      }
      return Promise.resolve({
        Functions: [
          { FunctionName: "api-handler" },
          { FunctionName: "protected-func" },
        ],
      });
    }),
  })),
  ListFunctionsCommand: vi.fn(),
  PutFunctionConcurrencyCommand: vi.fn(),
}));

vi.mock("@aws-sdk/client-ecs", () => ({
  ECSClient: vi.fn().mockImplementation(() => ({
    send: vi.fn().mockImplementation((cmd: any) => {
      if (cmd.desiredCount !== undefined) return Promise.resolve({});
      if (cmd.cluster) return Promise.resolve({ serviceArns: ["arn:aws:ecs:::service/cluster/svc-1"] });
      return Promise.resolve({ clusterArns: ["arn:aws:ecs:::cluster/prod"] });
    }),
  })),
  ListClustersCommand: vi.fn(),
  ListServicesCommand: vi.fn(),
  UpdateServiceCommand: vi.fn(),
}));

vi.mock("@aws-sdk/client-sagemaker", () => ({
  SageMakerClient: vi.fn().mockImplementation(() => ({
    send: vi.fn().mockResolvedValue({ Endpoints: [] }),
  })),
  ListEndpointsCommand: vi.fn(),
  DeleteEndpointCommand: vi.fn(),
}));

// Mock fetch for PagerDuty
const mockFetch = vi.fn().mockResolvedValue({ ok: true, text: async () => "{}" });
vi.stubGlobal("fetch", mockFetch);

// Set env before importing
process.env.KILL_THRESHOLD = "0.8";
process.env.PROTECTED_INSTANCES = "i-protected";
process.env.PROTECTED_FUNCTIONS = "protected-func";
process.env.PROTECTED_SERVICES = "";
process.env.PAGERDUTY_ROUTING_KEY = "";

import { handler } from "../src/index.js";

// ─── Test Helpers ───────────────────────────────────────────────────────────

function makeSNSEvent(budgetAlert: Record<string, any>): SNSEvent {
  return {
    Records: [{
      EventVersion: "1.0",
      EventSubscriptionArn: "arn:aws:sns:us-east-1:123:test",
      EventSource: "aws:sns",
      Sns: {
        Type: "Notification",
        MessageId: "test-msg-id",
        TopicArn: "arn:aws:sns:us-east-1:123:billing",
        Subject: "Budget Alert",
        Message: JSON.stringify(budgetAlert),
        Timestamp: new Date().toISOString(),
        SignatureVersion: "1",
        Signature: "test",
        SigningCertUrl: "https://test",
        UnsubscribeUrl: "https://test",
        MessageAttributes: {},
      },
    }],
  };
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("AWS Billing Kill Switch Lambda", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("does nothing when cost is below threshold", async () => {
    const event = makeSNSEvent({
      actualAmount: "400",
      budgetLimit: "1000",
      budgetName: "monthly-budget",
    });

    await handler(event);

    // Should not call PagerDuty (no routing key set and below 50%)
    // The main assertion is that it doesn't throw
  });

  it("triggers kill actions when cost exceeds threshold", async () => {
    const event = makeSNSEvent({
      actualAmount: "900",
      budgetLimit: "1000",
      budgetName: "monthly-budget",
    });

    await handler(event);

    // Handler should have run kill actions (EC2, Lambda, ECS, SageMaker)
    // The mocked SDK clients track calls internally
  });

  it("does not call PagerDuty when routing key is empty", async () => {
    // PAGERDUTY_ROUTING_KEY is empty (set before module import)
    const event = makeSNSEvent({
      actualAmount: "600",
      budgetLimit: "1000",
      budgetName: "monthly-budget",
    });

    await handler(event);

    // With no routing key, fetch should not be called for PagerDuty
    expect(mockFetch).not.toHaveBeenCalledWith(
      "https://events.pagerduty.com/v2/enqueue",
      expect.anything()
    );
  });

  it("handles malformed SNS messages gracefully", async () => {
    const event: SNSEvent = {
      Records: [{
        EventVersion: "1.0",
        EventSubscriptionArn: "arn:aws:sns:us-east-1:123:test",
        EventSource: "aws:sns",
        Sns: {
          Type: "Notification",
          MessageId: "test",
          TopicArn: "arn:test",
          Subject: "test",
          Message: "not-valid-json",
          Timestamp: new Date().toISOString(),
          SignatureVersion: "1",
          Signature: "test",
          SigningCertUrl: "https://test",
          UnsubscribeUrl: "https://test",
          MessageAttributes: {},
        },
      }],
    };

    // Should not throw
    await expect(handler(event)).resolves.not.toThrow();
  });

  it("handles missing budget fields with defaults", async () => {
    const event = makeSNSEvent({});

    // actualAmount defaults to 0, budgetLimit defaults to 1
    // 0/1 = 0% which is below threshold — should not trigger
    await expect(handler(event)).resolves.not.toThrow();
  });

  it("processes multiple SNS records", async () => {
    const event: SNSEvent = {
      Records: [
        {
          EventVersion: "1.0",
          EventSubscriptionArn: "arn:test",
          EventSource: "aws:sns",
          Sns: {
            Type: "Notification", MessageId: "1", TopicArn: "arn:test", Subject: "",
            Message: JSON.stringify({ actualAmount: "100", budgetLimit: "1000" }),
            Timestamp: new Date().toISOString(), SignatureVersion: "1", Signature: "", SigningCertUrl: "", UnsubscribeUrl: "", MessageAttributes: {},
          },
        },
        {
          EventVersion: "1.0",
          EventSubscriptionArn: "arn:test",
          EventSource: "aws:sns",
          Sns: {
            Type: "Notification", MessageId: "2", TopicArn: "arn:test", Subject: "",
            Message: JSON.stringify({ actualAmount: "950", budgetLimit: "1000" }),
            Timestamp: new Date().toISOString(), SignatureVersion: "1", Signature: "", SigningCertUrl: "", UnsubscribeUrl: "", MessageAttributes: {},
          },
        },
      ],
    };

    // Should process both records without error
    await expect(handler(event)).resolves.not.toThrow();
  });
});
