import { and, eq, inArray, desc, sql } from "drizzle-orm";
import {
  db,
  properties,
  units,
  tenants,
  tenancies,
  charges,
  payments,
  paymentBatches,
  activityLog,
  leaseTerms,
  profiles,
  type Executor,
  type Tx,
} from "../../db/index.ts";
import { addMonths, chargeDueDate, computeStatus, monthOf, todayIST } from "../core/util.ts";
import { chargeRent, prorateRule } from "./prorate.ts";

export async function logActivity(actorId: string, action: string, entity: string, entityId?: string | number) {
  await db
    .insert(activityLog)
    .values({ actorId, action, entity, entityId: entityId == null ? null : String(entityId) });
}

/** Everything structural in one workspace. Fewer than ~10 units, so loading it whole is cheap. */
export async function loadWorkspace(ownerId: string) {
  const props = await db.select().from(properties).where(eq(properties.ownerId, ownerId)).orderBy(properties.id);
  const propIds = props.map((p) => p.id);
  const unitRows = propIds.length
    ? await db.select().from(units).where(inArray(units.propertyId, propIds)).orderBy(units.id)
    : [];
  const unitIds = unitRows.map((u) => u.id);
  const tenancyRows = unitIds.length
    ? await db.select().from(tenancies).where(inArray(tenancies.unitId, unitIds)).orderBy(desc(tenancies.startDate))
    : [];
  const tenantRows = await db.select().from(tenants).where(eq(tenants.ownerId, ownerId)).orderBy(tenants.fullName);
  return { props, unitRows, tenancyRows, tenantRows };
}
export type Workspace = Awaited<ReturnType<typeof loadWorkspace>>;

const lastEnsured = new Map<string, number>();

/**
 * The last month an active tenancy is billed for, given the current month. Only a scheduled move-out
 * (`move_out_date`) stops billing: a lease that runs past its end date is a holdover and keeps being charged.
 */
function lastBilledMonth(t: Workspace["tenancyRows"][number], current: string): string {
  return t.moveOutDate && monthOf(t.moveOutDate) < current ? monthOf(t.moveOutDate) : current;
}

/** An active tenancy whose lease end date has passed without a move-out: still billed, waiting for a renewal. */
export function isHoldover(
  t: { status: string; endDate: string | null; moveOutDate?: string | null },
  today = todayIST(),
) {
  return t.status === "active" && !!t.endDate && t.endDate < today && !t.moveOutDate;
}

/**
 * Ends active tenancies whose scheduled move-out day has passed (the day after it, India time), so their units
 * become vacant. Never ends a tenancy just because its lease end date passed (that is a holdover).
 * Updates `ws` in place so callers see the change. Returns the number of tenancies ended.
 */
async function endMovedOutTenancies(ws: Workspace, today = todayIST()): Promise<number> {
  const due = ws.tenancyRows.filter((t) => t.status === "active" && !!t.moveOutDate && t.moveOutDate < today);
  if (!due.length) return 0;
  const ended = await db
    .update(tenancies)
    .set({ status: "ended" })
    .where(
      and(
        inArray(
          tenancies.id,
          due.map((t) => t.id),
        ),
        eq(tenancies.status, "active"),
      ),
    )
    .returning({ id: tenancies.id });
  const ids = new Set(ended.map((r) => r.id));
  for (const t of ws.tenancyRows) if (ids.has(t.id)) t.status = "ended";
  return ended.length;
}

/**
 * Creates one charge per active tenancy per month, up to the current month (or the move-out month), then ends
 * tenancies whose move-out day has passed. Charges come first so a tenant's final month is never missed.
 * Idempotent: the unique (tenancy_id, month) index makes repeats a no-op.
 */
