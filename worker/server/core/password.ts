/**
 * Password and PIN hashing with PBKDF2-SHA256 through WebCrypto (native in Workers, no WASM or npm package).
 *
 * Two stored formats, both `tag$iterations$salt$hash`:
 *
 *  - `p2` (accounts): the hash of a *login key*. The browser has already stretched the password with 100,000
 *    PBKDF2 rounds (`shared/loginKey.ts`), so the Worker adds only `KEY_ITERATIONS` rounds with a random salt.
 *    That keeps sign-in well inside the free plan's 10 ms CPU budget while a stolen database still costs an
 *    attacker 100,000+ rounds per guess.
 *  - `p1` (invite PINs): PBKDF2 of the raw PIN.
 *
 * The iteration count is stored in the hash, so it can change later without breaking existing rows. Workers cap
 * PBKDF2 at 100,000 iterations.
 */
const MAX_ITERATIONS = 100_000;
/** Rounds the Worker adds on top of the browser's 100,000. Cheap (well under a millisecond). */
const KEY_ITERATIONS = 1_000;
/**
 * Invite PINs are six digits, expire within days and lock after a few wrong tries, so extra rounds add CPU time
 * without adding real protection.
 */
const PIN_ITERATIONS = 1_000;
const enc = new TextEncoder();

/** URL-safe base64 without padding. */
export function base64url(b: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < b.length; i++) bin += String.fromCharCode(b[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
export function fromBase64url(s: string): Uint8Array {
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(bin, (ch) => ch.charCodeAt(0));
}

async function derive(secret: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret.normalize("NFKC")), "PBKDF2", false, [
    "deriveBits",
  ]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt: salt as BufferSource, iterations },
    key,
    256,
  );
  return new Uint8Array(bits);
}

async function hashWith(tag: "p1" | "p2", secret: string, iterations: number): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return `${tag}$${iterations}$${base64url(salt)}$${base64url(await derive(secret, salt, iterations))}`;
}

async function matches(secret: string, iter: string, salt: string, hash: string): Promise<boolean> {
  const n = Number(iter);
  if (!salt || !hash || !Number.isInteger(n) || n < 1 || n > MAX_ITERATIONS) return false;
  const expected = fromBase64url(hash);
  const actual = await derive(secret, fromBase64url(salt), n);
  if (actual.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < actual.length; i++) diff |= actual[i] ^ expected[i];
  return diff === 0;
}

/** Stored hash for a login key (see `shared/loginKey.ts`). */
export function hashLoginKey(key: string): Promise<string> {
  return hashWith("p2", key, KEY_ITERATIONS);
}

/** Checks a login key (see `shared/loginKey.ts`) against a stored account hash. */
export async function verifyLoginKey(key: string, stored: string): Promise<boolean> {
  const [tag, iter, salt, hash] = stored.split("$");
  return tag === "p2" && !!key && (await matches(key, iter, salt, hash));
}

/** A well-formed hash that never matches, so an unknown email costs the same time as a wrong password. */
export const DUMMY_HASH = `p2$${KEY_ITERATIONS}$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA`;

/** Invite PINs: a salted PBKDF2 hash. The round count is read back from the stored hash. */
export function hashPin(pin: string): Promise<string> {
  return hashWith("p1", pin, PIN_ITERATIONS);
}
export async function verifyPin(pin: string, stored: string): Promise<boolean> {
  const [tag, iter, salt, hash] = stored.split("$");
  return tag === "p1" && (await matches(pin, iter, salt, hash));
}

export async function sha256(s: string): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(s)));
  return Array.from(d, (x) => x.toString(16).padStart(2, "0")).join("");
}
