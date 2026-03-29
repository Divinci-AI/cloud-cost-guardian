import type { HttpClient } from "../http.js";
import type { AnalyticsOverview } from "../types/analytics.js";

export class AnalyticsResource {
  constructor(private http: HttpClient) {}

  async overview(): Promise<AnalyticsOverview> {
    return this.http.get<AnalyticsOverview>("/analytics/overview");
  }
}
