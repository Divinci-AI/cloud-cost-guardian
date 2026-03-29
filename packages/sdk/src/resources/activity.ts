import type { HttpClient } from "../http.js";
import type { ActivityEntry, ActivityQuery } from "../types/activity.js";
import type { PaginatedResponse } from "../types/common.js";

export class ActivityResource {
  constructor(private http: HttpClient) {}

  async list(query?: ActivityQuery): Promise<PaginatedResponse<ActivityEntry>> {
    const params = new URLSearchParams();
    if (query?.page) params.set("page", String(query.page));
    if (query?.limit) params.set("limit", String(query.limit));
    if (query?.action) params.set("action", query.action);
    if (query?.resourceType) params.set("resourceType", query.resourceType);
    if (query?.resourceId) params.set("resourceId", query.resourceId);
    if (query?.actorUserId) params.set("actorUserId", query.actorUserId);
    if (query?.from) params.set("from", query.from);
    if (query?.to) params.set("to", query.to);

    const qs = params.toString();
    return this.http.get<PaginatedResponse<ActivityEntry>>(`/activity${qs ? `?${qs}` : ""}`);
  }
}
