import { and, eq, inArray, sql } from "drizzle-orm";
import { charges, db, leaseTerms, payments, tenancies, tenants } from "../../db/index.ts";
import { addDays, daysBetween, defaultLeaseEnd, monthOf, todayIST } from "../core/util.ts";
import { flow } from "./automations.ts";
import { isHoldover, type Workspace } from "./data.ts";
import { notify, tenantRecipients, type NotifyInput } from "./notifications.ts";
import { prorateRule, reproratedAmount } from "./prorate.ts";

/*
 * Leases: an append-only history of terms (`lease_terms`), renewals and rent revisions, holdovers (a lease that ran
 * past its end date without a move-out keeps billing at the last rent until the owner renews or ends it), and the
 * daily expiry alerts.
 */

type Tenancy = typeof tenancies.$inferSelect;
type LeaseTerm = typeof leaseTerms.$inferSelect;

/** The `lease_alerts` windows (days before the end date), largest first, deduplicated and kept to 1–180. */
function alertWindows(config: Record<string, unknown>): number[] {
  const vals = [config.first, config.second, config.last]
    .map((v) => Math.round(Number(v)))
    .filter((n) => Number.isFinite(n) && n >= 1 && n <= 180);
  return [...new Set(vals)].sort((a, b) => b - a);
}

/**
 * The alert a lease is due today, if any: the smallest window the lease is already inside (so a lease created 20
 * days before its end gets the 30-day alert once, not the 60- and 30-day alerts together). Null when it's further out
 * than every window or already past its end.
 */
function dueWindow(endDate: string, today: string, windows: number[]): number | null {
  const left = daysBetween(today, endDate);
  if (left < 0) return null;
  const inside = windows.filter((w) => left <= w);
  return inside.length ? Math.min(...inside) : null;
}

/** The term history of a tenancy, oldest first. A tenancy from before the history existed gets its initial row. */
export async function leaseHistory(ownerId: string, tn: Tenancy): Promise<LeaseTerm[]> {
  const rows = await db
    .select()
    .from(leaseTerms)
    .where(eq(leaseTerms.tenancyId, tn.id))
    .orderBy(leaseTerms.startDate, leaseTerms.id);
  if (rows.length) return rows;
  const [initial] = await db
    .insert(leaseTerms)
    .values({
      ownerId,
      tenancyId: tn.id,
      startDate: tn.startDate,
      endDate: tn.endDate,
      rent: tn.rent,
      dueDay: tn.dueDay,
      deposit: tn.deposit,
      reason: "initial",
    })
    .returning();
  return [initial];
}

export interface RenewInput {
  kind: "renewal" | "revision";
  /** New lease end (renewal). A revision keeps the current end unless one is given. */
  endDate: string | null;
  rent: number;
  /** The day the new rent starts. */
  effectiveFrom: string;
  dueDay: number;
  deposit: number;
  note: string;
  actorId: string;
}

/** Checks a renewal or revision against the tenancy. Returns an error message, or null when it's fine. */
export function renewError(tn: Tenancy, v: RenewInput): string | null {
  if (tn.status !== "active") return "This tenancy has ended. Add the tenant again for a new lease.";
  if (v.effectiveFrom < tn.startDate) return "The new terms can't start before the tenancy started.";
  if (v.kind === "renewal") {
    if (!v.endDate) return "Choose when the renewed lease ends.";
    if (v.endDate <= v.effectiveFrom) return "The new end date must be after the date it starts.";
    if (tn.endDate && v.endDate <= tn.endDate) return "The renewed lease must end after the current one.";
  }
  if (v.endDate && v.endDate < v.effectiveFrom) return "The lease end must be after the date the new rent starts.";
  if (tn.moveOutDate && v.effectiveFrom > tn.moveOutDate)
    return "This tenant is moving out before then. Cancel the move-out first.";
  return null;
}

/** Default dates for a renewal: starts the day after the current end (or today), runs 11 months. */
export function renewalDefaults(tn: Tenancy, today = todayIST()) {
  const effectiveFrom = tn.endDate && tn.endDate >= today ? addDays(tn.endDate, 1) : today;
  return { effectiveFrom, endDate: defaultLeaseEnd(effectiveFrom) };
}

