import { and, eq, gt, inArray, isNull } from "drizzle-orm";
import { charges, db, notifications, profiles, pushSubscriptions, tenancies, tenants, units } from "../../db/index.ts";
import { env } from "../core/bindings.ts";
import { sendPush } from "../core/webpush.ts";

/*
 * Notifications: the in-app inbox (one `notifications` row per recipient per event) plus Web Push. Any feature calls
 * `notify(...)`; the unique `dedupe_key` makes repeats (a retried request, the daily job running twice) a no-op.
 * Push delivery is best-effort and never fails the request that raised the event.
 */

export type NotifyKind =
  | "payment_claim"
  | "payment_confirmed"
  | "payment_rejected"
  | "request_new"
  | "request_urgent"
  | "request_assigned"
  | "request_update"
  | "lease_expiry"
  | "lease_holdover"
  | "lease_renewed"
  | "settlement"
  | "late_fee"
  | "rent_due"
  | "expense_pending"
  | "meter_pending"
  | "recurring_expense"
  | "push_test";

export interface NotifyInput {
  ownerId: string;
  recipientId: string;
  kind: NotifyKind;
  title: string;
  body?: string;
  /** In-app path to open, e.g. /tenants/4. */
  url?: string;
  entity?: string;
  entityId?: string | number;
  /** Unique per recipient and event, e.g. `lease_expiry:30:<tenancyId>:<endDate>`. The recipient id is appended. */
  dedupe: string;
}

/** Inserts inbox rows (skipping duplicates). Returns the ids actually created. Never throws. */
export async function notify(items: NotifyInput[]): Promise<number[]> {
  const rows = items
    .filter((i) => i.recipientId)
    .map((i) => ({
      ownerId: i.ownerId,
      recipientId: i.recipientId,
      kind: i.kind,
      title: i.title.slice(0, 140),
      body: (i.body ?? "").slice(0, 400),
      url: i.url ?? "/",
      entity: i.entity ?? "",
      entityId: i.entityId == null ? null : String(i.entityId),
      dedupeKey: `${i.dedupe}:${i.recipientId}`.slice(0, 200),
    }));
  if (!rows.length) return [];
  try {
    const out: number[] = [];
    // D1 caps bound parameters at 100 per statement: 10 columns, so 9 rows a statement.
    for (let k = 0; k < rows.length; k += 9) {
      const r = await db
        .insert(notifications)
        .values(rows.slice(k, k + 9))
        .onConflictDoNothing()
        .returning({ id: notifications.id });
      out.push(...r.map((x) => x.id));
    }
    return out;
  } catch (e) {
    console.error("notify failed", e);
    return [];
  }
}

/** The workspace owner (always) plus, optionally, every staff member. */
export async function workspaceManagers(ownerId: string, withStaff = false): Promise<string[]> {
  if (!withStaff) return [ownerId];
  const rows = await db
    .select({ id: profiles.id })
    .from(profiles)
    .where(and(eq(profiles.ownerId, ownerId), inArray(profiles.role, ["owner", "staff"])));
  return [...new Set([ownerId, ...rows.map((r) => r.id)])];
}

/** Signed-in profile ids for tenant records (tenants who haven't joined yet have none). */
export async function tenantRecipients(tenantIds: number[]): Promise<string[]> {
  if (!tenantIds.length) return [];
  const rows = await db.select({ userId: tenants.userId }).from(tenants).where(inArray(tenants.id, tenantIds));
  return rows.map((r) => r.userId).filter((x): x is string => !!x);
}

/** Most pushes one call sends (each costs a little CPU for encryption; the rest go out on the next run). */
const MAX_PUSHES_PER_RUN = 25;

/** Who the push service is told the sender is (RFC 8292 `sub`): an https URL or a mailto address. */
function pushSubject() {
  const explicit = env("VAPID_SUBJECT") ?? env("APP_URL");
  if (explicit && /^(https:|mailto:)/.test(explicit)) return explicit;
  const from = env("EMAIL_FROM");
  return from ? `mailto:${from.replace(/^.*<|>.*$/g, "")}` : "mailto:push@pos-app.in";
}

/**
 * Daily (and after events): sends Web Push for inbox rows that haven't been pushed yet (from the last two days).
 * Rows whose recipient has no subscription are marked as handled too, so they aren't looked at again.
 * Expired subscriptions are deleted. Returns pushes sent. Never throws.
 */
