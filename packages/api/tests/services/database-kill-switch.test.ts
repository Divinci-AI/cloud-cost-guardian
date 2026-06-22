import { describe, it, expect, vi, beforeEach } from "vitest";

// In-memory fake of the Mongo-backed KillSequenceModel. Supports the exact
// query surface the service uses: equality, $in, $ne, $lt, $gte, $or, $set.
vi.mock("../../src/models/kill-sequence/schema.js", () => {
  const store = new Map<string, any>();

  function matches(doc: any, query: Record<string, any>): boolean {
    for (const [key, cond] of Object.entries(query)) {
      if (key === "$or") {
        if (!(cond as any[]).some(sub => matches(doc, sub))) return false;
        continue;
      }
      if (cond !== null && typeof cond === "object" && !Array.isArray(cond) && !(cond instanceof Date)) {
        for (const [op, val] of Object.entries(cond as Record<string, any>)) {
          const dv = doc[key];
          if (op === "$in") { if (!(val as any[]).includes(dv)) return false; }
          else if (op === "$ne") { if (dv === val) return false; }
          else if (op === "$lt") { if (!(dv < val)) return false; }
          else if (op === "$gte") { if (!(dv >= val)) return false; }
          else throw new Error(`fake model: unsupported operator ${op}`);
        }
      } else if (doc[key] !== cond) {
        return false;
      }
    }
    return true;
  }

  const findDocs = (query: any) => Array.from(store.values()).filter(d => matches(d, query));
  const clone = (d: any) => (d ? JSON.parse(JSON.stringify(d)) : d);

  const KillSequenceModel = {
    create: async (doc: any) => {
      store.set(doc.id, clone(doc));
      return clone(doc);
    },
    findOne: (query: any) => ({
      lean: async () => clone(findDocs(query)[0] ?? null),
    }),
    findOneAndUpdate: (query: any, update: any, _opts?: any) => ({
      lean: async () => {
        const doc = findDocs(query)[0];
        if (!doc) return null;
        Object.assign(doc, update.$set || {});
        return clone(doc);
      },
    }),
    updateOne: async (query: any, update: any) => {
      const doc = findDocs(query)[0];
      if (doc) Object.assign(doc, update.$set || {});
      return { matchedCount: doc ? 1 : 0 };
    },
    find: (query: any) => ({
      sort: () => ({
        limit: () => ({
          lean: async () => findDocs(query).map(clone),
        }),
      }),
    }),
  };

  return { KillSequenceModel, __resetKillSequences: () => store.clear() };
});

import {
  initiateKillSequence,
  advanceKillSequence,
  abortKillSequence,
  getKillSequence,
  listActiveSequences,
  type DatabaseCredential,
} from "../../src/services/database-kill-switch.js";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

const mongoCredential: DatabaseCredential = {
  provider: "mongodb-atlas",
  atlasPublicKey: "test-public",
  atlasPrivateKey: "test-private",
  atlasProjectId: "project-123",
  clusterName: "production-cluster",
};

const cloudSqlCredential: DatabaseCredential = {
  provider: "cloud-sql-postgres",
  gcpAccessToken: "fake-token",
  gcpProjectId: "my-project",
  instanceName: "prod-postgres",
};

