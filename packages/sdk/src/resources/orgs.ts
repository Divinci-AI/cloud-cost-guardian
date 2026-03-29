import type { HttpClient } from "../http.js";
import type { Organization, CreateOrgInput, UpdateOrgInput, OrgDetail } from "../types/orgs.js";

export class OrgsResource {
  constructor(private http: HttpClient) {}

  async list(): Promise<{ orgs: Organization[]; activeOrgId: string | null }> {
    return this.http.get<{ orgs: Organization[]; activeOrgId: string | null }>("/orgs");
  }

  async create(input: CreateOrgInput): Promise<Organization> {
    return this.http.post<Organization>("/orgs", input);
  }

  async get(orgId: string): Promise<OrgDetail> {
    return this.http.get<OrgDetail>(`/orgs/${orgId}`);
  }

  async update(orgId: string, input: UpdateOrgInput): Promise<OrgDetail> {
    return this.http.patch<OrgDetail>(`/orgs/${orgId}`, input);
  }

  async delete(orgId: string): Promise<{ deleted: boolean }> {
    return this.http.delete<{ deleted: boolean }>(`/orgs/${orgId}`);
  }

  async switch(orgId: string): Promise<{ switched: boolean; activeOrgId: string }> {
    return this.http.post<{ switched: boolean; activeOrgId: string }>(`/orgs/${orgId}/switch`);
  }

  async convertPersonal(input?: { name?: string }): Promise<OrgDetail> {
    return this.http.post<OrgDetail>("/orgs/convert-personal", input);
  }
}