export async function ensureCharges(ownerId: string, ws?: Workspace, force = false): Promise<number> {
  const now = Date.now();
  if (!force && (lastEnsured.get(ownerId) ?? 0) > now - 60_000) {
    // Charges were generated within the last minute; still make sure moved-out tenancies are ended.
    if (ws) await endMovedOutTenancies(ws);
    return 0;
  }
  lastEnsured.set(ownerId, now);
  const w = ws ?? (await loadWorkspace(ownerId));
  const current = monthOf(todayIST());
  const rule = await prorateRule(ownerId);
  const activeIds = w.tenancyRows.filter((t) => t.status === "active").map((t) => t.id);
  // The lease history decides each month's rent: a renewal agreed early only changes rent from its start month.
  const terms = activeIds.length
    ? await db
        .select({ tenancyId: leaseTerms.tenancyId, startDate: leaseTerms.startDate, rent: leaseTerms.rent })
        .from(leaseTerms)
        .where(inArray(leaseTerms.tenancyId, activeIds))
        .orderBy(leaseTerms.startDate, leaseTerms.id)
    : [];
  const rows: (typeof charges.$inferInsert)[] = [];
  for (const t of w.tenancyRows) {
    if (t.status !== "active") continue;
    let m = monthOf(t.startDate);
    const last = lastBilledMonth(t, current);
    const mine = terms.filter((x) => x.tenancyId === t.id);
    // Cap history at 24 months so an old start date can't create an unbounded backlog.
    if (m < addMonths(last, -23)) m = addMonths(last, -23);
    for (; m <= last; m = addMonths(m, 1)) {
      rows.push({
        tenancyId: t.id,
        month: m,
        ...chargeRent({ ...t, rent: rentForMonth(t.rent, mine, m) }, m, rule),
        dueDate: chargeDueDate(m, t.dueDay, t.startDate),
        status: "due",
      });
    }
  }
  // One statement whatever the number of rows (withParamLimit inlines the values past D1's 100-parameter cap).
  const created = rows.length
    ? (await db.insert(charges).values(rows).onConflictDoNothing().returning({ id: charges.id })).length
    : 0;
  await endMovedOutTenancies(w);
  return created;
}

/**
 * The rent for `month` from a tenancy's lease terms (oldest first): the latest term starting in or before that month.
 * Falls back to the tenancy's current rent when there is no history or the month is before every term.
 */
function rentForMonth(current: number, terms: { startDate: string; rent: number }[], month: string): number {
  let rent: number | null = null;
  for (const x of terms) if (monthOf(x.startDate) <= month) rent = x.rent;
  return rent ?? current;
}

export interface LedgerRow {
  id: number;
  month: string;
  amount: number;
  /** Utility bills included in `amount`. */
  extra: number;
  /** Late fees (not waived) included in `amount`. */
  fees: number;
  /** The rent part of `amount` when the month is pro-rated (null for full rent). */
  rentPart: number | null;
  /** Days billed in a pro-rated month (null for a full month). */
  proratedDays: number | null;
  dueDate: string;
  status: string;
  paid: number;
  pending: number;
  balance: number;
  overdue: boolean;
  tenancyId: number;
  tenantId: number;
  tenantName: string;
  tenantPhone: string;
  unitId: number;
  unitLabel: string;
  propertyId: number;
  propertyName: string;
  payments: {
    id: number;
    amount: number;
    method: string;
    utr: string;
    status: string;
    paidOn: string;
    note: string;
    createdAt: string;
    voidReason: string;
    voidedAt: string | null;
    /** Set when this month is one part of a multi-month payment. */
    batchId: number | null;
    batch: PaymentBatchInfo | null;
  }[];
}

/** The whole transfer a month's payment belongs to, so screens can say "part of ₹30,000 for 3 months". */
export interface PaymentBatchInfo {
  id: number;
  amount: number;
  months: number;
  from: string;
  to: string;
  status: string;
}

