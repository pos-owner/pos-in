import { and, eq, gt, gte } from "drizzle-orm";
import type { Context, MiddlewareHandler } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { db, profiles, sessions, tenants, users } from "../../db/index.ts";
import type { Actor, Role } from "./access.ts";
import { locationLabel, type CfGeo } from "./geo.ts";
import { sha256 } from "./password.ts";
import { randomToken } from "./util.ts";

export interface IdentityUser {
  id: string;
  email: string;
  name: string;
}

export type Env = { Variables: { user: IdentityUser; actor: Actor | null } };

/*
 * Sessions: a random 32-byte token in an HttpOnly, SameSite=Lax cookie. Only its SHA-256 is stored in D1, so a
 * leaked database can't be replayed as a login. The web app and the API share one origin (the Worker serves both),
 * so there are no CORS or third-party-cookie problems. `Authorization: Bearer <token>` is accepted too, for scripts
 * and tests.
 */
const SESSION_DAYS = 30;
const SESSION_MS = SESSION_DAYS * 86_400_000;
const SLIDE_MS = 60 * 60_000;
const SECURE_COOKIE = "__Host-pos_session";
const DEV_COOKIE = "pos_session";

const isHttps = (c: Context) => new URL(c.req.url).protocol === "https:";

function readToken(c: Context): string | null {
  const h = c.req.header("authorization");
  if (h?.startsWith("Bearer ")) return h.slice(7).trim() || null;
  return getCookie(c, SECURE_COOKIE) ?? getCookie(c, DEV_COOKIE) ?? null;
}

/** SHA-256 of this request's session token (what `sessions.token_hash` stores), or null when signed out. */
export async function currentSessionHash(c: Context): Promise<string | null> {
  const token = readToken(c);
  return token ? sha256(token) : null;
}

/** Cloudflare's geolocation for this request (absent outside Workers, e.g. in tests). */
const requestGeo = (c: Context) => (c.req.raw as unknown as { cf?: CfGeo }).cf;

/**
 * Starts a session for `userId` and sets the cookie. Returns the raw token (only its hash is stored). Also records
 * the account's last sign-in time, which the owner sees in Invites & people.
 */
export async function startSession(c: Context, userId: string): Promise<string> {
  const token = randomToken(32);
  const now = Date.now();
  await db.batch([
    db.insert(sessions).values({
      tokenHash: await sha256(token),
      userId,
      expiresAt: new Date(now + SESSION_MS),
      seenAt: new Date(now),
      userAgent: (c.req.header("user-agent") ?? "").slice(0, 200),
      location: locationLabel(requestGeo(c)),
    }),
    db
      .update(users)
      .set({ lastSignInAt: new Date(now) })
      .where(eq(users.id, userId)),
  ]);
  const secure = isHttps(c);
  setCookie(c, secure ? SECURE_COOKIE : DEV_COOKIE, token, {
    httpOnly: true,
    secure,
    sameSite: "Lax",
    path: "/",
    maxAge: SESSION_MS / 1000,
  });
  return token;
}

/** Ends the current session (sign out) and clears the cookie. */
export async function endSession(c: Context) {
  const token = readToken(c);
  if (token) await db.delete(sessions).where(eq(sessions.tokenHash, await sha256(token)));
  if (isHttps(c)) deleteCookie(c, SECURE_COOKIE, { path: "/", secure: true });
  else deleteCookie(c, DEV_COOKIE, { path: "/" });
}

/**
 * Looks up a live session. Slides its expiry forward at most once an hour, so most requests only read. A session
 * started before the account's last password change is refused, even if a row for it somehow survived.
 */
async function sessionUser(token: string): Promise<IdentityUser | null> {
  const hash = await sha256(token);
  const now = Date.now();
  const [row] = await db
    .select({ id: users.id, email: users.email, name: users.name, seenAt: sessions.seenAt })
    .from(sessions)
    .innerJoin(users, eq(sessions.userId, users.id))
    .where(
      and(
        eq(sessions.tokenHash, hash),
        gt(sessions.expiresAt, new Date(now)),
        gte(sessions.createdAt, users.passwordChangedAt),
      ),
    )
    .limit(1);
  if (!row) return null;
  if (now - row.seenAt.getTime() > SLIDE_MS) {
    await db
      .update(sessions)
      .set({ seenAt: new Date(now), expiresAt: new Date(now + SESSION_MS) })
      .where(eq(sessions.tokenHash, hash));
  }
  return { id: row.id, email: row.email, name: row.name };
}

async function loadActor(user: IdentityUser): Promise<Actor | null> {
  const [p] = await db.select().from(profiles).where(eq(profiles.id, user.id)).limit(1);
  if (!p) return null;
  let tenantIds: number[] = [];
  if (p.role === "tenant") {
    const rows = await db.select({ id: tenants.id }).from(tenants).where(eq(tenants.userId, p.id));
    tenantIds = rows.map((r) => r.id);
  }
  return { id: p.id, role: p.role as Role, ownerId: p.ownerId, name: p.fullName || user.email, tenantIds };
}

/** Mutations must carry a custom header, which cross-site forms and simple requests cannot set (CSRF guard). */
export const requireClientHeader: MiddlewareHandler = async (c, next) => {
  if (c.req.method !== "GET" && c.req.method !== "HEAD" && c.req.header("x-pos-client") !== "1") {
    return c.json({ error: "Missing client header." }, 403);
  }
  await next();
};

/** Requires a valid session. Sets `user` and `actor` (actor is null before onboarding). */
export const requireUser: MiddlewareHandler<Env> = async (c, next) => {
  if (c.req.method !== "GET" && c.req.method !== "HEAD" && c.req.header("x-pos-client") !== "1") {
    return c.json({ error: "Missing client header." }, 403);
  }
  const token = readToken(c);
  if (!token) return c.json({ error: "Please sign in." }, 401);
  const user = await sessionUser(token);
  if (!user) return c.json({ error: "Your session has expired. Please sign in again." }, 401);
  c.set("user", user);
  c.set("actor", await loadActor(user));
  await next();
};

export function roles(...allowed: Role[]): MiddlewareHandler<Env> {
  return async (c, next) => {
    const actor = c.get("actor");
    if (!actor) return c.json({ error: "Finish setting up your account first." }, 403);
    if (!allowed.includes(actor.role)) return c.json({ error: "You don't have access to this." }, 403);
    await next();
  };
}

export function actorOf(c: Context<Env>): Actor {
  const a = c.get("actor");
  if (!a) throw new Error("actor missing");
  return a;
}
