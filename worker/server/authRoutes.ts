import { and, desc, eq, gt, isNull, like } from "drizzle-orm";
import type { Context, Hono } from "hono";
import { db, passwordResets, profiles, sessions, users } from "../db/index.ts";
import {
  actorOf,
  currentSessionHash,
  endSession,
  requireClientHeader,
  roles,
  startSession,
  type Env,
} from "./core/auth.ts";
import { env } from "./core/bindings.ts";
import { body } from "./core/http.ts";
import { mailConfigured, sendMail } from "./core/mail.ts";
import { DUMMY_HASH, hashLoginKey, sha256, verifyLoginKey } from "./core/password.ts";
import { LOGIN_KEY_RE, loginKey } from "../../shared/loginKey.ts";
import { rateLimit } from "./core/rateLimit.ts";
import { cleanStr, randomToken } from "./core/util.ts";

/*
 * Built-in email + password accounts. Everything lives in D1: `users`, `sessions` and
 * `password_resets`. Session and reset tokens are stored only as SHA-256 hashes.
 *
 * Passwords: the web app stretches the password in the browser and sends a login `key` (shared/loginKey.ts), so the
 * Worker stays inside the free plan's 10 ms CPU limit. Requests that send only a plain `password` (scripts,
 * tests) also work: the Worker derives the same key itself, which costs more CPU time.
 */

const RESET_MS = 60 * 60_000;
/** Devices are named by this many leading hex characters of their stored token hash (never the token itself). */
const DEVICE_ID_LEN = 16;
const DEVICE_ID = new RegExp(`^[0-9a-f]{${DEVICE_ID_LEN}}$`);
const MIN_PASSWORD = 8;

const normEmail = (v: unknown) => cleanStr(v, 254).toLowerCase();

/**
 * Reads a login key and/or plain password from a request body. `keyField` is the browser-made key, `field` the
 * plain password. With only a password, the key is derived here (the slow path, for API clients such as scripts).
 * `tooShort` is true when a plain password was sent and is shorter than the minimum (the app checks this itself
 * before deriving a key).
 */
async function readCredentials(
  b: Record<string, unknown>,
  email: string,
  keyField = "key",
  field = "password",
): Promise<{ key: string; tooShort: boolean }> {
  const password = typeof b[field] === "string" ? (b[field] as string).slice(0, 256) : "";
  let key = typeof b[keyField] === "string" && LOGIN_KEY_RE.test(b[keyField] as string) ? (b[keyField] as string) : "";
  if (!key && password && email) key = await loginKey(email, password);
  return { key, tooShort: !!password && password.length < MIN_PASSWORD };
}
const validEmail = (e: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);
const ip = (c: Context) =>
  c.req.header("cf-connecting-ip") ?? c.req.header("x-forwarded-for")?.split(",")[0] ?? "local";

/** Rate limit that fails closed: a database problem refuses the request instead of letting it through. */
async function limited(c: Context, key: string, limit: number, windowMs: number) {
  try {
    if (await rateLimit(key, limit, windowMs)) return null;
    return c.json({ error: "Too many tries. Wait a few minutes and try again." }, 429);
  } catch (e) {
    console.error("auth rate limit unavailable", e);
    return c.json({ error: "Sign-in is temporarily unavailable." }, 503);
  }
}

/** Public origin for links in emails: `APP_URL` when set, otherwise the origin of this request. */
function appOrigin(c: Context) {
  return (env("APP_URL") ?? new URL(c.req.url).origin).replace(/\/+$/, "");
}

/** Creates a one-time reset link for `userId` (1 hour). Earlier unused links for the same person stop working. */
async function createResetLink(c: Context, userId: string): Promise<string> {
  const token = randomToken(32);
  await db
    .update(passwordResets)
    .set({ usedAt: new Date() })
    .where(and(eq(passwordResets.userId, userId), isNull(passwordResets.usedAt)));
  await db
    .insert(passwordResets)
    .values({ tokenHash: await sha256(token), userId, expiresAt: new Date(Date.now() + RESET_MS) });
  return `${appOrigin(c)}/?reset=${encodeURIComponent(token)}`;
}