/** Charges with payments and a computed status. Callers scope `tenancyIds` to what the actor may see. */
export async function loadLedger(
  ws: Workspace,
  opts: { tenancyIds?: number[]; month?: string } = {},
): Promise<LedgerRow[]> {
  const ids = opts.tenancyIds ?? ws.tenancyRows.map((t) => t.id);
  if (!ids.length) return [];
  const where = opts.month
    ? and(inArray(charges.tenancyId, ids), eq(charges.month, opts.month))
    : inArray(charges.tenancyId, ids);
  const chargeRows = await db.select().from(charges).where(where).orderBy(desc(charges.month));
  const chargeIds = chargeRows.map((c) => c.id);
  const payRows = chargeIds.length
    ? await db.select().from(payments).where(inArray(payments.chargeId, chargeIds)).orderBy(desc(payments.createdAt))
    : [];
  const batches = await batchInfo([...new Set(payRows.map((p) => p.batchId).filter((x): x is number => x != null))]);
  const today = todayIST();
  const tenancyById = new Map(ws.tenancyRows.map((t) => [t.id, t]));
  const unitById = new Map(ws.unitRows.map((u) => [u.id, u]));
  const propById = new Map(ws.props.map((p) => [p.id, p]));
  const tenantById = new Map(ws.tenantRows.map((t) => [t.id, t]));
  return chargeRows.map((c) => {
    const pays = payRows.filter((p) => p.chargeId === c.id);
    const s = computeStatus(c, pays, today);
    const tn = tenancyById.get(c.tenancyId)!;
    const u = unitById.get(tn.unitId)!;
    const p = propById.get(u.propertyId)!;
    const tt = tenantById.get(tn.tenantId);
    return {
      id: c.id,
      month: c.month,
      amount: c.amount,
      extra: c.extra,
      fees: c.fees ?? 0,
      rentPart: c.rentPart ?? null,
      proratedDays: c.proratedDays ?? null,
      dueDate: c.dueDate,
      ...s,
      tenancyId: tn.id,
      tenantId: tn.tenantId,
      tenantName: tt?.fullName ?? "Tenant",
      tenantPhone: tt?.phone ?? "",
      unitId: u.id,
      unitLabel: u.label,
      propertyId: p.id,
      propertyName: p.name,
      payments: pays.map((x) => ({
        id: x.id,
        amount: x.amount,
        method: x.method,
        utr: x.utr,
        status: x.status,
        paidOn: x.paidOn,
        note: x.note,
        createdAt: x.createdAt.toISOString(),
        voidReason: x.voidReason,
        voidedAt: x.voidedAt ? x.voidedAt.toISOString() : null,
        batchId: x.batchId ?? null,
        batch: x.batchId != null ? (batches.get(x.batchId) ?? null) : null,
      })),
    };
  });
}

/** Amount, month span and status of each multi-month payment (two queries, only when there are any). */
export async function batchInfo(ids: number[]): Promise<Map<number, PaymentBatchInfo>> {
  const out = new Map<number, PaymentBatchInfo>();
  if (!ids.length) return out;
  const [rows, spans] = await db.batch([
    db.select().from(paymentBatches).where(inArray(paymentBatches.id, ids)),
    db
      .select({
        batchId: payments.batchId,
        from: sql<string>`min(${charges.month})`,
        to: sql<string>`max(${charges.month})`,
      })
      .from(payments)
      .innerJoin(charges, eq(payments.chargeId, charges.id))
      .where(inArray(payments.batchId, ids))
      .groupBy(payments.batchId),
  ]);
  for (const b of rows) {
    const s = spans.find((x) => x.batchId === b.id);
    out.set(b.id, {
      id: b.id,
      amount: b.amount,
      months: b.months,
      from: s?.from ?? "",
      to: s?.to ?? "",
      status: b.status,
    });
  }
  return out;
}

/**
 * Stored status for several months of one tenancy at once (three queries whatever the number of months, so a
 * multi-month payment stays inside D1's per-request query budget).
 */
export async function syncChargeStatuses(tenancyId: number, months: string[]) {
  if (!months.length) return;
  const rows = await db
    .select()
    .from(charges)
    .where(and(eq(charges.tenancyId, tenancyId), inArray(charges.month, months)));
  if (!rows.length) return;
  const pays = await db
    .select({ chargeId: payments.chargeId, amount: payments.amount, status: payments.status })
    .from(payments)
    .where(
      inArray(
        payments.chargeId,
        rows.map((r) => r.id),
      ),
    );
  const updates = rows
    .map((c) => ({
      c,
      status: computeStatus(
        c,
        pays.filter((p) => p.chargeId === c.id),
      ).status,
    }))
    .filter((x) => x.status !== x.c.status)
    .map((x) => db.update(charges).set({ status: x.status }).where(eq(charges.id, x.c.id)));
  if (updates.length) await db.batch(updates as unknown as Parameters<typeof db.batch>[0]);
}

