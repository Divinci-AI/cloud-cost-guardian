/**
 * Activity Logger
 *
 * Tracks security-relevant and mutation operations for audit trail.
 * Writes to the activity_log PostgreSQL table.
 * All calls are fire-and-forget to avoid blocking API responses.
 *
 * Resilience strategy:
 * 1. Primary: PostgreSQL INSERT
 * 2. On failure: buffer in memory (up to 500 entries)
 * 3. On buffer overflow: spill to MongoDB as fallback
 * 4. On next successful PG write: flush memory buffer, then drain MongoDB fallback
 */

import { getPostgresPool } from "../globals/index.js";

export interface ActivityLogEntry {
  orgId: string;
  actorUserId: string;
  actorEmail?: string;
  action: string;
  resourceType: string;
  resourceId?: string;
  details?: Record<string, unknown>;
  ipAddress?: string;
}

const BUFFER_CAP = 500;
const MONGO_FALLBACK_WARN_THRESHOLD = 400;
const buffer: ActivityLogEntry[] = [];
let consecutiveFailures = 0;
let mongoFallbackCount = 0;
let lastWarningAt = 0;

/**
 * Log an activity entry. Fire-and-forget — errors are logged but don't
 * propagate to the caller.
 */
export function logActivity(entry: ActivityLogEntry): void {
  let pool;
  try {
    pool = getPostgresPool();
  } catch {
    bufferEntry(entry);
    return;
  }

  insertEntry(pool, entry).then(() => {
    consecutiveFailures = 0;
    flushBuffer(pool);
  }).catch((err) => {
    consecutiveFailures++;
    bufferEntry(entry);
    if (consecutiveFailures <= 3 || consecutiveFailures % 100 === 0) {
      console.error(`[guardian] Failed to log activity (${consecutiveFailures} consecutive failures):`, err.message);
    }
  });
}

function bufferEntry(entry: ActivityLogEntry): void {
  if (buffer.length >= BUFFER_CAP) {
    // Buffer full — spill to MongoDB fallback
    spillToMongo(entry);
    return;
  }
  buffer.push(entry);

  // Warn when buffer is getting full
  const now = Date.now();
  if (buffer.length >= MONGO_FALLBACK_WARN_THRESHOLD && now - lastWarningAt > 60000) {
    lastWarningAt = now;
    console.error(`[guardian] Activity log buffer at ${buffer.length}/${BUFFER_CAP} — PostgreSQL may be down`);
  }
}

/** Spill an entry to MongoDB when the in-memory buffer is full */
function spillToMongo(entry: ActivityLogEntry): void {
  import("mongoose").then((mongoose) => {
    const db = mongoose.default.connection?.db;
    if (!db) {
      // MongoDB also unavailable — drop the entry
      if (mongoFallbackCount === 0) {
        console.error("[guardian] Activity log: both PostgreSQL and MongoDB unavailable — entries are being dropped");
      }
      return;
    }
    db.collection("activity_log_fallback").insertOne({
      ...entry,
      details: entry.details || {},
      createdAt: new Date(),
      _fallback: true,
    }).then(() => {
      mongoFallbackCount++;
      if (mongoFallbackCount === 1 || mongoFallbackCount % 50 === 0) {
        console.error(`[guardian] Activity log: ${mongoFallbackCount} entries spilled to MongoDB fallback`);
      }
    }).catch(() => {
      // Both PG and Mongo failed — entry is lost
    });
  }).catch(() => {
    // Can't even import mongoose
  });
}

function flushBuffer(pool: any): void {
  if (buffer.length === 0) {
    // Memory buffer empty — also drain MongoDB fallback if any
    if (mongoFallbackCount > 0) {
      drainMongoFallback(pool);
    }
    return;
  }

  const toFlush = buffer.splice(0, buffer.length);

  for (const entry of toFlush) {
    insertEntry(pool, entry).catch((err) => {
      if (buffer.length < BUFFER_CAP) {
        buffer.push(entry);
      }
      console.error("[guardian] Failed to flush buffered activity entry:", err.message);
    });
  }
}

