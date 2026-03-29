import { ConnectApiKey } from "./ConnectApiKey";
export function ConnectOpenAI() {
  return <ConnectApiKey providerId="openai" providerName="OpenAI" description="Monitor GPT API token usage, request counts, and daily cost." keyLabel="OpenAI API Key" keyPlaceholder="sk-..." keyHint="Get your key at platform.openai.com/api-keys" credentialField="openaiApiKey" buttonColor="#10a37f" extraFields={[{ key: "openaiOrgId", label: "Organization ID", placeholder: "org-... (from Settings > Organization)", required: false }]} />;
}
