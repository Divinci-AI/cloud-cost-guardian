import type { HttpClient } from "../http.js";
import type {
  StoreDatabaseCredentialInput,
  KillSequence,
  InitiateKillInput,
  AdvanceKillInput,
} from "../types/database.js";

export class DatabaseResource {
  constructor(private http: HttpClient) {}

  async storeCredentials(input: StoreDatabaseCredentialInput): Promise<{ credentialId: string }> {
    return this.http.post<{ credentialId: string }>("/database/credentials", input);
  }

  async deleteCredentials(id: string): Promise<{ deleted: boolean }> {
    return this.http.delete<{ deleted: boolean }>(`/database/credentials/${id}`);
  }

  async initiate(input: InitiateKillInput): Promise<KillSequence & { message: string }> {
    return this.http.post<KillSequence & { message: string }>("/database/kill", input);
  }

  async advance(id: string, input: AdvanceKillInput): Promise<KillSequence> {
    return this.http.post<KillSequence>(`/database/kill/${id}/advance`, input);
  }

  async abort(id: string): Promise<KillSequence & { message: string }> {
    return this.http.post<KillSequence & { message: string }>(`/database/kill/${id}/abort`);
  }

  async list(): Promise<KillSequence[]> {
    const res = await this.http.get<{ sequences: KillSequence[] }>("/database/kill");
    return res.sequences;
  }

  async get(id: string): Promise<KillSequence> {
    return this.http.get<KillSequence>(`/database/kill/${id}`);
  }
}
