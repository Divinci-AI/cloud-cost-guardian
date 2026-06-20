/**
 * MongoDB connection hardening — fast-fail + self-healing reconnect.
 *
 * Regression guard for the ks-cluster0 pause outage (2026-06-20): the cluster
 * was paused at boot, mongoose.connect() threw once, and the API never
 * reconnected after resume (needed a manual Cloud Run restart). These tests
 * pin the new behavior in globals/index.ts:
 *  - bufferCommands disabled (fail fast, no 10s buffer)
 *  - connect() failure schedules a retry instead of giving up
 *  - the retry reconnects once the cluster is reachable again — no restart
 *  - a post-connect `disconnected` event re-arms the loop
 *  - no URI configured => no-op (in-memory / test mode)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Controllable mongoose stand-in. A tiny event emitter with a mutable
// readyState mirrors the real connection lifecycle (0=disconnected,
// 1=connected, 2=connecting).
const h = vi.hoisted(() => {
  const conn: any = {
    readyState: 0,
    _listeners: {} as Record<string, Function[]>,
    on(event: string, fn: Function) {
      (this._listeners[event] ||= []).push(fn);
    },
    emit(event: string, ...args: any[]) {
      (this._listeners[event] || []).forEach((fn) => fn(...args));
    },
  };
  return { connect: vi.fn(), setFn: vi.fn(), conn };
});

vi.mock("mongoose", () => ({
  default: {
    set: h.setFn,
    connect: h.connect,
    get connection() {
      return h.conn;
    },
  },
}));

// globals/index.ts imports pg at module load; stub it so importing the module
// never touches a real Postgres pool.
vi.mock("pg", () => ({ Pool: vi.fn(() => ({ on: vi.fn() })) }));

async function loadGlobals() {
  return import("../../src/globals/index.js");
}

beforeEach(() => {
  vi.useFakeTimers();
  h.connect.mockReset();
  h.setFn.mockReset();
  h.conn.readyState = 0;
  h.conn._listeners = {};
  h.conn.__guardianListeners = undefined;
  delete process.env.GUARDIAN_MONGODB_URI;
  delete process.env.MONGO_CONNECTION_URL;
  delete process.env.MONGO_RECONNECT_MS;
  vi.resetModules(); // reset module-level reconnectScheduled latch
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("Mongo connection hardening", () => {
  it("disables command buffering so queries fail fast when disconnected", async () => {
    process.env.GUARDIAN_MONGODB_URI = "mongodb://test/db";
    h.connect.mockResolvedValue(undefined);
    const g = await loadGlobals();

    await g.connectMongoDB();

    expect(h.setFn).toHaveBeenCalledWith("bufferCommands", false);
  });

  it("no-ops when no URI is configured (in-memory / test mode)", async () => {
    const g = await loadGlobals();
    await g.connectMongoDB();

    expect(h.connect).not.toHaveBeenCalled();
    expect(h.setFn).not.toHaveBeenCalled();
    expect(g.isMongoEnabled()).toBe(false);
  });

  it("isMongoEnabled tracks URI presence; isMongoConnected tracks readyState", async () => {
    process.env.GUARDIAN_MONGODB_URI = "mongodb://test/db";
    const g = await loadGlobals();

    expect(g.isMongoEnabled()).toBe(true);
    h.conn.readyState = 0;
    expect(g.isMongoConnected()).toBe(false);
    h.conn.readyState = 1;
    expect(g.isMongoConnected()).toBe(true);
  });

  it("self-heals: first connect fails, a scheduled retry reconnects after resume", async () => {
    process.env.GUARDIAN_MONGODB_URI = "mongodb://test/db";
    // Boot while paused: first attempt throws. After "resume" the retry succeeds.
    h.connect
      .mockRejectedValueOnce(new Error("server selection timed out"))
      .mockImplementationOnce(async () => {
        h.conn.readyState = 1;
        h.conn.emit("connected");
      });

    const g = await loadGlobals();
    await g.connectMongoDB();

    // Boot attempt failed — not connected, but the server is up (never threw).
    expect(h.connect).toHaveBeenCalledTimes(1);
    expect(g.isMongoConnected()).toBe(false);

    // Cluster resumes; the 10s retry fires and reconnects — no restart needed.
    await vi.advanceTimersByTimeAsync(10_000);

    expect(h.connect).toHaveBeenCalledTimes(2);
    expect(g.isMongoConnected()).toBe(true);
  });

  it("re-arms the reconnect loop when an established connection drops", async () => {
    process.env.GUARDIAN_MONGODB_URI = "mongodb://test/db";
    h.connect.mockImplementation(async () => {
      h.conn.readyState = 1;
      h.conn.emit("connected");
    });

    const g = await loadGlobals();
    await g.connectMongoDB();
    expect(h.connect).toHaveBeenCalledTimes(1);
    expect(g.isMongoConnected()).toBe(true);

    // Simulate a drop: readyState falls and mongoose fires 'disconnected'.
    h.conn.readyState = 0;
    h.conn.emit("disconnected");

    // The reconnect loop should re-establish on the next tick.
    await vi.advanceTimersByTimeAsync(10_000);
    expect(h.connect).toHaveBeenCalledTimes(2);
    expect(g.isMongoConnected()).toBe(true);
  });

  it("keeps retrying while the cluster stays down (does not give up after one failure)", async () => {
    process.env.GUARDIAN_MONGODB_URI = "mongodb://test/db";
    h.connect.mockRejectedValue(new Error("still paused"));

    const g = await loadGlobals();
    await g.connectMongoDB();
    expect(h.connect).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(10_000);
    expect(h.connect).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(h.connect).toHaveBeenCalledTimes(3);
    expect(g.isMongoConnected()).toBe(false);
  });
});
