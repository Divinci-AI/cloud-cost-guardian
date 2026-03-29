import { ConnectApiKey } from "./ConnectApiKey";
export function ConnectXAI() {
  return <ConnectApiKey providerId="xai" providerName="xAI (Grok)" description="Monitor Grok API token usage and daily cost." keyLabel="xAI API Key" keyPlaceholder="xai-..." keyHint="Get your key at console.x.ai/api-keys" credentialField="xaiApiKey" buttonColor="#1d9bf0" />;
}