/**
 * Adds a renewal or revision: one new `lease_terms` row, the tenancy's latest rent/end/due day/deposit, and new
 * rent on charges from the effective month that nobody has paid or claimed yet. Paid or claimed months, and
 * pro-rated months, keep their amount. All in one `db.batch` (atomic). Returns how many charges were repriced.
 */
export async function applyRenewal(ownerId: string, tn: Tenancy, v: RenewInput) {
  const fromMonth = monthOf(v.effectiveFrom);
  const [[term], repriced] = await db.batch([
    db
      .insert(leaseTerms)
      .values({
        ownerId,
        tenancyId: tn.id,
        startDate: v.effectiveFrom,
        endDate: v.endDate,
        rent: v.rent,
        dueDay: v.dueDay,
        deposit: v.deposit,
        reason: v.kind,
        note: v.note,
        createdBy: v.actorId,
      })
      .returning(),
    db
      .update(charges)
      // Utility bills and late fees stay; only the rent part changes.
      .set({ amount: sql`${charges.extra} + ${charges.fees} + ${v.rent}` })
      .where(
        and(
          eq(charges.tenancyId, tn.id),
          sql`${charges.month} >= ${fromMonth}`,
          sql`${charges.rentPart} is null`,
          sql`not exists (select 1 from ${payments} p where p.charge_id = ${charges.id} and p.status in ('confirmed', 'pending'))`,
        ),
      )
      .returning({ id: charges.id }),
    db
      .update(tenancies)
      .set({ rent: v.rent, endDate: v.endDate, dueDay: v.dueDay, deposit: v.deposit })
      .where(and(eq(tenancies.id, tn.id), eq(tenancies.status, "active"))),
  ]);
  return { term, repriced: repriced.length };
}

/** Writes a `revision` row when an owner edits rent, end date, due day or deposit directly. */
export async function recordRevision(ownerId: string, before: Tenancy, after: Tenancy, actorId: string) {
  if (
    before.rent === after.rent &&
    before.endDate === after.endDate &&
    before.dueDay === after.dueDay &&
    before.deposit === after.deposit
  )
    return;
  await leaseHistory(ownerId, before);
  await db.insert(leaseTerms).values({
    ownerId,
    tenancyId: after.id,
    startDate: todayIST() < after.startDate ? after.startDate : todayIST(),
    endDate: after.endDate,
    rent: after.rent,
    dueDay: after.dueDay,
    deposit: after.deposit,
    reason: "revision",
    note: "Edited tenancy details",
    createdBy: actorId,
  });
}

/**
 * After a move-out is scheduled, cancelled or moved: reprices the move-out month's charge when pro-rating is on,
 * in one guarded statement that never takes the amount below what has already been paid. Returns true if it changed.
 */
export async function repriceMoveOutMonth(ownerId: string, tn: Tenancy, oldMoveOut: string | null) {
  const rule = await prorateRule(ownerId);
  if (!rule) return false;
  const months = [...new Set([tn.moveOutDate, oldMoveOut].filter((x): x is string => !!x).map(monthOf))];
  let changed = false;
  for (const month of months) {
    const [c] = await db
      .select()
      .from(charges)
      .where(and(eq(charges.tenancyId, tn.id), eq(charges.month, month)));
    if (!c) continue;
    const next = reproratedAmount({ rent: tn.rent, startDate: tn.startDate, moveOutDate: tn.moveOutDate }, month, rule);
    const currentRent = c.rentPart ?? c.amount - c.extra - c.fees;
    const newRent = next ? next.rentPart : tn.rent;
    const delta = newRent - currentRent;
    if (!delta && (c.proratedDays ?? null) === (next?.proratedDays ?? null)) continue;
    const done = await db
      .update(charges)
      .set({
        amount: sql`${charges.amount} + ${delta}`,
        rentPart: next ? next.rentPart : null,
        proratedDays: next ? next.proratedDays : null,
      })
      .where(
        and(
          eq(charges.id, c.id),
          sql`${charges.amount} + ${delta} >= coalesce((select sum(p.amount) from ${payments} p where p.charge_id = ${c.id} and p.status = 'confirmed'), 0)`,
        ),
      )
      .returning({ id: charges.id });
    changed ||= done.length > 0;
  }
  return changed;
}

