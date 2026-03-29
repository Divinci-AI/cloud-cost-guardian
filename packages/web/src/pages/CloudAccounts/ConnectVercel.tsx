import { ConnectApiKey } from "./ConnectApiKey";
export function ConnectVercel() {
  return <ConnectApiKey providerId="vercel" providerName="Vercel" description="Monitor function invocations, bandwidth, and build minutes." keyLabel="Vercel API Token" keyPlaceholder="Paste your Vercel token" keyHint="Create at vercel.com/account/tokens" credentialField="vercelApiToken" buttonColor="#171717" extraFields={[{ key: "vercelTeamId", label: "Team ID", placeholder: "team_... (from Team Settings)", required: false }]} />;
}
