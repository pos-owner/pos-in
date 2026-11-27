/**
 * The expensive half of password hashing, done in the browser.
 *
 * Cloudflare's free plan gives each API request 10 ms of CPU time, and 100,000 rounds of PBKDF2 take several times
 * that. So the app stretches the password here (100,000 rounds of PBKDF2-SHA256, salted with the account's email)
 * and sends only the resulting key. The Worker then hashes that key again with its own random salt and a small
 * number of rounds (`worker/server/core/password.ts`), so a copy of the database costs an attacker the full
 * 100,000+ rounds per guess, and the raw password never needs to be stretched on the server.
 *
 * The Worker imports this file too, for scripts and tests that send a plain password.
 * Emails never change in pOS, so using the email as the salt is safe.
 */
const LOGIN_KEY_ITERATIONS = 100_000;

/** A login key is 32 bytes as URL-safe base64 without padding. */
export const LOGIN_KEY_RE = /^[A-Za-z0-9_-]{43}$/;

const enc = new TextEncoder();

function b64url(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Same normalisation as the API applies to emails (trimmed, lower case). */
const loginEmail = (email: string) => email.trim().slice(0, 254).toLowerCase();

export async function loginKey(email: string, password: string): Promise<string> {
  const base = await crypto.subtle.importKey("raw", enc.encode(password.normalize("NFKC")), "PBKDF2", false, [
    "deriveBits",
  ]);
  const bits = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      hash: "SHA-256",
      salt: enc.encode(`pos-login:${loginEmail(email)}`) as BufferSource,
      iterations: LOGIN_KEY_ITERATIONS,
    },
    base,
    256,
  );
  return b64url(new Uint8Array(bits));
}
