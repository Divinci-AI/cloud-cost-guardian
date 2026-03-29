import type { HttpClient } from "../http.js";
import type {
  CloudAccount,
  CreateAccountInput,
  UpdateAccountInput,
  UsageHistory,
} from "../types/accounts.js";
import type { CheckResult } from "../types/monitoring.js";

export class AccountsResource {
  constructor(private http: HttpClient) {}

  async list(): Promise<CloudAccount[]> {
    const res = await this.http.get<{ accounts: CloudAccount[] }>("/cloud-accounts");
    return res.accounts;
  }

  async get(id: string): Promise<CloudAccount> {
    return this.http.get<CloudAccount>(`/cloud-accounts/${id}`);
  }

  async create(input: CreateAccountInput): Promise<CloudAccount> {
    return this.http.post<CloudAccount>("/cloud-accounts", input);
  }

  async update(id: string, input: UpdateAccountInput): Promise<CloudAccount> {
    return this.http.put<CloudAccount>(`/cloud-accounts/${id}`, input);
  }

  async delete(id: string): Promise<{ deleted: boolean }> {
    return this.http.delete<{ deleted: boolean }>(`/cloud-accounts/${id}`);
  }

  async check(id: string): Promise<CheckResult> {
    return this.http.post<CheckResult>(`/cloud-accounts/${id}/check`);
  }

  async usage(id: string, options?: { days?: number }): Promise<UsageHistory> {
    const params = options?.days ? `?days=${options.days}` : "";
    return this.http.get<UsageHistory>(`/cloud-accounts/${id}/usage${params}`);
  }
}
