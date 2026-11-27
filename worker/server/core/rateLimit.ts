import { lt, sql } from "drizzle-orm";
import { db, rateLimits } from "../../db/index.ts";

/**
 * Increments one fixed-window counter. The database upsert makes limits effective across Worker
 * isolates and leaves a database failure to callers as an explicit denied request (fail closed).
 */
export async function rateLimit(key: string, limit: number, windowMs: number, now = Date.now()): Promise<boolean> {
  if (!key || !Number.isInteger(limit) || limit < 1 || windowMs < 1) return false;
  const bucket = String(Math.floor(now / windowMs));
  const [row] = await db
    .insert(rateLimits)
    .values({ key, bucket, count: 1 })
    .onConflictDoUpdate({
      target: [rateLimits.key, rateLimits.bucket],
      set: { count: sql`${rateLimits.count} + 1`, updatedAt: new Date(now) },
    })
    .returning({ count: rateLimits.count });
  return !!row && row.count <= limit;
}

export async function pruneRateLimits(olderThan: Date): Promise<number> {
  const deleted = await db
    .delete(rateLimits)
    .where(lt(rateLimits.updatedAt, olderThan))
    .returning({ key: rateLimits.key });
  return deleted.length;
}
