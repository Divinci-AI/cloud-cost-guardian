import type { HttpClient } from "../http.js";
import type { ApiKey, CreateApiKeyInput, CreateApiKeyResult, RollApiKeyResult } from "../types/auth.js";

export class AuthResource {
  constructor(private http: HttpClient) {}

  async createKey(input: CreateApiKeyInput): Promise<CreateApiKeyResult> {
    return this.http.post<CreateApiKeyResult>("/auth/api-keys", input);
  }

  async listKeys(): Promise<ApiKey[]> {
    const res = await this.http.get<{ keys: ApiKey[] }>("/auth/api-keys");
    return res.keys;
  }

  async rollKey(id: string): Promise<RollApiKeyResult> {
    return this.http.post<RollApiKeyResult>(`/auth/api-keys/${id}/roll`);
  }

  async revokeKey(id: string): Promise<{ deleted: boolean }> {
    return this.http.delete<{ deleted: boolean }>(`/auth/api-keys/${id}`);
  }
}