describe("Database Kill Switch", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    const mod: any = await import("../../src/models/kill-sequence/schema.js");
    mod.__resetKillSequences();
  });

  describe("Kill Sequence Lifecycle", () => {
    it("creates a kill sequence with default steps", async () => {
      const seq = await initiateKillSequence(mongoCredential, "database-compromise");

      expect(seq.id).toMatch(/^dbkill-/);
      expect(seq.status).toBe("running");
      expect(seq.provider).toBe("mongodb-atlas");
      expect(seq.target).toBe("production-cluster");
      expect(seq.trigger).toBe("database-compromise");
      expect(seq.steps).toHaveLength(4);
      expect(seq.steps.map(s => s.action)).toEqual(["snapshot", "verify-snapshot", "isolate", "nuke"]);
      expect(seq.snapshotVerified).toBe(false);
    });

    it("creates a sequence with custom steps", async () => {
      const seq = await initiateKillSequence(mongoCredential, "test", ["snapshot", "isolate"]);
      expect(seq.steps).toHaveLength(2);
      expect(seq.steps.map(s => s.action)).toEqual(["snapshot", "isolate"]);
    });

    it("can retrieve a sequence by ID", async () => {
      const seq = await initiateKillSequence(mongoCredential, "test");
      const found = await getKillSequence(seq.id);
      expect(found).toBeTruthy();
      expect(found!.id).toBe(seq.id);
    });

    it("scopes retrieval by guardianAccountId", async () => {
      const seq = await initiateKillSequence(mongoCredential, "test", undefined, "org-a");
      expect(await getKillSequence(seq.id, "org-a")).toBeTruthy();
      expect(await getKillSequence(seq.id, "org-b")).toBeNull();
    });

    it("lists active sequences for an org", async () => {
      await initiateKillSequence(mongoCredential, "test1", undefined, "org-a");
      await initiateKillSequence(cloudSqlCredential, "test2", undefined, "org-a");
      await initiateKillSequence(cloudSqlCredential, "other-org", undefined, "org-b");
      const active = await listActiveSequences("org-a");
      expect(active).toHaveLength(2);
    });

    it("can abort a sequence", async () => {
      const seq = await initiateKillSequence(mongoCredential, "test");
      const aborted = await abortKillSequence(seq.id);
      expect(aborted!.status).toBe("aborted");
    });
  });

  describe("SAFETY: Nuke requires verified snapshot", () => {
    it("BLOCKS nuke when snapshot is not verified", async () => {
      // Skip directly to nuke without snapshot
      const seq = await initiateKillSequence(mongoCredential, "compromise", ["nuke"]);

      const result = await advanceKillSequence(seq.id, mongoCredential, true);

      expect(result!.status).toBe("failed");
      expect(result!.steps[0].status).toBe("failed");
      expect(result!.steps[0].result).toContain("SAFETY BLOCK");
      expect(result!.steps[0].result).toContain("Cannot nuke without verified snapshot");
    });

    it("BLOCKS nuke even with human approval if snapshot not verified", async () => {
      const seq = await initiateKillSequence(mongoCredential, "test", ["nuke"]);
      const result = await advanceKillSequence(seq.id, mongoCredential, true); // Has approval but no snapshot

      expect(result!.status).toBe("failed");
      expect(result!.steps[0].result).toContain("SAFETY BLOCK");
    });
  });

  describe("SAFETY: Nuke requires human approval", () => {
    it("pauses for confirmation before nuke", async () => {
      // Simulate snapshot + verify succeeded
      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          text: async () => JSON.stringify({ id: "snap-123" }),
        })
        .mockResolvedValueOnce({
          ok: true,
          text: async () => JSON.stringify({ status: "completed", storageSizeBytes: 1024 }),
        })
        .mockResolvedValueOnce({
          ok: true,
          text: async () => JSON.stringify({ results: [] }), // accessList
        });

      const seq = await initiateKillSequence(mongoCredential, "compromise");

      // Step 1: Snapshot
      await advanceKillSequence(seq.id, mongoCredential);
      // Step 2: Verify
      await advanceKillSequence(seq.id, mongoCredential);
      // Step 3: Isolate
      await advanceKillSequence(seq.id, mongoCredential);

      // Step 4: Nuke — should pause for approval
      const result = await advanceKillSequence(seq.id, mongoCredential); // No humanApproval
      expect(result!.status).toBe("awaiting-confirmation");
      expect(result!.snapshotVerified).toBe(true);
    });

    it("proceeds with nuke after human approval", async () => {
      mockFetch
        .mockResolvedValueOnce({ ok: true, text: async () => JSON.stringify({ id: "snap-456" }) })
        .mockResolvedValueOnce({ ok: true, text: async () => JSON.stringify({ status: "completed", storageSizeBytes: 2048 }) })
        .mockResolvedValueOnce({ ok: true, text: async () => JSON.stringify({ results: [] }) })
        .mockResolvedValueOnce({ ok: true, text: async () => "{}" }); // pause cluster

      const seq = await initiateKillSequence(mongoCredential, "compromise");

      await advanceKillSequence(seq.id, mongoCredential); // snapshot
      await advanceKillSequence(seq.id, mongoCredential); // verify
      await advanceKillSequence(seq.id, mongoCredential); // isolate
      await advanceKillSequence(seq.id, mongoCredential); // nuke pauses

      // Now approve
      const result = await advanceKillSequence(seq.id, mongoCredential, true);
      expect(result!.status).toBe("completed");
      expect(result!.snapshotId).toBe("snap-456");
    });
  });

  describe("CONCURRENCY: step claiming", () => {
    it("rejects a second advance while a step is executing", async () => {
      // Slow snapshot call — resolves only when we release it
      let releaseFetch!: (v: any) => void;
      mockFetch.mockReturnValueOnce(new Promise(resolve => { releaseFetch = resolve; }));

      const seq = await initiateKillSequence(mongoCredential, "test", ["snapshot"]);

      const first = advanceKillSequence(seq.id, mongoCredential);
      // Give the first call a tick to claim the step
      await new Promise(r => setTimeout(r, 10));

      await expect(advanceKillSequence(seq.id, mongoCredential)).rejects.toThrow("already executing");

      releaseFetch({ ok: true, text: async () => JSON.stringify({ id: "snap-1" }) });
      const result = await first;
      expect(result!.status).toBe("completed");
    });
  });

  describe("MongoDB Atlas Steps", () => {
    it("initiates a snapshot via Atlas API", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        text: async () => JSON.stringify({ id: "atlas-snap-789" }),
      });

      const seq = await initiateKillSequence(mongoCredential, "test", ["snapshot"]);
      const result = await advanceKillSequence(seq.id, mongoCredential);

      expect(result!.snapshotId).toBe("atlas-snap-789");
      expect(result!.steps[0].status).toBe("completed");
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining("/backup/snapshots"),
        expect.objectContaining({ method: "POST" })
      );
    });

    it("isolates cluster by removing IP whitelist", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        text: async () => JSON.stringify({ results: [
          { cidrBlock: "0.0.0.0/0" },
          { ipAddress: "1.2.3.4" },
        ]}),
      });
      mockFetch.mockResolvedValue({ ok: true }); // DELETE calls

      const seq = await initiateKillSequence(mongoCredential, "test", ["isolate"]);
      const result = await advanceKillSequence(seq.id, mongoCredential);

      expect(result!.steps[0].status).toBe("completed");
      expect(result!.steps[0].result).toContain("Removed 2 IP whitelist entries");
    });
  });

  describe("Cloud SQL PostgreSQL Steps", () => {
    it("initiates a backup via Cloud SQL API", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        text: async () => JSON.stringify({ id: "backup-001" }),
      });

      const seq = await initiateKillSequence(cloudSqlCredential, "test", ["snapshot"]);
      const result = await advanceKillSequence(seq.id, cloudSqlCredential);

      expect(result!.snapshotId).toBe("backup-001");
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining("/backupRuns"),
        expect.objectContaining({ method: "POST" })
      );
    });

    it("isolates by removing authorized networks", async () => {
      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          text: async () => JSON.stringify({ settings: { ipConfiguration: { authorizedNetworks: [{ value: "0.0.0.0/0" }] } } }),
        })
        .mockResolvedValueOnce({ ok: true, text: async () => "{}" }); // PATCH

      const seq = await initiateKillSequence(cloudSqlCredential, "test", ["isolate"]);
      const result = await advanceKillSequence(seq.id, cloudSqlCredential);

      expect(result!.steps[0].status).toBe("completed");
      expect(result!.steps[0].result).toContain("database isolated");
    });
  });

  describe("Error Handling", () => {
    it("returns null for unknown sequence ID", async () => {
      expect(await advanceKillSequence("nonexistent", mongoCredential)).toBeNull();
    });

    it("does not advance completed sequences", async () => {
      mockFetch.mockResolvedValue({ ok: true, text: async () => JSON.stringify({ id: "s1" }) });
      const seq = await initiateKillSequence(mongoCredential, "test", ["snapshot"]);
      await advanceKillSequence(seq.id, mongoCredential); // completes

      const result = await advanceKillSequence(seq.id, mongoCredential); // no-op
      expect(result!.status).toBe("completed");
    });

    it("marks sequence as failed on API error", async () => {
      mockFetch.mockResolvedValueOnce({ ok: false, text: async () => "Internal Server Error" });

      const seq = await initiateKillSequence(mongoCredential, "test", ["snapshot"]);
      const result = await advanceKillSequence(seq.id, mongoCredential);

      expect(result!.status).toBe("failed");
      expect(result!.steps[0].result).toContain("Snapshot failed");
    });

    it("handles missing credentials gracefully", async () => {
      const badCred: DatabaseCredential = { provider: "mongodb-atlas" };
      const seq = await initiateKillSequence(badCred, "test", ["snapshot"]);
      const result = await advanceKillSequence(seq.id, badCred);

      expect(result!.status).toBe("failed");
      expect(result!.steps[0].result).toContain("Missing Atlas credentials");
    });
  });
});
