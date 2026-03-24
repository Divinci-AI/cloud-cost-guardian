# AWS Billing Kill Switch

A Lambda function triggered by AWS Budget alerts via SNS. Automatically stops runaway services when spending exceeds thresholds.

## What It Does

When your AWS Budget threshold is crossed:

1. **Stops EC2 instances** (reversible — EBS volumes persist)
2. **Throttles Lambda functions** (sets reserved concurrency to 0)
3. **Scales down ECS services** (desired count to 0)
4. **Deletes SageMaker endpoints** (stops GPU billing immediately)
5. **Pages PagerDuty** with full incident details

## Setup

### 1. Create an SNS Topic

```bash
aws sns create-topic --name billing-kill-switch
```

### 2. Create an AWS Budget with SNS Action

```bash
aws budgets create-budget \
  --account-id YOUR_ACCOUNT_ID \
  --budget file://budget.json \
  --notifications-with-subscribers file://notifications.json
```

### 3. Deploy the Lambda

```bash
npm install
npm run deploy
```

### 4. Subscribe Lambda to SNS

```bash
aws sns subscribe \
  --topic-arn arn:aws:sns:us-east-1:YOUR_ACCOUNT:billing-kill-switch \
  --protocol lambda \
  --notification-endpoint arn:aws:lambda:us-east-1:YOUR_ACCOUNT:function:aws-billing-kill-switch
```

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `AWS_REGION` | `us-east-1` | Region to monitor |
| `KILL_THRESHOLD` | `0.8` | Budget ratio (0-1) at which to take action |
| `PROTECTED_INSTANCES` | `""` | Comma-separated EC2 instance IDs to never stop |
| `PROTECTED_FUNCTIONS` | `""` | Comma-separated Lambda function names to never throttle |
| `PROTECTED_SERVICES` | `""` | Comma-separated ECS service names to never scale down |
| `PAGERDUTY_ROUTING_KEY` | `""` | PagerDuty Events API v2 routing key |

## Required IAM Permissions

```json
{
  "Effect": "Allow",
  "Action": [
    "ec2:DescribeInstances",
    "ec2:StopInstances",
    "lambda:ListFunctions",
    "lambda:PutFunctionConcurrency",
    "ecs:ListClusters",
    "ecs:ListServices",
    "ecs:UpdateService",
    "sagemaker:ListEndpoints",
    "sagemaker:DeleteEndpoint"
  ],
  "Resource": "*"
}
```

## License

MIT
