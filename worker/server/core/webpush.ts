import { eq } from "drizzle-orm";
import { appSecrets, db } from "../../db/index.ts";
import { base64url, fromBase64url } from "./password.ts";
import { env } from "./bindings.ts";

/*
 * Web Push with no dependencies: VAPID (RFC 8292) for the sender's identity and `aes128gcm` payload encryption
 * (RFC 8291), all on WebCrypto, which is native in Workers. The VAPID key pair comes from the VAPID_PUBLIC_KEY /
 * VAPID_PRIVATE_KEY secrets when set; otherwise one is generated on first use and kept in D1 (`app_secrets`), the
 * same way the photo signing key is, so push works on a fresh deployment with no setup.
 */

const enc = new TextEncoder();

interface VapidKeys {
  /** Uncompressed P-256 public key (65 bytes), base64url: what browsers take as `applicationServerKey`. */
  publicKey: string;
  privateKey: CryptoKey;
}

interface PushTarget {
  endpoint: string;
  /** base64url, from the browser's PushSubscription. */
  p256dh: string;
  auth: string;
}

let cached: Promise<VapidKeys> | null = null;

async function importPrivate(jwk: JsonWebKey): Promise<CryptoKey> {
  return crypto.subtle.importKey("jwk", jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
}

/** Builds a private JWK from a raw 32-byte `d` and the 65-byte public point (both base64url). */
function jwkFrom(publicKey: string, d: string): JsonWebKey {
  const pub = fromBase64url(publicKey);
  return {
    kty: "EC",
    crv: "P-256",
    x: base64url(pub.slice(1, 33)),
    y: base64url(pub.slice(33, 65)),
    d,
    ext: true,
  };
}

async function loadKeys(): Promise<VapidKeys> {
  const pub = env("VAPID_PUBLIC_KEY");
  const priv = env("VAPID_PRIVATE_KEY");
  if (pub && priv) return { publicKey: pub, privateKey: await importPrivate(jwkFrom(pub, priv)) };
  const [row] = await db.select().from(appSecrets).where(eq(appSecrets.name, "vapid"));
  if (row) {
    const v = JSON.parse(row.value) as { publicKey: string; d: string };
    return { publicKey: v.publicKey, privateKey: await importPrivate(jwkFrom(v.publicKey, v.d)) };
  }
  const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const raw = new Uint8Array((await crypto.subtle.exportKey("raw", pair.publicKey)) as ArrayBuffer);
  const jwk = (await crypto.subtle.exportKey("jwk", pair.privateKey)) as JsonWebKey;
  const value = JSON.stringify({ publicKey: base64url(raw), d: jwk.d });
  // Two isolates generating at once: the first insert wins and both read it back.
  await db.insert(appSecrets).values({ name: "vapid", value }).onConflictDoNothing();
  const [saved] = await db.select().from(appSecrets).where(eq(appSecrets.name, "vapid"));
  const v = JSON.parse(saved.value) as { publicKey: string; d: string };
  return { publicKey: v.publicKey, privateKey: await importPrivate(jwkFrom(v.publicKey, v.d)) };
}

export function vapidKeys(): Promise<VapidKeys> {
  if (!cached) cached = loadKeys().catch((e) => ((cached = null), Promise.reject(e)));
  return cached;
}

/** A VAPID JWT (ES256) for one push service origin. WebCrypto's ECDSA output is already JOSE's r||s form. */
async function vapidJwt(audience: string, keys: VapidKeys, subject: string, now = Date.now()): Promise<string> {
  const header = base64url(enc.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const claims = base64url(
    enc.encode(JSON.stringify({ aud: audience, exp: Math.floor(now / 1000) + 12 * 3600, sub: subject })),
  );
  const input = `${header}.${claims}`;
  const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, keys.privateKey, enc.encode(input));
  return `${input}.${base64url(new Uint8Array(sig))}`;
}

async function hmac(key: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
  const k = await crypto.subtle.importKey("raw", key as BufferSource, { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
  ]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", k, data as BufferSource));
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/**
 * Encrypts `payload` for one subscription (RFC 8291, a single aes128gcm record). `salt` and `local` are only passed
 * by tests (RFC 8291's worked example); normally both are random per message.
 */
async function encryptPayload(
  target: Pick<PushTarget, "p256dh" | "auth">,
  payload: Uint8Array,
  opts: { salt?: Uint8Array; local?: CryptoKeyPair } = {},
): Promise<Uint8Array> {
  const uaPublic = fromBase64url(target.p256dh);
  const authSecret = fromBase64url(target.auth);
  const local =
    opts.local ??
    ((await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"])) as CryptoKeyPair);
  const asPublic = new Uint8Array((await crypto.subtle.exportKey("raw", local.publicKey)) as ArrayBuffer);
  const uaKey = await crypto.subtle.importKey(
    "raw",
    uaPublic as BufferSource,
    { name: "ECDH", namedCurve: "P-256" },
    false,
    [],
  );
  const shared = new Uint8Array(
    await crypto.subtle.deriveBits({ name: "ECDH", public: uaKey } as never, local.privateKey, 256),
  );
  // HKDF by hand (each output is shorter than one SHA-256 block, so expand is a single HMAC).
  const prkKey = await hmac(authSecret, shared);
  const keyInfo = concat(enc.encode("WebPush: info\0"), uaPublic, asPublic, new Uint8Array([1]));
  const ikm = await hmac(prkKey, keyInfo);
  const salt = opts.salt ?? crypto.getRandomValues(new Uint8Array(16));
  const prk = await hmac(salt, ikm);
  const cek = (await hmac(prk, concat(enc.encode("Content-Encoding: aes128gcm\0"), new Uint8Array([1])))).slice(0, 16);
  const nonce = (await hmac(prk, concat(enc.encode("Content-Encoding: nonce\0"), new Uint8Array([1])))).slice(0, 12);
  const key = await crypto.subtle.importKey("raw", cek as BufferSource, "AES-GCM", false, ["encrypt"]);
  // One record: the payload followed by the 0x02 "last record" delimiter.
  const sealed = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: nonce as BufferSource },
      key,
      concat(payload, new Uint8Array([2])) as BufferSource,
    ),
  );
  const rs = new Uint8Array([0, 0, 16, 0]); // record size 4096
  return concat(salt, rs, new Uint8Array([asPublic.length]), asPublic, sealed);
}

type PushOutcome = "sent" | "gone" | "failed";

/**
 * Hosts of the push services browsers use: Chrome, Edge, Brave, Opera and Samsung Internet (FCM), Firefox (Mozilla
 * autopush), Edge/Windows (WNS) and Safari (Apple). A subscription endpoint is a URL the browser hands us and the Worker
 * later POSTs to, so only these hosts are accepted: nobody can point the Worker at an arbitrary server.
 */
const PUSH_HOSTS = ["fcm.googleapis.com", "push.services.mozilla.com", "notify.windows.com", "push.apple.com"];

/** True for an https URL on the default port, without credentials, on a known push service. */
export function isPushEndpoint(raw: string): boolean {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.protocol !== "https:" || u.username || u.password) return false;
  if (u.port && u.port !== "443") return false;
  const host = u.hostname.toLowerCase();
  return PUSH_HOSTS.some((h) => host === h || host.endsWith(`.${h}`));
}

/** Sends one push. "gone" means the subscription expired (404/410) and should be deleted. */
export async function sendPush(target: PushTarget, message: unknown, subject: string): Promise<PushOutcome> {
  // Rows saved before the allowlist existed are dropped here the first time they would have been used.
  if (!isPushEndpoint(target.endpoint)) return "gone";
  const url = new URL(target.endpoint);
  const keys = await vapidKeys();
  const jwt = await vapidJwt(url.origin, keys, subject);
  const body = await encryptPayload(target, enc.encode(JSON.stringify(message)));
  try {
    const res = await fetch(target.endpoint, {
      method: "POST",
      headers: {
        authorization: `vapid t=${jwt}, k=${keys.publicKey}`,
        "content-encoding": "aes128gcm",
        "content-type": "application/octet-stream",
        ttl: "86400",
        urgency: "normal",
      },
      body: body as BodyInit,
    });
    if (res.status === 404 || res.status === 410) return "gone";
    return res.ok ? "sent" : "failed";
  } catch {
    return "failed";
  }
}
