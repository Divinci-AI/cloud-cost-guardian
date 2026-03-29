/**
 * Alert types
 */

export type AlertChannelType = "pagerduty" | "discord" | "slack" | "email" | "webhook";

export interface AlertChannel {
  type: AlertChannelType;
  name: string;
  enabled: boolean;
  config: Record<string, string>;
  configPreview?: string | null;
}

export interface UpdateChannelsInput {
  channels: AlertChannel[];
}

export interface TestAlertResult {
  status: "sent";
  channelsSent: number;
}
