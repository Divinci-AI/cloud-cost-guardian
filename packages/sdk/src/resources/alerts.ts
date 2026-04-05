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

  /** Append a single channel without replacing existing ones. */
  async addChannel(channel: Omit<AlertChannel, "configPreview">): Promise<{ updated: boolean; channelCount: number }> {
    const existing = await this.channels();
    return this.updateChannels([...existing, channel as AlertChannel]);
  }

  /** Remove a channel by index or by name match. */
  async removeChannel(nameOrIndex: string | number): Promise<{ updated: boolean; channelCount: number }> {
    const existing = await this.channels();
    const updated = typeof nameOrIndex === "number"
      ? existing.filter((_, i) => i !== nameOrIndex)
      : existing.filter(c => c.name !== nameOrIndex);
    return this.updateChannels(updated);
  }

  async test(): Promise<TestAlertResult> {
    return this.http.post<TestAlertResult>("/alerts/test");
  }
}
