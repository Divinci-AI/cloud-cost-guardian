import type { HttpClient } from "../http.js";
import type { CheckResult, CheckAllResult } from "../types/monitoring.js";

export class MonitoringResource {
  constructor(private http: HttpClient) {}

  async check(accountId: string): Promise<CheckResult> {
    return this.http.post<CheckResult>(`/cloud-accounts/${accountId}/check`);
  }

  async checkAll(): Promise<CheckAllResult> {
    return this.http.post<CheckAllResult>("/check");
  }
}