export function registerAuthRoutes(api: Hono<Env>) {
  api.use("/auth/*", requireClientHeader);

  /** Which sign-in options this deployment offers (the web app shows "Forgot password?" only with email). */
  api.get("/auth/config", (c) =>
    c.json({ email: mailConfigured(), signups: env("SIGNUPS") !== "closed", minPassword: MIN_PASSWORD }),
  );

  api.post("/auth/signup", async (c) => {
    const b = await body(c);
    const email = normEmail(b.email);
    const name = cleanStr(b.name, 80);
    // Invitees can always create an account; only brand-new owner sign-ups are closed by SIGNUPS=closed.
    if (env("SIGNUPS") === "closed" && !cleanStr(b.invite, 64))
      return c.json({ error: "New sign-ups are closed. Ask the owner for an invite.", code: "signup_disabled" }, 403);
    if (!validEmail(email)) return c.json({ error: "Enter a valid email address." }, 400);
    if (!name) return c.json({ error: "Enter your name." }, 400);
    const stop = await limited(c, `signup:${ip(c)}`, 10, 60 * 60_000);
    if (stop) return stop;
    const cred = await readCredentials(b, email);
    if (!cred.key || cred.tooShort)
      return c.json({ error: `Use a password with at least ${MIN_PASSWORD} characters.`, code: "weak_password" }, 400);
    const id = `u_${randomToken(16)}`;
    const created = await db
      .insert(users)
      .values({ id, email, name, passwordHash: await hashLoginKey(cred.key) })
      .onConflictDoNothing()
      .returning({ id: users.id });
    if (!created.length)
      return c.json({ error: "That email already has a pOS account. Sign in instead.", code: "user_exists" }, 409);
    await startSession(c, id);
    return c.json({ ok: true, user: { id, email, name } });
  });

  api.post("/auth/signin", async (c) => {
    const b = await body(c);
    const email = normEmail(b.email);
    const hasSecret =
      (typeof b.key === "string" && LOGIN_KEY_RE.test(b.key)) || (typeof b.password === "string" && !!b.password);
    if (!email || !hasSecret) return c.json({ error: "Enter your email and password." }, 400);
    const stop =
      (await limited(c, `signin-ip:${ip(c)}`, 30, 15 * 60_000)) ??
      (await limited(c, `signin:${email}`, 10, 15 * 60_000));
    if (stop) return stop;
    const [u] = await db.select().from(users).where(eq(users.email, email)).limit(1);
    const cred = await readCredentials(b, email);
    const ok = await verifyLoginKey(cred.key, u?.passwordHash ?? DUMMY_HASH);
    if (!u || !ok) return c.json({ error: "That email and password don't match.", code: "invalid_credentials" }, 400);
    await startSession(c, u.id);
    return c.json({ ok: true, user: { id: u.id, email: u.email, name: u.name } });
  });

  api.post("/auth/signout", async (c) => {
    await endSession(c);
    return c.json({ ok: true });
  });

  /** Emails a reset link when email sending is set up. Always answers the same way, so it can't reveal accounts. */
  api.post("/auth/forgot", async (c) => {
    const b = await body(c);
    const email = normEmail(b.email);
    if (!validEmail(email)) return c.json({ error: "Enter your email address." }, 400);
    if (!mailConfigured())
      return c.json(
        { error: "Password reset by email isn't set up. Ask the owner of your workspace for a reset link." },
        501,
      );
    const stop =
      (await limited(c, `forgot-ip:${ip(c)}`, 10, 60 * 60_000)) ??
      (await limited(c, `forgot:${email}`, 3, 60 * 60_000));
    if (stop) return stop;
    const [u] = await db.select().from(users).where(eq(users.email, email)).limit(1);
    if (u) {
      const link = await createResetLink(c, u.id);
      try {
        await sendMail({
          to: email,
          subject: "Reset your pOS password",
          text: `Hi ${u.name || "there"},\n\nOpen this link within an hour to choose a new pOS password:\n${link}\n\nIf you didn't ask for this, ignore this email.`,
        });
      } catch (e) {
        console.error("reset email failed", e);
      }
    }
    return c.json({ ok: true });
  });

  /** Checks a reset link before the person types a new password. */
  api.get("/auth/reset/:token", async (c) => {
    const [r] = await db
      .select({ email: users.email })
      .from(passwordResets)
      .innerJoin(users, eq(passwordResets.userId, users.id))
      .where(
        and(
          eq(passwordResets.tokenHash, await sha256(c.req.param("token"))),
          isNull(passwordResets.usedAt),
          gt(passwordResets.expiresAt, new Date()),
        ),
      )
      .limit(1);
    if (!r) return c.json({ error: "This reset link has expired or was already used. Ask for a new one." }, 410);
    return c.json({ ok: true, email: r.email });
  });

  /** Sets a new password from a reset link, signs out every other device and signs this one in. */
  api.post("/auth/reset", async (c) => {
    const b = await body(c);
    const token = cleanStr(b.token, 128);
    const plain = typeof b.password === "string" ? b.password : "";
    const keyGiven = typeof b.key === "string" && LOGIN_KEY_RE.test(b.key);
    if (!keyGiven && (plain.length < MIN_PASSWORD || plain.length > 256))
      return c.json({ error: `Use a password with at least ${MIN_PASSWORD} characters.` }, 400);
    const stop = await limited(c, `reset-ip:${ip(c)}`, 20, 60 * 60_000);
    if (stop) return stop;
    // Single use: only the request that marks the link used goes on.
    const [used] = await db
      .update(passwordResets)
      .set({ usedAt: new Date() })
      .where(
        and(
          eq(passwordResets.tokenHash, await sha256(token)),
          isNull(passwordResets.usedAt),
          gt(passwordResets.expiresAt, new Date()),
        ),
      )
      .returning({ userId: passwordResets.userId });
    if (!used) return c.json({ error: "This reset link has expired or was already used. Ask for a new one." }, 410);
    const [who] = await db.select({ email: users.email }).from(users).where(eq(users.id, used.userId)).limit(1);
    const cred = await readCredentials(b, who?.email ?? "");
    if (!cred.key) return c.json({ error: "This reset link has expired or was already used. Ask for a new one." }, 410);
    await db.batch([
      db
        .update(users)
        .set({ passwordHash: await hashLoginKey(cred.key), passwordChangedAt: new Date() })
        .where(eq(users.id, used.userId)),
      db.delete(sessions).where(eq(sessions.userId, used.userId)),
    ]);
    await startSession(c, used.userId);
    return c.json({ ok: true });
  });
}