export async function sendPendingPushes(ownerId: string): Promise<number> {
  try {
    const rows = await db
      .select()
      .from(notifications)
      .where(
        and(
          eq(notifications.ownerId, ownerId),
          isNull(notifications.pushedAt),
          gt(notifications.createdAt, new Date(Date.now() - 2 * 86_400_000)),
        ),
      )
      .orderBy(notifications.id)
      .limit(MAX_PUSHES_PER_RUN);
    if (!rows.length) return 0;
    const subs = await db
      .select()
      .from(pushSubscriptions)
      .where(inArray(pushSubscriptions.userId, [...new Set(rows.map((r) => r.recipientId))]));
    const subject = pushSubject();
    let sent = 0;
    const gone = new Set<number>();
    let budget = MAX_PUSHES_PER_RUN;
    for (const n of rows) {
      for (const s of subs.filter((x) => x.userId === n.recipientId && !gone.has(x.id))) {
        if (budget-- <= 0) break;
        const r = await sendPush(
          s,
          { title: n.title, body: n.body, url: n.url, tag: `${n.kind}:${n.entityId ?? n.id}`, id: n.id },
          subject,
        );
        if (r === "sent") sent++;
        if (r === "gone") gone.add(s.id);
      }
    }
    await db.batch([
      db
        .update(notifications)
        .set({ pushedAt: new Date() })
        .where(
          inArray(
            notifications.id,
            rows.map((r) => r.id),
          ),
        ),
      ...(gone.size ? [db.delete(pushSubscriptions).where(inArray(pushSubscriptions.id, [...gone]))] : []),
    ] as unknown as Parameters<typeof db.batch>[0]);
    return sent;
  } catch (e) {
    console.error("push delivery failed", e);
    return 0;
  }
}

/** Something that can keep work running after the response (a Hono context on Workers). */
type Waiter = { executionCtx: { waitUntil(p: Promise<unknown>): void } };

/**
 * Records inbox rows for an event and pushes them after the response is sent. Outside Workers (tests, scripts) there
 * is no execution context, so the push runs inline instead. Never throws, never fails the request.
 */
export async function announce(c: Waiter | null, items: NotifyInput[]): Promise<void> {
  const created = await notify(items);
  if (!created.length) return;
  const owners = [...new Set(items.map((i) => i.ownerId))];
  const work = Promise.all(owners.map((o) => sendPendingPushes(o))).then(() => undefined);
  try {
    if (!c) throw new Error("no context");
    c.executionCtx.waitUntil(work);
  } catch {
    await work;
  }
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const monthText = (m: string) => `${MONTHS[Number(m.slice(5, 7)) - 1] ?? ""} ${m.slice(0, 4)}`;
const inr = (n: number) => `₹${Math.round(n).toLocaleString("en-IN")}`;

/**
 * Inbox rows for a payment event: a tenant's "I have paid" goes to the owner; a confirmation or rejection goes to
 * the tenant. `ref` (the payment or batch id) makes the dedupe key, so a retried request notifies once.
 */
export async function paymentNotice(
  ownerId: string,
  e: {
    event: "claim" | "confirmed" | "rejected";
    chargeId?: number;
    tenancyId?: number;
    amount: number;
    months?: number;
    ref: string | number;
  },
): Promise<NotifyInput[]> {
  try {
    const base = db
      .select({
        tenancyId: tenancies.id,
        tenantId: tenancies.tenantId,
        tenantName: tenants.fullName,
        unitLabel: units.label,
        month: charges.month,
      })
      .from(tenancies)
      .innerJoin(tenants, eq(tenancies.tenantId, tenants.id))
      .innerJoin(units, eq(tenancies.unitId, units.id))
      .leftJoin(charges, eq(charges.tenancyId, tenancies.id));
    const [row] = e.chargeId
      ? await base.where(eq(charges.id, e.chargeId)).limit(1)
      : e.tenancyId
        ? await base.where(eq(tenancies.id, e.tenancyId)).limit(1)
        : [];
    if (!row) return [];
    const what =
      e.months && e.months > 1 ? `${e.months} months` : e.chargeId && row.month ? monthText(row.month) : "rent";
    const first = (row.tenantName || "Your tenant").split(/[\s&]/)[0];
    if (e.event === "claim") {
      const recipients = await workspaceManagers(ownerId);
      return recipients.map((recipientId) => ({
        ownerId,
        recipientId,
        kind: "payment_claim" as const,
        title: `${first} says they paid ${inr(e.amount)}`,
        body: `${row.unitLabel} · ${what}. Check your bank or UPI app, then confirm.`,
        url: "/rent",
        entity: "payment",
        entityId: e.ref,
        dedupe: `payment_claim:${e.ref}`,
      }));
    }
    const recipients = await tenantRecipients([row.tenantId]);
    return recipients.map((recipientId) => ({
      ownerId,
      recipientId,
      kind: e.event === "confirmed" ? ("payment_confirmed" as const) : ("payment_rejected" as const),
      title: e.event === "confirmed" ? `Payment of ${inr(e.amount)} confirmed` : "Your owner couldn't find a payment",
      body:
        e.event === "confirmed"
          ? `For ${what}. Your receipt is in History.`
          : `${inr(e.amount)} for ${what} wasn't received. Check the UPI app and tell your owner again.`,
      url: e.event === "confirmed" ? "/history" : "/",
      entity: "payment",
      entityId: e.ref,
      dedupe: `payment_${e.event}:${e.ref}`,
    }));
  } catch (err) {
    console.error("payment notice failed", err);
    return [];
  }
}
