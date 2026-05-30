/**
 * Endpoint safety checks (security: M-1).
 *
 * The proxy forwards the caller's LLM API key to `upstream`, and breach alerts
 * POST the user's ks_live key to `apiUrl`. A poisoned local config / flag could
 * redirect those credentials to an attacker. We can't host-allowlist (users may
 * self-host the API), but we can refuse insecure schemes and surface a warning
 * when the host isn't the expected default — so a redirect is never silent.
 */

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

/** True for http(s) URLs that are safe to send credentials to. */
export function isSafeEndpoint(raw: string): boolean {
  try {
    const u = new URL(raw);
    if (u.protocol === "https:") return true;
    // plaintext http is only acceptable to loopback (local dev / self-test)
    return u.protocol === "http:" && LOCAL_HOSTS.has(u.hostname);
  } catch {
    return false;
  }
}

/** Validate a credential-bearing endpoint; throws on an unsafe URL. */
export function assertSafeEndpoint(raw: string, label: string): string {
  if (!isSafeEndpoint(raw)) {
    throw new Error(
      `Refusing to use ${label}="${raw}": it must be an https:// URL ` +
        `(http:// is allowed only for localhost). This protects your API key ` +
        `from being sent over an insecure or unexpected channel.`,
    );
  }
  return raw;
}

/** Warn (non-fatal) to stderr when a credential-bearing host isn't the default. */
export function warnIfUnexpectedHost(raw: string, expectedHost: string, label: string): void {
  try {
    const host = new URL(raw).hostname;
    if (host !== expectedHost) {
      process.stderr.write(
        `⚠  agent-guard: ${label} points at "${host}", not "${expectedHost}". ` +
          `Your API key will be sent there — make sure that's intended.\n`,
      );
    }
  } catch {
    /* assertSafeEndpoint handles invalid URLs */
  }
}
