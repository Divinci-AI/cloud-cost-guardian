/**
 * Kill Switch Rule types
 */

export type RuleTrigger = "cost" | "security" | "custom" | "api" | "agent";
export type ConditionOperator = "gt" | "lt" | "gte" | "lte" | "eq";

export type KillAction =
  | "disconnect" | "delete" | "scale-down" | "block-traffic" | "rotate-creds"
  | "snapshot" | "isolate" | "pause-zone" | "stop-instances" | "terminate-instances"
  | "set-quota" | "disable-service" | "disable-billing" | "throttle-lambda"
  | "deny-scp" | "deny-bucket-policy" | "stop-pod" | "terminate-pod"
  | "flush-redis" | "pause-cluster" | "kill-connections";

export interface RuleCondition {
  metric: string;
  operator: ConditionOperator;
  value: number;
  windowMinutes?: number;
}

export interface RuleAction {
  type: KillAction;
  target?: string;
  delay?: number;
  requireApproval?: boolean;
}

export interface Rule {
  id: string;
  name: string;
  enabled: boolean;
  trigger: RuleTrigger;
  conditions: RuleCondition[];
  conditionLogic: "all" | "any";
  actions: RuleAction[];
  cooldownMinutes: number;
  lastFiredAt?: number;
  forensicsEnabled: boolean;
}

export interface CreateRuleInput {
  id: string;
  name: string;
  enabled?: boolean;
  trigger: RuleTrigger;
  conditions: RuleCondition[];
  conditionLogic?: "all" | "any";
  actions: RuleAction[];
  cooldownMinutes?: number;
  forensicsEnabled?: boolean;
}

export interface UpdateRuleInput {
  name?: string;
  enabled?: boolean;
  conditions?: RuleCondition[];
  conditionLogic?: "all" | "any";
  actions?: RuleAction[];
  cooldownMinutes?: number;
  forensicsEnabled?: boolean;
}

export interface RulePreset {
  id: string;
  name: string;
  description: string;
  category: string;
}

export interface AgentTriggerInput {
  agentId?: string;
  threatDescription: string;
  severity?: string;
  recommendedActions: RuleAction[];
  evidence?: unknown;
  autoExecute?: boolean;
}

export interface AgentTriggerResult {
  ruleId: string;
  status: "executing" | "pending_approval";
  message: string;
  rule: Rule;
  evidence?: unknown;
}
