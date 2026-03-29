/**
 * API Key types
 */

export interface ApiKey {
  id: string;
  name: string;
  key?: string;
  createdAt?: string;
  lastUsedAt?: string;
}

export interface CreateApiKeyInput {
  name: string;
}

export interface CreateApiKeyResult {
  id: string;
  key: string;
  name: string;
  message: string;
}

export interface RollApiKeyResult {
  id: string;
  key: string;
  name: string;
  previousKeyRevoked: boolean;
  message: string;
}
