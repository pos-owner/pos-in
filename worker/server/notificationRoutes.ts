import type { Hono } from "hono";
import { and, count, desc, eq, inArray, isNull, lt } from "drizzle-orm";
import { db, notifications, pushSubscriptions } from "../db/index.ts";
import { actorOf, roles, type Env } from "./core/auth.ts";
import { body } from "./core/http.ts";
import { cleanStr } from "./core/util.ts";
import { isPushEndpoint, vapidKeys } from "./core/webpush.ts";
import { notify, sendPendingPushes } from "./domain/notifications.ts";

/*
 * The in-app inbox and Web Push subscriptions. Everything here is scoped to the signed-in person:
 * inbox rows by `recipient_id`, subscriptions by `user_id`. Nobody can read or change anyone else's.
 *
 *   GET  /api/notifications              own inbox, newest first (50 a page, ?before=<id> for the next page)
 *   GET  /api/notifications/unread       { count }
 *   POST /api/notifications/read         { ids?: number[] } marks those (or everything) as read
 *   GET  /api/push/key                   the VAPID public key browsers subscribe with
 *   POST /api/push/subscribe             { endpoint, keys: { p256dh, auth } }
 *   POST /api/push/unsubscribe           { endpoint }
 *   POST /api/push/test                  sends a test notification to yourself
 */

const PAGE = 50;
const B64URL = /^[A-Za-z0-9_-]+$/;

async function unreadCount(userId: string) {
  const [r] = await db
    .select({ n: count() })
    .from(notifications)
    .where(and(eq(notifications.recipientId, userId), isNull(notifications.readAt)));
  return Number(r?.n ?? 0);
}

export function registerNotificationRoutes(api: Hono<Env>) {
  const everyone = roles("owner", "staff", "tenant");

  api.get("/notifications", everyone, async (c) => {
    const a = actorOf(c);
    const before = Number(c.req.query("before"));
    const where =
      Number.isInteger(before) && before > 0
        ? and(eq(notifications.recipientId, a.id), lt(notifications.id, before))
        : eq(notifications.recipientId, a.id);
    const rows = await db
      .select()
      .from(notifications)
      .where(where)
      .orderBy(desc(notifications.id))
      .limit(PAGE + 1);
    const page = rows.slice(0, PAGE);
    return c.json({
      items: page.map((n) => ({
        id: n.id,
        kind: n.kind,
        title: n.title,
        body: n.body,
        url: n.url,
        read: !!n.readAt,
        createdAt: n.createdAt,
      })),
      unread: await unreadCount(a.id),
      more: rows.length > PAGE,
    });
  });

  api.get("/notifications/unread", everyone, async (c) => {
    const a = actorOf(c);
    return c.json({ count: await unreadCount(a.id) });
  });

  api.post("/notifications/read", everyone, async (c) => {
    const a = actorOf(c);
    const b = await body(c);
    const ids = Array.isArray(b.ids)
      ? [...new Set(b.ids.map(Number).filter((n) => Number.isInteger(n) && n > 0))].slice(0, 200)
      : null;
    if (ids && !ids.length) return c.json({ ok: true, unread: await unreadCount(a.id) });
    const mine = and(eq(notifications.recipientId, a.id), isNull(notifications.readAt));
    await db
      .update(notifications)
      .set({ readAt: new Date() })
      .where(ids ? and(mine, inArray(notifications.id, ids)) : mine);
    return c.json({ ok: true, unread: await unreadCount(a.id) });
  });

  /* ---------- Web Push ---------- */

  api.get("/push/key", everyone, async (c) => {
    const keys = await vapidKeys();
    return c.json({ publicKey: keys.publicKey });
  });

  api.post("/push/subscribe", everyone, async (c) => {
    const a = actorOf(c);
    const b = await body(c);
    const endpoint = typeof b.endpoint === "string" ? b.endpoint.trim() : "";
    const keys = (b.keys && typeof b.keys === "object" ? b.keys : {}) as Record<string, unknown>;
    const p256dh = typeof keys.p256dh === "string" ? keys.p256dh.trim() : "";
    const auth = typeof keys.auth === "string" ? keys.auth.trim() : "";
    let ok = endpoint.length > 0 && endpoint.length <= 1000 && isPushEndpoint(endpoint);
    // An uncompressed P-256 point is 87 base64url characters; the auth secret is 16 bytes (22 characters).
    ok &&= B64URL.test(p256dh) && p256dh.length >= 80 && p256dh.length <= 100;
    ok &&= B64URL.test(auth) && auth.length >= 16 && auth.length <= 44;
    if (!ok) return c.json({ error: "This browser sent a push subscription pOS can't use." }, 400);
    const userAgent = (c.req.header("user-agent") ?? "").slice(0, 200);
    // One row per browser: signing in as someone else on the same browser moves the subscription to them.
    await db
      .insert(pushSubscriptions)
      .values({ userId: a.id, ownerId: a.ownerId, endpoint, p256dh, auth, userAgent })
      .onConflictDoUpdate({
        target: pushSubscriptions.endpoint,
        set: { userId: a.id, ownerId: a.ownerId, p256dh, auth, userAgent },
      });
    return c.json({ ok: true });
  });

  api.post("/push/unsubscribe", everyone, async (c) => {
    const a = actorOf(c);
    const b = await body(c);
    const endpoint = typeof b.endpoint === "string" ? b.endpoint.trim() : "";
    if (!endpoint) return c.json({ error: "No subscription given." }, 400);
    const gone = await db
      .delete(pushSubscriptions)
      .where(and(eq(pushSubscriptions.endpoint, endpoint), eq(pushSubscriptions.userId, a.id)))
      .returning({ id: pushSubscriptions.id });
    return c.json({ ok: true, removed: gone.length });
  });

  /** A test notification to yourself: an inbox row, pushed right away to every browser you've turned push on in. */
  api.post("/push/test", everyone, async (c) => {
    const a = actorOf(c);
    const [{ n }] = await db.select({ n: count() }).from(pushSubscriptions).where(eq(pushSubscriptions.userId, a.id));
    await notify([
      {
        ownerId: a.ownerId,
        recipientId: a.id,
        kind: "push_test",
        title: "Notifications are on",
        body: cleanStr("This is how pOS will tell you about payments, requests and leases.", 200),
        url: "/notifications",
        dedupe: `push_test:${Date.now()}`,
      },
    ]);
    const sent = Number(n) ? await sendPendingPushes(a.ownerId) : 0;
    return c.json({ ok: true, devices: Number(n), sent });
  });
}
