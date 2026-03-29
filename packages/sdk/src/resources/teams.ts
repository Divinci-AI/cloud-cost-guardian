import type { HttpClient } from "../http.js";
import type {
  TeamMember,
  TeamInvitation,
  InviteInput,
  InviteResult,
  AcceptInviteInput,
  UpdateMemberInput,
} from "../types/teams.js";

export class TeamsResource {
  constructor(private http: HttpClient) {}

  async members(): Promise<{ members: TeamMember[]; invitations: TeamInvitation[] }> {
    return this.http.get<{ members: TeamMember[]; invitations: TeamInvitation[] }>("/team/members");
  }

  async invite(input: InviteInput): Promise<InviteResult> {
    return this.http.post<InviteResult>("/team/invite", input);
  }

  async acceptInvite(input: AcceptInviteInput): Promise<{ joined: boolean; member: TeamMember }> {
    return this.http.post<{ joined: boolean; member: TeamMember }>("/team/invite/accept", input);
  }

  async updateMember(memberId: string, input: UpdateMemberInput): Promise<{ updated: boolean; member: TeamMember }> {
    return this.http.patch<{ updated: boolean; member: TeamMember }>(`/team/members/${memberId}`, input);
  }

  async removeMember(memberId: string): Promise<{ removed: boolean; email: string }> {
    return this.http.delete<{ removed: boolean; email: string }>(`/team/members/${memberId}`);
  }

  async revokeInvitation(invitationId: string): Promise<{ revoked: boolean; email: string }> {
    return this.http.delete<{ revoked: boolean; email: string }>(`/team/invitations/${invitationId}`);
  }
}
