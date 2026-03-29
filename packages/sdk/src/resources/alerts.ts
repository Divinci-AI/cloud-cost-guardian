import type { HttpClient } from "../http.js";
import type { AlertChannel, TestAlertResult } from "../types/alerts.js";

export class AlertsResource {
  constructor(private http: HttpClient) {}

  async channels(): Promise<AlertChannel[]> {
    const res = await this.http.get<{ channels: AlertChannel[] }>("/alerts/channels");
    return res.channels;
  }

  async updateChannels(channels: AlertChannel[]): Promise<{ updated: boolean; channelCount: number }> {
    return this.http.put<{ updated: boolean; channelCount: number }>("/alerts/channels", { channels });
  }

  async test(): Promise<TestAlertResult> {
    return this.http.post<TestAlertResult>("/alerts/test");
  }
}
