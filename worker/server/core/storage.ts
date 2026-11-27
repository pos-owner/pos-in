import { bindings } from "./bindings.ts";

/*
 * Photos live in D1 (table `photo_data`), so no object storage is needed. Browsers never read the table: they load photos
 * through short-lived HMAC-signed API links (`/api/photos/:key`), which the Worker serves with a long browser cache.
 *
 * `data` is base64 text. D1 hands text back as-is, while BLOB columns arrive as an array of numbers, which costs far
 * more CPU on the Free plan. A D1 row can hold 2 MB, and base64 adds a third, so uploads stay under MAX_PHOTO_BYTES.
 */

/** Largest photo accepted. 1.2 MB of JPEG is about 1.6 MB of base64, safely inside D1's 2 MB row limit. */
export const MAX_PHOTO_BYTES = 1_200_000;

type Base64Native = {
  fromBase64?: (s: string) => Uint8Array;
};
type Base64Proto = { toBase64?: () => string };

function toBase64(bytes: Uint8Array): string {
  const native = (bytes as unknown as Base64Proto).toBase64;
  if (typeof native === "function") return native.call(bytes);
  let out = "";
  for (let i = 0; i < bytes.length; i += 0x8000) out += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(out);
}

function fromBase64(text: string): Uint8Array {
  const native = (Uint8Array as unknown as Base64Native).fromBase64;
  if (typeof native === "function") return native.call(Uint8Array, text);
  const bin = atob(text);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export async function putPhoto(key: string, bytes: ArrayBuffer, _meta: Record<string, string> = {}): Promise<void> {
  if (bytes.byteLength > MAX_PHOTO_BYTES) throw new Error("photo too large for D1");
  await bindings()
    .DB.prepare("INSERT OR REPLACE INTO photo_data (key, data, size, created_at) VALUES (?, ?, ?, ?)")
    .bind(key, toBase64(new Uint8Array(bytes)), bytes.byteLength, Date.now())
    .run();
}

export async function getPhoto(key: string): Promise<ArrayBuffer | null> {
  const row = await bindings()
    .DB.prepare("SELECT data FROM photo_data WHERE key = ?")
    .bind(key)
    .first<{ data: string }>();
  if (!row) return null;
  const bytes = fromBase64(row.data);
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}
