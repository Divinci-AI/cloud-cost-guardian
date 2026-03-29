import type { CloudProvider, ProviderId } from "./types.js";
import { cloudflareProvider } from "./cloudflare/checker.js";
import { gcpProvider } from "./gcp/checker.js";
import { awsProvider } from "./aws/checker.js";
import { runpodProvider } from "./runpod/checker.js";
import { redisProvider } from "./redis/checker.js";
import { mongodbProvider } from "./mongodb/checker.js";
import { openaiProvider } from "./openai/checker.js";
import { anthropicProvider } from "./anthropic/checker.js";
import { xaiProvider } from "./xai/checker.js";
import { replicateProvider } from "./replicate/checker.js";
import { snowflakeProvider } from "./snowflake/checker.js";
import { vercelProvider } from "./vercel/checker.js";
import { datadogProvider } from "./datadog/checker.js";

const providers: Record<string, CloudProvider> = {
  cloudflare: cloudflareProvider,
  gcp: gcpProvider,
  aws: awsProvider,
  runpod: runpodProvider,
  redis: redisProvider,
  mongodb: mongodbProvider,
  openai: openaiProvider,
  anthropic: anthropicProvider,
  xai: xaiProvider,
  replicate: replicateProvider,
  snowflake: snowflakeProvider,
  vercel: vercelProvider,
  datadog: datadogProvider,
};

export function getProvider(id: ProviderId): CloudProvider | undefined {
  return providers[id];
}

export function getAllProviders(): CloudProvider[] {
  return Object.values(providers);
}
