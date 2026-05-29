import { describe, it, expect, afterEach } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { startProxy } from "../src/proxy.js";

/**
 * Security regression (H-1): the metering proxy forwards the caller's LLM API
 * key upstream, so it MUST bind to loopback only — never 0.0.0.0, which would
 * expose the key-forwarding proxy to the local network.
 */
describe("startProxy network binding", () => {
  let server: Server | undefined;

  afterEach(async () => {
    if (server) {
      await new Promise<void>((resolve) => server!.close(() => resolve()));
      server = undefined;
    }
  });

  it("binds to 127.0.0.1, not 0.0.0.0", async () => {
    // port 0 → OS picks an ephemeral free port
    server = startProxy({ port: 0, flavor: "anthropic", upstream: "https://api.anthropic.com" });
    await new Promise<void>((resolve) => server!.once("listening", () => resolve()));
    const addr = server.address() as AddressInfo;
    expect(addr.address).toBe("127.0.0.1");
  });
});
