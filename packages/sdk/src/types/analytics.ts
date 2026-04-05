/**
 * Analytics types
 */

export interface DailyCost {
  date: string;
  cost: number;
  services: number;
  violations: number;
}

export interface AccountCostBreakdown {
  cloudAccountId: string;
  provider: string;
  totalCost: number;
  avgDailyCost: number;
}

export interface AnalyticsOverview {
  dailyCosts: DailyCost[];
  totalSpendPeriod: number;
  avgDailyCost: number;
  projectedMonthlyCost: number;
  savingsEstimate: number;
  killSwitchActions: number;
  accountBreakdown: AccountCostBreakdown[];
}
