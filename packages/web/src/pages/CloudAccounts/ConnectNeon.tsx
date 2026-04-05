import { ConnectApiKey } from "./ConnectApiKey";

export function ConnectNeon() {
  return (
    <ConnectApiKey
      providerId="neon"
      providerName="Neon"
      description="Monitor Neon PostgreSQL compute hours, storage, and data transfer. Protects free tier limits (100 CU-hrs, 0.5 GB storage, 5 GB transfer) and paid plan costs."
      keyLabel="Neon API Key"
      keyPlaceholder="Paste your Neon API key"
      keyHint="Create at console.neon.tech → Account Settings → API Keys"
      credentialField="neonApiKey"
      buttonColor="#00e699"
      extraFields={[
        {
          key: "neonProjectId",
          label: "Project ID (optional)",
          placeholder: "e.g. icy-night-79929587 — leave blank to monitor all projects",
          required: false,
        },
      ]}
    />
  );
}
