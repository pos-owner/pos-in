/*
 * Idempotent create requests for the offline outbox (src/lib/outbox.ts). The app sends a random `clientKey` with each
 * queued entry; the row stores it in a unique `client_key` column. A retry of something already saved finds the
 * original row and returns it instead of saving twice. The index is global, so callers also check that the row they
 * found belongs to the same person in the same workspace; a key owned by anyone else is refused (409).
 */

/** The client's idempotency key, or null when it sent none (the row then keeps `client_key` NULL). */
export function offlineKey(v: unknown): string | null {
  return typeof v === "string" && /^[\w-]{8,64}$/.test(v) ? v : null;
}

/** True when `e` is a unique-constraint failure on `client_key` (a second request with the same key won a race). */
export function isClientKeyConflict(e: unknown): boolean {
  const m = String((e as { message?: string })?.message ?? e) + String((e as { cause?: unknown })?.cause ?? "");
  return /UNIQUE constraint failed/i.test(m) && /client_key/i.test(m);
}

export const KEY_TAKEN = "This entry was already saved by someone else. Discard it and add it again.";
