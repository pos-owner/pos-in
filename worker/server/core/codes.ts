import { base64url } from "./password.ts";
import { secret } from "./http.ts";
import { safeEqual } from "./util.ts";

/*
 * Short signed codes for things printed on paper: unit QR codes (`/u/<code>`) and the verification QR on receipts
 * (`/verify/<code>`). A code is `<id in base 36>-<HMAC>`; the HMAC (SHA-256 with the server's signing secret, cut to
 * 12 base64url characters, 72 bits) makes codes impossible to guess or walk, so printing one reveals nothing about
 * any other unit or receipt. The `kind` is part of what is signed, so a unit code never works as a receipt code.
 */

const enc = new TextEncoder();
type CodeKind = "unit" | "receipt";

async function mac(kind: CodeKind, id: number): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(await secret()),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(`pos-code:${kind}:${id}`));
  return base64url(new Uint8Array(sig)).slice(0, 12);
}

export async function signedCode(kind: CodeKind, id: number): Promise<string> {
  return `${id.toString(36)}-${await mac(kind, id)}`;
}

/** The id inside a valid code, or null for anything malformed or forged. */
export async function readCode(kind: CodeKind, code: string): Promise<number | null> {
  const m = /^([0-9a-z]{1,10})-([\w-]{12})$/.exec(code ?? "");
  if (!m) return null;
  const id = parseInt(m[1], 36);
  if (!Number.isSafeInteger(id) || id <= 0) return null;
  return (await safeEqual(m[2], await mac(kind, id))) ? id : null;
}
