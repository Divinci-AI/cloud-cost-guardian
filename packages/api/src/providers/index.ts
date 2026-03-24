import type { CloudProvider, ProviderId } from "./types.js";
import { cloudflareProvider } from "./cloudflare/checker.js";
import { gcpProvider } from "./gcp/checker.js";
import { awsProvider } from "./aws/checker.js";

const providers: Record<string, CloudProvider> = {
  cloudflare: cloudflareProvider,
  gcp: gcpProvider,
  aws: awsProvider,
};

export function getProvider(id: ProviderId): CloudProvider | undefined {
  return providers[id];
}

export function getAllProviders(): CloudProvider[] {
  return Object.values(providers);
}