/** Display state of a tenancy's lease, shared by the owner and tenant screens. */
export function leaseState(t: Pick<Tenancy, "status" | "endDate" | "moveOutDate">, today = todayIST()) {
  if (t.status !== "active") return "ended" as const;
  if (t.moveOutDate) return "moving_out" as const;
  if (isHoldover(t, today)) return "holdover" as const;
  if (t.endDate && daysBetween(today, t.endDate) <= 60) return "ending" as const;
  return "active" as const;
}

/**
 * Daily: lease-expiry alerts (owner-configurable windows, to the owner; the tenant hears at the middle window) and
 * holdover notices (once per lease end). Deduplicated by `dedupe_key`, so re-running the job never repeats an alert.
 * Returns how many alerts were raised.
 */
export async function runLeaseAlerts(ownerId: string, ws: Workspace): Promise<number> {
  const f = await flow(ownerId, "lease_alerts");
  if (!f.enabled) return 0;
  const today = todayIST();
  const windows = alertWindows(f.config);
  const tenantWindow = windows.length ? windows[Math.floor(windows.length / 2)] : null;
  const unitById = new Map(ws.unitRows.map((u) => [u.id, u]));
  const tenantById = new Map(ws.tenantRows.map((t) => [t.id, t]));
  const items: NotifyInput[] = [];
  const forTenants: { tenantId: number; item: Omit<NotifyInput, "recipientId"> }[] = [];
  for (const tn of ws.tenancyRows) {
    if (tn.status !== "active" || !tn.endDate || tn.moveOutDate) continue;
    const who = tenantById.get(tn.tenantId)?.fullName ?? "Tenant";
    const unit = unitById.get(tn.unitId)?.label ?? "";
    if (tn.endDate < today) {
      items.push({
        ownerId,
        recipientId: ownerId,
        kind: "lease_holdover",
        title: `${who}'s lease ended ${daysBetween(tn.endDate, today)} days ago`,
        body: `${unit}: rent continues at the last amount. Renew the lease or schedule the move-out.`,
        url: `/tenants/${tn.tenantId}`,
        entity: "tenancy",
        entityId: tn.id,
        dedupe: `lease_holdover:${tn.id}:${tn.endDate}`,
      });
      continue;
    }
    const w = dueWindow(tn.endDate, today, windows);
    if (w === null) continue;
    const left = daysBetween(today, tn.endDate);
    items.push({
      ownerId,
      recipientId: ownerId,
      kind: "lease_expiry",
      title: `${who}'s lease ends in ${left} ${left === 1 ? "day" : "days"}`,
      body: `${unit} · ends ${tn.endDate}. Renew it, or schedule the move-out.`,
      url: `/tenants/${tn.tenantId}`,
      entity: "tenancy",
      entityId: tn.id,
      dedupe: `lease_expiry:${w}:${tn.id}:${tn.endDate}`,
    });
    if (w === tenantWindow) {
      forTenants.push({
        tenantId: tn.tenantId,
        item: {
          ownerId,
          kind: "lease_expiry",
          title: `Your lease ends in ${left} ${left === 1 ? "day" : "days"}`,
          body: `Talk to your owner about renewing ${unit}.`,
          url: "/lease",
          entity: "tenancy",
          entityId: tn.id,
          dedupe: `lease_expiry_tenant:${tn.id}:${tn.endDate}`,
        },
      });
    }
  }
  if (forTenants.length) {
    const rows = await db
      .select({ id: tenants.id, userId: tenants.userId })
      .from(tenants)
      .where(
        inArray(
          tenants.id,
          forTenants.map((x) => x.tenantId),
        ),
      );
    for (const x of forTenants) {
      const uid = rows.find((r) => r.id === x.tenantId)?.userId;
      if (uid) items.push({ ...x.item, recipientId: uid });
    }
  }
  return (await notify(items)).length;
}

/** Notifies the tenant(s) on a tenancy. */
export async function tenantItems(tenantId: number, item: Omit<NotifyInput, "recipientId">): Promise<NotifyInput[]> {
  return (await tenantRecipients([tenantId])).map((recipientId) => ({ ...item, recipientId }));
}