/** Drain entries from MongoDB fallback back into PostgreSQL */
function drainMongoFallback(pool: any): void {
  import("mongoose").then(async (mongoose) => {
    const db = mongoose.default.connection?.db;
    if (!db) return;

    const collection = db.collection("activity_log_fallback");
    const entries = await collection.find({}).limit(100).toArray();
    if (entries.length === 0) {
      if (mongoFallbackCount > 0) {
        console.error(`[guardian] Activity log: MongoDB fallback fully drained (${mongoFallbackCount} entries recovered)`);
        mongoFallbackCount = 0;
      }
      return;
    }

    let drained = 0;
    for (const entry of entries) {
      try {
        await pool.query(
          `INSERT INTO activity_log (org_id, actor_user_id, actor_email, action, resource_type, resource_id, details, ip_address, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
          [
            entry.orgId, entry.actorUserId, entry.actorEmail || null,
            entry.action, entry.resourceType, entry.resourceId || null,
            JSON.stringify(entry.details || {}), entry.ipAddress || null,
            entry.createdAt,
          ]
        );
        await collection.deleteOne({ _id: entry._id });
        drained++;
      } catch {
        break; // PG failed again, stop draining
      }
    }
    if (drained > 0) {
      console.error(`[guardian] Activity log: drained ${drained} entries from MongoDB fallback to PostgreSQL`);
    }
  }).catch(() => {});
}

function insertEntry(pool: any, entry: ActivityLogEntry): Promise<any> {
  return pool.query(
    `INSERT INTO activity_log (org_id, actor_user_id, actor_email, action, resource_type, resource_id, details, ip_address)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      entry.orgId,
      entry.actorUserId,
      entry.actorEmail || null,
      entry.action,
      entry.resourceType,
      entry.resourceId || null,
      JSON.stringify(entry.details || {}),
      entry.ipAddress || null,
    ]
  );
}

/** Returns the current buffer size (for monitoring/tests) */
export function getBufferSize(): number {
  return buffer.length;
}

/** Returns consecutive failure count (for monitoring/tests) */
export function getConsecutiveFailures(): number {
  return consecutiveFailures;
}

/** Returns count of entries spilled to MongoDB fallback */
export function getMongoFallbackCount(): number {
  return mongoFallbackCount;
}

/**
 * Query activity log entries with pagination and filtering.
 */
export async function queryActivityLog(
  orgId: string,
  options: {
    page?: number;
    limit?: number;
    action?: string;
    resourceType?: string;
    resourceId?: string;
    actorUserId?: string;
    from?: string;
    to?: string;
  } = {}
): Promise<{ entries: any[]; total: number; page: number; limit: number }> {
  const pool = getPostgresPool();
  const page = Math.max(1, options.page || 1);
  const limit = Math.min(100, Math.max(1, options.limit || 50));
  const offset = (page - 1) * limit;

  const conditions: string[] = ["org_id = $1"];
  const params: any[] = [orgId];
  let paramIdx = 2;

  if (options.action) {
    conditions.push(`action LIKE $${paramIdx}`);
    params.push(`${options.action}%`);
    paramIdx++;
  }
  if (options.resourceType) {
    conditions.push(`resource_type = $${paramIdx}`);
    params.push(options.resourceType);
    paramIdx++;
  }
  if (options.resourceId) {
    conditions.push(`resource_id = $${paramIdx}`);
    params.push(options.resourceId);
    paramIdx++;
  }
  if (options.actorUserId) {
    conditions.push(`actor_user_id = $${paramIdx}`);
    params.push(options.actorUserId);
    paramIdx++;
  }
  if (options.from) {
    conditions.push(`created_at >= $${paramIdx}`);
    params.push(options.from);
    paramIdx++;
  }
  if (options.to) {
    conditions.push(`created_at <= $${paramIdx}`);
    params.push(options.to);
    paramIdx++;
  }

  const where = conditions.join(" AND ");

  const [countResult, dataResult] = await Promise.all([
    pool.query(`SELECT COUNT(*) FROM activity_log WHERE ${where}`, params),
    pool.query(
      `SELECT * FROM activity_log WHERE ${where} ORDER BY created_at DESC LIMIT $${paramIdx} OFFSET $${paramIdx + 1}`,
      [...params, limit, offset]
    ),
  ]);

  return {
    entries: dataResult.rows,
    total: parseInt(countResult.rows[0].count),
    page,
    limit,
  };
}