/**
 * Keeps the stored status column in sync (useful for exports); the API always recomputes. Pass the transaction
 * when the payments or amount just changed inside one, so the status commits with them.
 */
export async function syncChargeStatus(chargeId: number, ex: Executor = db) {
  const [c] = await ex.select().from(charges).where(eq(charges.id, chargeId));
  if (!c) return;
  const pays = await ex.select().from(payments).where(eq(payments.chargeId, chargeId));
  const { status } = computeStatus(c, pays);
  if (status !== c.status) await ex.update(charges).set({ status }).where(eq(charges.id, chargeId));
}

/**
 * A charge with its totals, computed from its payments. D1 has no row locks, so this is only a snapshot for
 * messages and early checks: every write that depends on the balance re-checks it inside the same SQL statement
 * (see `insertPaymentIfDue` and `settlePendingPayment`).
 */
export async function lockCharge(_tx: Tx, chargeId: number) {
  const [c] = await db.select().from(charges).where(eq(charges.id, chargeId));
  if (!c) return null;
  const pays = await db
    .select({ amount: payments.amount, status: payments.status })
    .from(payments)
    .where(eq(payments.chargeId, chargeId));
  return { charge: c, ...computeStatus(c, pays) };
}

/** Still due on a charge right now, as SQL: its amount minus confirmed payments. */
const dueNow = (chargeId: number) =>
  sql`((select ${charges.amount} from ${charges} where ${charges.id} = ${chargeId}) - coalesce((select sum(p2.amount) from ${payments} p2 where p2.charge_id = ${chargeId} and p2.status = 'confirmed'), 0))`;

/**
 * Inserts a payment only if it still fits: `amount` is at most what is due at that instant, and (for a tenant's
 * "I have paid") no other report is waiting. One INSERT ... SELECT ... WHERE, which D1 runs atomically, so two
 * submissions at once can never both pass. Returns the new id, or null when the guard refused it.
 */
export async function insertPaymentIfDue(
  v: typeof payments.$inferInsert,
  opts: { noPending?: boolean } = {},
): Promise<number | null> {
  const noPending = opts.noPending
    ? sql` and not exists (select 1 from ${payments} p3 where p3.charge_id = ${v.chargeId} and p3.status = 'pending')`
    : sql``;
  const rows = await db.all<{ id: number }>(sql`
    insert into ${payments} (charge_id, amount, method, utr, status, recorded_by, paid_on, note, created_at)
    select ${v.chargeId}, ${v.amount}, ${v.method}, ${v.utr ?? ""}, ${v.status ?? "confirmed"}, ${v.recordedBy ?? null},
      ${v.paidOn}, ${v.note ?? ""}, ${Date.now()}
    where ${dueNow(v.chargeId)} >= ${v.amount}${noPending}
    returning id`);
  return rows[0]?.id ?? null;
}

/**
 * Moves a pending payment to confirmed or rejected, once. Confirming also requires that it still fits the balance
 * at that instant (cash may have been recorded since the tenant reported it). Returns true when this call did it.
 */
export async function settlePendingPayment(
  paymentId: number,
  chargeId: number,
  action: "confirm" | "reject",
): Promise<boolean> {
  const fits = action === "confirm" ? sql` and amount <= ${dueNow(chargeId)}` : sql``;
  const rows = await db.all<{ id: number }>(sql`
    update ${payments} set status = ${action === "confirm" ? "confirmed" : "rejected"}
    where id = ${paymentId} and status = 'pending'${fits}
    returning id`);
  return rows.length > 0;
}

export function activeTenancyByUnit(ws: Workspace) {
  const m = new Map<number, Workspace["tenancyRows"][number]>();
  for (const t of ws.tenancyRows) if (t.status === "active" && !m.has(t.unitId)) m.set(t.unitId, t);
  return m;
}

export async function ownerProfile(ownerId: string) {
  const [p] = await db.select().from(profiles).where(eq(profiles.id, ownerId));
  return p;
}
