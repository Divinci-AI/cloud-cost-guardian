import { ConnectApiKey } from "./ConnectApiKey";
export function ConnectReplicate() {
  return <ConnectApiKey providerId="replicate" providerName="Replicate" description="Monitor GPU prediction costs, model usage, and daily spend." keyLabel="Replicate API Token" keyPlaceholder="r8_..." keyHint="Get your token at replicate.com/account/api-tokens" credentialField="replicateApiToken" buttonColor="#0081fb" />;
}
