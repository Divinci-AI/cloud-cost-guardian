import type { HttpClient } from "../http.js";
import type {
  Rule,
  CreateRuleInput,
  UpdateRuleInput,
  RulePreset,
  AgentTriggerInput,
  AgentTriggerResult,
} from "../types/rules.js";

export class RulesResource {
  constructor(private http: HttpClient) {}

  async list(): Promise<Rule[]> {
    const res = await this.http.get<{ rules: Rule[] }>("/rules");
    return res.rules;
  }

  async create(input: CreateRuleInput): Promise<Rule> {
    const res = await this.http.post<{ rule: Rule }>("/rules", input);
    return res.rule;
  }

  async update(id: string, input: UpdateRuleInput): Promise<Rule> {
    const res = await this.http.put<{ rule: Rule }>(`/rules/${id}`, input);
    return res.rule;
  }

  async delete(id: string): Promise<{ deleted: boolean }> {
    return this.http.delete<{ deleted: boolean }>(`/rules/${id}`);
  }

  async toggle(id: string): Promise<Rule> {
    const res = await this.http.post<{ rule: Rule }>(`/rules/${id}/toggle`);
    return res.rule;
  }

  async presets(): Promise<RulePreset[]> {
    const res = await this.http.get<{ presets: RulePreset[] }>("/rules/presets");
    return res.presets;
  }

  async applyPreset(presetId: string, overrides?: Record<string, unknown>): Promise<Rule> {
    const res = await this.http.post<{ rule: Rule }>(`/rules/presets/${presetId}`, overrides);
    return res.rule;
  }

  async agentTrigger(input: AgentTriggerInput): Promise<AgentTriggerResult> {
    return this.http.post<AgentTriggerResult>("/rules/agent/trigger", input);
  }
}
