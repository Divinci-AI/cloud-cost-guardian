/**
 * AWS Billing Kill Switch
 *
 * Lambda function triggered by AWS Budget alerts via SNS.
 * Stops runaway EC2 instances, throttles Lambda functions, scales down ECS/EKS,
 * and deletes SageMaker endpoints when spending exceeds thresholds.
 *
 * Setup:
 * 1. Create an AWS Budget with an SNS action
 * 2. Subscribe this Lambda to the SNS topic
 * 3. Configure environment variables (see below)
 *
 * Environment Variables:
 *   AWS_REGION           - Region to monitor (default: us-east-1)
 *   KILL_THRESHOLD       - Budget % at which to act (0-1, default: 0.8)
 *   PROTECTED_INSTANCES  - Comma-separated EC2 instance IDs to never stop
 *   PROTECTED_FUNCTIONS  - Comma-separated Lambda function names to never throttle
 *   PROTECTED_SERVICES   - Comma-separated ECS service names to never scale down
 *   PAGERDUTY_ROUTING_KEY - PagerDuty Events API v2 routing key
 */

import { EC2Client, DescribeInstancesCommand, StopInstancesCommand } from "@aws-sdk/client-ec2";
import { LambdaClient, ListFunctionsCommand, PutFunctionConcurrencyCommand } from "@aws-sdk/client-lambda";
import { ECSClient, ListClustersCommand, ListServicesCommand, UpdateServiceCommand } from "@aws-sdk/client-ecs";
import { SageMakerClient, ListEndpointsCommand, DeleteEndpointCommand } from "@aws-sdk/client-sagemaker";
import type { SNSEvent } from "aws-lambda";

// ── Configuration ───────────────────────────────────────────────────────────

const REGION = process.env.AWS_REGION || "us-east-1";
const KILL_THRESHOLD = parseFloat(process.env.KILL_THRESHOLD || "0.8");
const PAGERDUTY_ROUTING_KEY = process.env.PAGERDUTY_ROUTING_KEY || "";

const PROTECTED_INSTANCES = (process.env.PROTECTED_INSTANCES || "").split(",").map(s => s.trim()).filter(Boolean);
const PROTECTED_FUNCTIONS = (process.env.PROTECTED_FUNCTIONS || "").split(",").map(s => s.trim()).filter(Boolean);
const PROTECTED_SERVICES = (process.env.PROTECTED_SERVICES || "").split(",").map(s => s.trim()).filter(Boolean);

// ── Main Handler ────────────────────────────────────────────────────────────

export async function handler(event: SNSEvent): Promise<void> {
  for (const record of event.Records) {
    let budgetAlert: any;
    try {
      budgetAlert = JSON.parse(record.Sns.Message);
    } catch {
      console.error("Failed to parse SNS message:", record.Sns.Message);
      continue;
    }

    console.log("Budget alert received:", JSON.stringify(budgetAlert, null, 2));

    // AWS Budget SNS notifications use these field names:
    //   actualAmount  — current spend
    //   budgetLimit   — budgeted amount
    //   threshold     — the % threshold that was crossed (e.g., "80")
    //   budgetName    — name of the budget
    //   account       — AWS account ID
    //   unit          — currency (e.g., "USD")
    const actualAmount = parseFloat(budgetAlert.actualAmount || "0");
    const budgetLimit = parseFloat(budgetAlert.budgetLimit || "1");
    const costRatio = actualAmount / budgetLimit;

    console.log(`Cost: $${actualAmount.toFixed(2)} / Budget: $${budgetLimit.toFixed(2)} (${(costRatio * 100).toFixed(1)}%) [budget: ${budgetAlert.budgetName || "unknown"}]`);

    if (costRatio < KILL_THRESHOLD) {
      console.log(`Cost ratio ${(costRatio * 100).toFixed(1)}% below threshold ${(KILL_THRESHOLD * 100).toFixed(1)}%. Monitoring only.`);

      if (costRatio >= 0.5 && PAGERDUTY_ROUTING_KEY) {
        await alertPagerDuty(
          `AWS spending at ${(costRatio * 100).toFixed(0)}% of budget ($${actualAmount.toFixed(2)}/$${budgetLimit.toFixed(2)})`,
          "warning",
          { actualAmount, budgetLimit, costRatio, action: "monitoring" }
        );
      }
      continue;
    }

    console.log(`KILL THRESHOLD EXCEEDED: ${(costRatio * 100).toFixed(1)}% >= ${(KILL_THRESHOLD * 100).toFixed(1)}%`);

    const actions: string[] = [];

    // Stop EC2 instances
    const ec2Actions = await stopEC2Instances();
    actions.push(...ec2Actions);

    // Throttle Lambda functions
    const lambdaActions = await throttleLambdaFunctions();
    actions.push(...lambdaActions);

    // Scale down ECS services
    const ecsActions = await scaleDownECSServices();
    actions.push(...ecsActions);

    // Delete SageMaker endpoints
    const smActions = await deleteSageMakerEndpoints();
    actions.push(...smActions);

    // Alert PagerDuty
    if (PAGERDUTY_ROUTING_KEY) {
      await alertPagerDuty(
        `AWS BILLING KILL SWITCH ACTIVATED: $${actualAmount.toFixed(2)}/$${budgetLimit.toFixed(2)} (${(costRatio * 100).toFixed(0)}%)`,
        "critical",
        { actualAmount, budgetLimit, costRatio: `${(costRatio * 100).toFixed(1)}%`, actionsTaken: actions }
      );
    }

    console.log("Kill switch actions completed:", actions);
  }
}

