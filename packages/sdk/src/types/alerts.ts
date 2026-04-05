/**
 * Alert types
 */

export type AlertChannelType = "pagerduty" | "discord" | "slack" | "email" | "webhook" | "github";

export interface AlertChannel {
  type: AlertChannelType;
  name: string;
  enabled: boolean;
  config: {
    routingKey?: string;
    webhookUrl?: string;
    email?: string;
    githubToken?: string;
    repoOwner?: string;
    repoName?: string;
    workflowFile?: string;
    branchRef?: string;
  };
  configPreview?: string | null;
}

export interface UpdateChannelsInput {
  channels: AlertChannel[];
}

export interface TestAlertResult {
  status: "sent";
  channelsSent: number;
}
