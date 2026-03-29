import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  ApiError,
  AuthenticationError,
  ForbiddenError,
  NotFoundError,
  RateLimitError,
  NetworkError,
  TimeoutError,
} from "@kill-switch/sdk";
import { formatSdkError } from "../src/output.js";

describe("formatSdkError", () => {
  it("maps AuthenticationError to auth message with exit code 2", () => {
    const err = new AuthenticationError({ error: "Invalid key" });
    const result = formatSdkError(err);
    expect(result.message).toContain("ks auth login");
    expect(result.exitCode).toBe(2);
  });

  it("maps ForbiddenError with tier info", () => {
    const err = new ForbiddenError(
      { error: "Upgrade", currentTier: "free", upgradeUrl: "/billing?plan=pro" },
      "Upgrade required",
    );
    const result = formatSdkError(err);
    expect(result.message).toContain("free");
    expect(result.message).toContain("app.kill-switch.net");
    expect(result.exitCode).toBe(1);
  });

  it("maps ForbiddenError without tier info", () => {
    const err = new ForbiddenError({ error: "Not allowed" }, "Not allowed");
    const result = formatSdkError(err);
    expect(result.message).toBe("Not allowed");
    expect(result.exitCode).toBe(2);
  });

  it("maps NotFoundError with helpful hint", () => {
    const err = new NotFoundError({ error: "Not found" }, "Cloud account not found");
    const result = formatSdkError(err);
    expect(result.message).toContain("Cloud account not found");
    expect(result.message).toContain("ks accounts list");
    expect(result.exitCode).toBe(1);
  });

  it("maps RateLimitError with retry time", () => {
    const err = new RateLimitError(30, { error: "Too many" });
    const result = formatSdkError(err);
    expect(result.message).toContain("30s");
    expect(result.exitCode).toBe(1);
  });

  it("maps NetworkError", () => {
    const err = new NetworkError(new Error("ECONNREFUSED"), "https://api.test.com");
    const result = formatSdkError(err);
    expect(result.message).toContain("api.test.com");
    expect(result.exitCode).toBe(1);
  });

  it("maps TimeoutError", () => {
    const err = new TimeoutError(30000);
    const result = formatSdkError(err);
    expect(result.message).toContain("30000ms");
    expect(result.exitCode).toBe(1);
  });

  it("maps generic ApiError", () => {
    const err = new ApiError(400, { error: "Bad request" }, "Bad request");
    const result = formatSdkError(err);
    expect(result.message).toBe("Bad request");
    expect(result.exitCode).toBe(1);
  });

  it("maps plain Error", () => {
    const err = new Error("Something broke");
    const result = formatSdkError(err);
    expect(result.message).toBe("Something broke");
    expect(result.exitCode).toBe(1);
  });

  it("maps non-Error values", () => {
    const result = formatSdkError("string error");
    expect(result.message).toBe("string error");
    expect(result.exitCode).toBe(1);
  });
});
