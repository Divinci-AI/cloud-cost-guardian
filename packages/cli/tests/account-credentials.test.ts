/**
 * Credential + update-input builders for `ks accounts add` / `accounts update`
 * (dogfood feedback C2).
 */
import { describe, it, expect } from "vitest";
import { buildAddCredential, buildUpdateInput, parseBoolFlag } from "../src/account-credentials.js";

describe("buildAddCredential", () => {
  it("maps cloudflare flags", () => {
    expect(buildAddCredential({ token: "t", accountId: "a" })).toEqual({ apiToken: "t", accountId: "a" });
  });

  it("infers MongoDB Atlas from atlas flags", () => {
    const c = buildAddCredential({ atlasPublicKey: "pub", atlasPrivateKey: "priv", atlasProjectId: "proj", atlasClusterName: "c0" });
    expect(c).toEqual({ mongodbSubType: "atlas", atlasPublicKey: "pub", atlasPrivateKey: "priv", atlasProjectId: "proj", atlasClusterName: "c0" });
  });

  it("infers self-hosted MongoDB from a URI", () => {
    const c = buildAddCredential({ mongodbUri: "mongodb+srv://h/db", mongodbDatabase: "db" });
    expect(c).toEqual({ mongodbSubType: "self-hosted", mongodbUri: "mongodb+srv://h/db", mongodbDatabaseName: "db" });
  });

  it("infers Redis Cloud vs self-hosted", () => {
    expect(buildAddCredential({ redisCloudKey: "k", redisCloudSecret: "s", redisSubscriptionId: "42" })).toEqual({
      redisSubType: "redis-cloud", redisCloudAccountKey: "k", redisCloudSecretKey: "s", redisCloudSubscriptionId: "42",
    });
    expect(buildAddCredential({ redisUrl: "redis://h:6379", redisTls: true })).toEqual({
      redisSubType: "self-hosted", redisUrl: "redis://h:6379", redisTlsEnabled: true,
    });
  });

  it("maps neo4j flags", () => {
    expect(buildAddCredential({ neo4jClientId: "id", neo4jClientSecret: "sec", neo4jInstanceId: "inst" })).toEqual({
      neo4jClientId: "id", neo4jClientSecret: "sec", neo4jInstanceId: "inst",
    });
  });

  it("supports the generic --cred key=value escape hatch and --credential-json", () => {
    expect(buildAddCredential({ cred: ["foo=bar", "baz=qux"] })).toEqual({ foo: "bar", baz: "qux" });
    expect(buildAddCredential({ credentialJson: '{"a":"b"}' })).toEqual({ a: "b" });
  });

  it("preserves = inside a --cred value", () => {
    expect(buildAddCredential({ cred: ["uri=mongodb://u:p@h/db?x=1"] })).toEqual({ uri: "mongodb://u:p@h/db?x=1" });
  });

  it("rejects malformed --cred and --credential-json", () => {
    expect(() => buildAddCredential({ cred: ["novalue"] })).toThrow(/key=value/);
    expect(() => buildAddCredential({ credentialJson: "{bad" })).toThrow(/valid JSON/);
  });
});

describe("parseBoolFlag", () => {
  it("parses truthy/falsy strings", () => {
    for (const t of ["true", "on", "yes", "1"]) expect(parseBoolFlag(t)).toBe(true);
    for (const f of ["false", "off", "no", "0"]) expect(parseBoolFlag(f)).toBe(false);
  });
  it("returns undefined when absent", () => {
    expect(parseBoolFlag(undefined)).toBeUndefined();
  });
  it("throws on garbage", () => {
    expect(() => parseBoolFlag("maybe")).toThrow();
  });
});

describe("buildUpdateInput", () => {
  it("only includes fields that were passed", () => {
    expect(buildUpdateInput({ name: "New" })).toEqual({ name: "New" });
    expect(buildUpdateInput({})).toEqual({});
  });

  it("parses numeric thresholds", () => {
    expect(buildUpdateInput({ threshold: ["mongodbDailyCostUSD=50", "connections=200"] })).toEqual({
      thresholds: { mongodbDailyCostUSD: 50, connections: 200 },
    });
  });

  it("rejects non-numeric thresholds", () => {
    expect(() => buildUpdateInput({ threshold: ["x=abc"] })).toThrow(/numeric/);
  });

  it("toggles boolean flags including productionProtected", () => {
    expect(buildUpdateInput({ productionProtected: "false", autoDisconnect: "true" })).toEqual({
      productionProtected: false, autoDisconnect: true,
    });
  });

  it("splits autokill categories and validates status", () => {
    expect(buildUpdateInput({ autokillCategories: "cost, storage" })).toEqual({ autoKillCategories: ["cost", "storage"] });
    expect(() => buildUpdateInput({ status: "frozen" })).toThrow(/active or paused/);
  });
});
