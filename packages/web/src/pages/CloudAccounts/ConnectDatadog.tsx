import { ConnectApiKey } from "./ConnectApiKey";
export function ConnectDatadog() {
  return <ConnectApiKey providerId="datadog" providerName="Datadog" description="Monitor host count, log ingestion, and custom metrics costs." keyLabel="Datadog API Key" keyPlaceholder="Paste your Datadog API key" keyHint="Get from Organization Settings > API Keys" credentialField="datadogApiKey" buttonColor="#632ca6" extraFields={[
    { key: "datadogApplicationKey", label: "Application Key", placeholder: "Datadog application key", required: true },
    { key: "datadogSite", label: "Site", placeholder: "us or eu (default: us)", required: false },
  ]} />;
}
