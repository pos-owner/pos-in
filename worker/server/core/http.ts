import { and, eq, inArray } from "drizzle-orm";
import { appSecrets, db, photoUploads } from "../../db/index.ts";
import type { Actor } from "./access.ts";
import { env } from "./bindings.ts";
import { putPhoto } from "./storage.ts";
import { isPhotoKey, randomToken, signPath } from "./util.ts";

/* Shared request helpers for the API routes. */

/**
 * Secret for signing photo URLs. `SIGNING_SECRET` (a Worker secret) if set; otherwise a random key generated once
 * and kept in D1, so a fresh deployment works without extra setup.
 */
let cachedSecret: string | null = null;
export async function secret(): Promise<string> {
  const explicit = env("SIGNING_SECRET");
  if (explicit) return explicit;
  if (cachedSecret) return cachedSecret;
  await db
    .insert(appSecrets)
    .values({ name: "photo_signing", value: randomToken(32) })
    .onConflictDoNothing();
  const [row] = await db.select().from(appSecrets).where(eq(appSecrets.name, "photo_signing"));
  cachedSecret = row.value;
  return cachedSecret;
}
export async function signKeys(keys: (string | null)[]) {
  const s = await secret();
  return Promise.all(keys.filter((k): k is string => !!k).map((k) => signPath(s, k)));
}
/** Stores an uploaded photo under a random key and records who owns it. */
export async function savePhoto(a: Actor, bytes: ArrayBuffer, ext: "jpg" | "png" | "webp") {
  const key = `p_${randomToken(18)}.${ext}`;
  await putPhoto(key, bytes, { owner: a.ownerId, by: a.id });
  await db.insert(photoUploads).values({ key, ownerId: a.ownerId, uploadedBy: a.id });
  return key;
}

/** The subset of `keys` this person may attach: photos they uploaded themselves in this workspace. */
export async function ownedPhotoKeys(a: Actor, keys: unknown[]): Promise<string[]> {
  const strs = keys.filter((k): k is string => typeof k === "string");
  const candidates = strs.filter(isPhotoKey);
  const rows = candidates.length
    ? await db
        .select({ key: photoUploads.key })
        .from(photoUploads)
        .where(
          and(
            inArray(photoUploads.key, candidates),
            eq(photoUploads.ownerId, a.ownerId),
            eq(photoUploads.uploadedBy, a.id),
          ),
        )
    : [];
  const ok = new Set(rows.map((r) => r.key));
  return [...new Set(strs.filter((k) => ok.has(k)))];
}

export async function validPhotoKey(a: Actor, k: unknown): Promise<boolean> {
  return typeof k === "string" && (await ownedPhotoKeys(a, [k])).length === 1;
}

export async function body(c: { req: { json: () => Promise<unknown> } }): Promise<Record<string, unknown>> {
  try {
    const b = await c.req.json();
    return b && typeof b === "object" ? (b as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