// ── Kill Actions ────────────────────────────────────────────────────────────

async function stopEC2Instances(): Promise<string[]> {
  const actions: string[] = [];
  const client = new EC2Client({ region: REGION });

  try {
    const response = await client.send(new DescribeInstancesCommand({
      Filters: [{ Name: "instance-state-name", Values: ["running"] }],
    }));

    const instanceIds: string[] = [];
    for (const reservation of response.Reservations || []) {
      for (const instance of reservation.Instances || []) {
        if (PROTECTED_INSTANCES.includes(instance.InstanceId!)) {
          actions.push(`PROTECTED: EC2 ${instance.InstanceId}`);
          continue;
        }
        instanceIds.push(instance.InstanceId!);
      }
    }

    if (instanceIds.length > 0) {
      await client.send(new StopInstancesCommand({ InstanceIds: instanceIds }));
      actions.push(`STOPPED: ${instanceIds.length} EC2 instance(s): ${instanceIds.join(", ")}`);
    }
  } catch (err: any) {
    actions.push(`FAILED to stop EC2 instances: ${err.message}`);
  }

  return actions;
}

async function throttleLambdaFunctions(): Promise<string[]> {
  const actions: string[] = [];
  const client = new LambdaClient({ region: REGION });

  try {
    const response = await client.send(new ListFunctionsCommand({}));

    for (const fn of response.Functions || []) {
      if (PROTECTED_FUNCTIONS.includes(fn.FunctionName!)) {
        actions.push(`PROTECTED: Lambda ${fn.FunctionName}`);
        continue;
      }

      try {
        await client.send(new PutFunctionConcurrencyCommand({
          FunctionName: fn.FunctionName!,
          ReservedConcurrentExecutions: 0,
        }));
        actions.push(`THROTTLED: Lambda ${fn.FunctionName} (concurrency → 0)`);
      } catch (err: any) {
        actions.push(`FAILED to throttle ${fn.FunctionName}: ${err.message}`);
      }
    }
  } catch (err: any) {
    actions.push(`FAILED to list Lambda functions: ${err.message}`);
  }

  return actions;
}

async function scaleDownECSServices(): Promise<string[]> {
  const actions: string[] = [];
  const client = new ECSClient({ region: REGION });

  try {
    const clustersRes = await client.send(new ListClustersCommand({}));

    for (const clusterArn of clustersRes.clusterArns || []) {
      const servicesRes = await client.send(new ListServicesCommand({ cluster: clusterArn }));

      for (const serviceArn of servicesRes.serviceArns || []) {
        const serviceName = serviceArn.split("/").pop()!;

        if (PROTECTED_SERVICES.includes(serviceName)) {
          actions.push(`PROTECTED: ECS ${serviceName}`);
          continue;
        }

        try {
          await client.send(new UpdateServiceCommand({
            cluster: clusterArn,
            service: serviceArn,
            desiredCount: 0,
          }));
          actions.push(`SCALED DOWN: ECS ${serviceName} (desired → 0)`);
        } catch (err: any) {
          actions.push(`FAILED to scale down ${serviceName}: ${err.message}`);
        }
      }
    }
  } catch (err: any) {
    actions.push(`FAILED to list ECS services: ${err.message}`);
  }

  return actions;
}

async function deleteSageMakerEndpoints(): Promise<string[]> {
  const actions: string[] = [];
  const client = new SageMakerClient({ region: REGION });

  try {
    const response = await client.send(new ListEndpointsCommand({ StatusEquals: "InService" }));

    for (const endpoint of response.Endpoints || []) {
      try {
        await client.send(new DeleteEndpointCommand({ EndpointName: endpoint.EndpointName! }));
        actions.push(`DELETED: SageMaker endpoint ${endpoint.EndpointName}`);
      } catch (err: any) {
        actions.push(`FAILED to delete endpoint ${endpoint.EndpointName}: ${err.message}`);
      }
    }
  } catch (err: any) {
    actions.push(`FAILED to list SageMaker endpoints: ${err.message}`);
  }

  return actions;
}

// ── PagerDuty ───────────────────────────────────────────────────────────────

async function alertPagerDuty(
  summary: string,
  severity: "critical" | "error" | "warning" | "info",
  details: Record<string, unknown>
): Promise<void> {
  const dedup = `aws-billing-${new Date().toISOString().split("T")[0]}`;

  try {
    const res = await fetch("https://events.pagerduty.com/v2/enqueue", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        routing_key: PAGERDUTY_ROUTING_KEY,
        event_action: "trigger",
        dedup_key: dedup,
        payload: {
          summary,
          source: "aws-billing-kill-switch",
          severity,
          component: "aws",
          group: REGION,
          class: "billing",
          custom_details: details,
        },
        client: "AWS Billing Kill Switch",
        client_url: "https://console.aws.amazon.com/billing/",
      }),
    });

    if (!res.ok) {
      console.error(`PagerDuty error: ${res.status} ${await res.text()}`);
    }
  } catch (err) {
    console.error("PagerDuty alert failed:", err);
  }
}
