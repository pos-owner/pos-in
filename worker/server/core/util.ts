import { base64url, fromBase64url } from "./password.ts";
export { hashPin, verifyPin } from "./password.ts";

/*
 * Everything here runs on Web Platform APIs only (WebCrypto, Intl, TextEncoder), so the Worker needs no Node
 * compatibility layer and the same code runs unchanged under `node --test`.
 */
const enc = new TextEncoder();

/** Today's date in India (YYYY-MM-DD). Rent is due on Indian calendar days. */
export function todayIST(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date());
}
export function monthOf(d: string): string {
  return d.slice(0, 7);
}
export function addMonths(month: string, n: number): string {
  const [y, m] = month.split("-").map(Number);
  const t = y * 12 + (m - 1) + n;
  return `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, "0")}`;
}
export function daysInMonth(month: string): number {
  const [y, m] = month.split("-").map(Number);
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}
export function dueDateFor(month: string, dueDay: number): string {
  const d = Math.min(Math.max(1, dueDay), daysInMonth(month));
  return `${month}-${String(d).padStart(2, "0")}`;
}
/**
 * Due date of a tenancy's charge for `month`. In the move-in month the rent can't fall due before the
 * tenancy starts (a lease starting on the 20th with due day 5 is due on the 20th, not already overdue).
 */
export function chargeDueDate(month: string, dueDay: number, startDate: string): string {
  const d = dueDateFor(month, dueDay);
  return monthOf(startDate) === month && startDate > d ? startDate : d;
}
/** Last day of the standard 11-month lease that starts on `startDate` (a 31st is clamped in shorter months). */
export function defaultLeaseEnd(startDate: string): string {
  return addDays(dueDateFor(addMonths(monthOf(startDate), 11), Number(startDate.slice(8, 10))), -1);
}
export function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(b) - Date.parse(a)) / 86400000);
}
export function addDays(d: string, n: number): string {
  return new Date(Date.parse(d) + n * 86400000).toISOString().slice(0, 10);
}

type ChargeStatus = "upcoming" | "due" | "partial" | "awaiting" | "paid" | "overdue";

/** The single source of truth for a charge's status. */
export function computeStatus(
  c: { amount: number; dueDate: string },
  pays: { amount: number; status: string }[],
  today = todayIST(),
): { status: ChargeStatus; paid: number; pending: number; balance: number; overdue: boolean } {
  let paid = 0;
  let pending = 0;
  for (const p of pays) {
    if (p.status === "confirmed") paid += p.amount;
    else if (p.status === "pending") pending += p.amount;
  }
  const balance = Math.max(0, c.amount - paid);
  const overdue = balance > 0 && today > c.dueDate;
  let status: ChargeStatus;
  if (balance === 0) status = "paid";
  else if (pending > 0) status = "awaiting";
  else if (paid > 0) status = "partial";
  else if (overdue) status = "overdue";
  else if (daysBetween(today, c.dueDate) > 7) status = "upcoming";
  else status = "due";
  return { status, paid, pending, balance, overdue };
}

export function randomToken(bytes = 18): string {
  return base64url(crypto.getRandomValues(new Uint8Array(bytes)));
}
export function randomPin(): string {
  return String(crypto.getRandomValues(new Uint32Array(1))[0] % 1000000).padStart(6, "0");
}

/** Detects supported photo formats from their magic bytes, never from a caller-supplied MIME type. */
export function detectImageMime(bytes: ArrayBuffer | Uint8Array): "image/jpeg" | "image/png" | "image/webp" | null {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (
    b.length >= 8 &&
    b[0] === 0x89 &&
    b[1] === 0x50 &&
    b[2] === 0x4e &&
    b[3] === 0x47 &&
    b[4] === 0x0d &&
    b[5] === 0x0a &&
    b[6] === 0x1a &&
    b[7] === 0x0a
  )
    return "image/png";
  if (
    b.length >= 12 &&
    b[0] === 0x52 &&
    b[1] === 0x49 &&
    b[2] === 0x46 &&
    b[3] === 0x46 &&
    b[8] === 0x57 &&
    b[9] === 0x45 &&
    b[10] === 0x42 &&
    b[11] === 0x50
  )
    return "image/webp";
  return null;
}

/* Signed, short-lived photo URLs (expiry rounded to the hour so URLs stay cacheable). */
const hmacKeys = new Map<string, Promise<CryptoKey>>();
function hmacKey(secret: string): Promise<CryptoKey> {
  let k = hmacKeys.get(secret);
  if (!k) {
    k = crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
      "sign",
      "verify",
    ]);
    hmacKeys.set(secret, k);
  }
  return k;
}
export async function signPath(secret: string, key: string): Promise<string> {
  const exp = Math.ceil((Date.now() / 1000 + 3600) / 3600) * 3600;
  const mac = await crypto.subtle.sign("HMAC", await hmacKey(secret), enc.encode(`${key}.${exp}`));
  return `/api/photos/${encodeURIComponent(key)}?exp=${exp}&sig=${base64url(new Uint8Array(mac))}`;
}
export async function verifySignature(secret: string, key: string, exp: string, sig: string): Promise<boolean> {
  const n = Number(exp);
  if (!Number.isFinite(n) || n < Date.now() / 1000 || !/^[\w-]{43}$/.test(sig)) return false;
  // HMAC verify compares in constant time.
  return crypto.subtle.verify(
    "HMAC",
    await hmacKey(secret),
    fromBase64url(sig) as BufferSource,
    enc.encode(`${key}.${n}`),
  );
}

/** Photo keys in the `photos` store are `p_<random>.<ext>`; who owns each one is recorded in `photo_uploads`. */
export function isPhotoKey(k: string): boolean {
  return /^p_[\w-]{16,64}\.(jpg|png|webp)$/.test(k);
}

/** Constant-time string comparison (hashes both sides so different lengths don't leak through timing). */
export async function safeEqual(a: string, b: string): Promise<boolean> {
  const [x, y] = await Promise.all([a, b].map((v) => crypto.subtle.digest("SHA-256", enc.encode(v))));
  const p = new Uint8Array(x);
  const q = new Uint8Array(y);
  let diff = 0;
  for (let i = 0; i < p.length; i++) diff |= p[i] ^ q[i];
  return diff === 0 && a.length === b.length;
}

export function cleanStr(v: unknown, max = 500): string {
  return typeof v === "string" ? v.trim().slice(0, max) : "";
}
export function cleanInt(v: unknown, min = 0, max = 100_000_000): number | null {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
  if (!Number.isFinite(n)) return null;
  const r = Math.round(n);
  return r < min || r > max ? null : r;
}
export function cleanDate(v: unknown): string | null {
  if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return null;
  const date = new Date(v);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === v ? v : null;
}
export function oneOf<T extends string>(v: unknown, opts: readonly T[]): T | null {
  return typeof v === "string" && (opts as readonly string[]).includes(v) ? (v as T) : null;
}