/** Routes that need a signed-in person. Registered after `requireUser`. */
export function registerAccountRoutes(api: Hono<Env>) {
  api.post("/account/password", async (c) => {
    const user = c.get("user");
    const b = await body(c);
    const plain = typeof b.password === "string" ? b.password : "";
    const keyGiven = typeof b.key === "string" && LOGIN_KEY_RE.test(b.key);
    if (!keyGiven && (plain.length < MIN_PASSWORD || plain.length > 256))
      return c.json({ error: `Use a password with at least ${MIN_PASSWORD} characters.` }, 400);
    const stop = await limited(c, `password:${user.id}`, 10, 60 * 60_000);
    if (stop) return stop;
    const [u] = await db.select().from(users).where(eq(users.id, user.id)).limit(1);
    const current = u ? await readCredentials(b, u.email, "currentKey", "current") : null;
    if (!u || !current || !(await verifyLoginKey(current.key, u.passwordHash)))
      return c.json({ error: "Your current password isn't right." }, 400);
    const next = await readCredentials(b, u.email);
    if (!next.key) return c.json({ error: `Use a password with at least ${MIN_PASSWORD} characters.` }, 400);
    // Sign out everywhere, then keep this device signed in.
    await db.batch([
      db
        .update(users)
        .set({ passwordHash: await hashLoginKey(next.key), passwordChangedAt: new Date() })
        .where(eq(users.id, u.id)),
      db.delete(sessions).where(eq(sessions.userId, u.id)),
    ]);
    await startSession(c, u.id);
    return c.json({ ok: true });
  });

  /** Signs out every device, including this one. */
  api.post("/account/signout-all", async (c) => {
    await db.delete(sessions).where(eq(sessions.userId, c.get("user").id));
    await endSession(c);
    return c.json({ ok: true });
  });

  /** Devices signed in to this account (live sessions), most recently active first. */
  api.get("/account/sessions", async (c) => {
    const mine = await currentSessionHash(c);
    const rows = await db
      .select({
        tokenHash: sessions.tokenHash,
        createdAt: sessions.createdAt,
        seenAt: sessions.seenAt,
        userAgent: sessions.userAgent,
        location: sessions.location,
      })
      .from(sessions)
      .where(and(eq(sessions.userId, c.get("user").id), gt(sessions.expiresAt, new Date())))
      .orderBy(desc(sessions.seenAt))
      .limit(50);
    const list = rows.map((r) => ({
      id: r.tokenHash.slice(0, DEVICE_ID_LEN),
      current: r.tokenHash === mine,
      userAgent: r.userAgent,
      location: r.location,
      createdAt: r.createdAt,
      seenAt: r.seenAt,
    }));
    // This device first, then the others by last activity.
    list.sort((a, b) => Number(b.current) - Number(a.current));
    return c.json(list);
  });

  /** Signs out one other device. This device signs out with POST /auth/signout instead. */
  api.delete("/account/sessions/:id", async (c) => {
    const id = c.req.param("id");
    if (!DEVICE_ID.test(id)) return c.json({ error: "Device not found." }, 404);
    if ((await currentSessionHash(c))?.startsWith(id))
      return c.json({ error: "That's this device. Use Sign out instead." }, 400);
    const gone = await db
      .delete(sessions)
      .where(and(eq(sessions.userId, c.get("user").id), like(sessions.tokenHash, `${id}%`)))
      .returning({ tokenHash: sessions.tokenHash });
    if (!gone.length) return c.json({ error: "Device not found." }, 404);
    return c.json({ ok: true });
  });

  /**
   * The owner makes a one-time reset link for someone in their workspace (staff or a tenant) who forgot their
   * password. Works without any email setup: the owner shares the link on WhatsApp.
   */
  api.post("/members/:id/reset-link", roles("owner"), async (c) => {
    const a = actorOf(c);
    const id = c.req.param("id");
    const [p] = await db.select().from(profiles).where(eq(profiles.id, id)).limit(1);
    if (!p || p.ownerId !== a.ownerId || p.id === a.id) return c.json({ error: "Person not found." }, 404);
    const stop = await limited(c, `reset-link:${a.ownerId}`, 20, 60 * 60_000);
    if (stop) return stop;
    return c.json({ url: await createResetLink(c, p.id), name: p.fullName });
  });
}
