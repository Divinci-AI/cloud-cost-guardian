import { ConnectApiKey } from "./ConnectApiKey";
export function ConnectAnthropic() {
  return <ConnectApiKey providerId="anthropic" providerName="Anthropic" description="Monitor Claude API token usage and daily cost." keyLabel="Anthropic API Key" keyPlaceholder="sk-ant-..." keyHint="Get your key at console.anthropic.com/settings/keys" credentialField="anthropicApiKey" buttonColor="#d4a574" extraFields={[{ key: "anthropicWorkspaceId", label: "Workspace ID", placeholder: "From Settings (optional)", required: false }]} />;
}
