import type { HttpClient } from "../http.js";
import type { AccountInfo, UpdateAccountSettingsInput } from "../types/account.js";

export class AccountResource {
  constructor(private http: HttpClient) {}

  /** Get current authenticated account info */
  async me(): Promise<AccountInfo> {
    return this.http.get<AccountInfo>("/accounts/me");
  }

  /** Update account settings */
  async update(input: UpdateAccountSettingsInput): Promise<AccountInfo> {
    return this.http.patch<AccountInfo>("/accounts/me", input);
  }
}
