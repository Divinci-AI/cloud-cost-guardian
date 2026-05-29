/**
 * Config file management — ~/.kill-switch/config.json
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, chmodSync } from "fs";
import { join } from "path";
import { homedir } from "os";

export interface KillSwitchConfig {
  apiKey?: string;
  apiUrl?: string;
}

const CONFIG_DIR = join(homedir(), ".kill-switch");
const CONFIG_FILE = join(CONFIG_DIR, "config.json");
const DEFAULT_API_URL = "https://api.kill-switch.net";

export function loadConfig(): KillSwitchConfig {
  try {
    const raw = readFileSync(CONFIG_FILE, "utf-8");
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

export function saveConfig(config: KillSwitchConfig): void {
  if (!existsSync(CONFIG_DIR)) {
    mkdirSync(CONFIG_DIR, { recursive: true });
  }
  writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2) + "\n");
  chmodSync(CONFIG_FILE, 0o600); // owner read/write only
}

export function deleteConfig(): void {
  try {
    writeFileSync(CONFIG_FILE, "{}\n");
  } catch {
    // ignore
  }
}

/**
 * Resolve the API key from (in priority order):
 * 1. KILL_SWITCH_API_KEY env var
 * 2. --api-key flag (passed at call site)
 * 3. Config file
 */
export function resolveApiKey(flagKey?: string): string | undefined {
  return process.env.KILL_SWITCH_API_KEY || flagKey || loadConfig().apiKey;
}

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

/**
 * Resolve the API URL. The resolved endpoint receives the user's API key, so we
 * refuse anything that isn't https:// (http:// allowed only for localhost) —
 * this prevents a poisoned env var / config from redirecting the key over an
 * insecure or unexpected channel (security: M-1).
 */
export function resolveApiUrl(flagUrl?: string): string {
  const url = process.env.KILL_SWITCH_API_URL || flagUrl || loadConfig().apiUrl || DEFAULT_API_URL;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Invalid API URL: "${url}". Set a valid https:// URL.`);
  }
  const localhost = LOCAL_HOSTS.has(parsed.hostname);
  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && localhost)) {
    throw new Error(
      `Refusing to use API URL "${url}": it must be https:// (http:// allowed only for localhost). ` +
        `This protects your API key from being sent over an insecure channel.`,
    );
  }
  return url;
}

export { CONFIG_DIR, CONFIG_FILE, DEFAULT_API_URL };
