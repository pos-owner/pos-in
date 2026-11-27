/**
 * Multi-month and advance rent payments.
 *
 * One transfer from a tenant often covers several months: arrears plus this month, or rent paid ahead. It is stored
 * as one `payment_batches` row (what arrived, how, when) plus one ordinary `payments` row per month it covers, so the
 * month-wise ledger, statuses and reports keep working unchanged.
 *
 * Safety on D1 (no interactive transactions):
 *  - Every write for one batch goes in a single `db.batch`, which D1 runs as one transaction.
 *  - The `payments_*` triggers (migration payment_guards) refuse a month that would be overpaid, a second pending
 *    claim, or a month from another tenancy. Any refusal aborts the whole batch, so a payment never lands half-way.
 *  - `client_key` is unique per workspace: a retried submission returns the original batch instead of a second one.
 */
import { and, eq, inArray, sql } from "drizzle-orm";
import { charges, db, paymentBatches, payments } from "../../db/index.ts";
import type { Actor } from "../core/access.ts";
import { monthOf, randomToken, todayIST } from "../core/util.ts";
import { allocate, upcomingMonths, type AllocationRequest, type OpenMonth, type PlanLine } from "./allocation.ts";
import { flow } from "./automations.ts";
import { loadLedger, syncChargeStatuses, type Workspace } from "./data.ts";

type Tenancy = Workspace["tenancyRows"][number];
type Batch = typeof paymentBatches.$inferSelect;

/** How far ahead rent may be paid, from the owner's "Advance rent" setting. 0 when tenants can't pay ahead. */
async function advanceLimit(ownerId: string, role: Actor["role"]) {
  const f = await flow(ownerId, "advance_rent");
  const months = Number(f.config.maxMonthsAhead ?? 12);
  // Switching the setting off stops tenants paying ahead; the owner can still record money already received.
  if (!f.enabled && role === "tenant") return 0;
  return Math.max(0, Math.min(24, months));
}

/**
 * Months on a tenancy that can still take money, oldest first. Tenants skip months where they already have a claim
 * waiting for the owner (they can't report the same month twice).
 */
async function openMonths(ws: Workspace, tn: Tenancy, role: Actor["role"], maxAhead: number) {
  const current = monthOf(todayIST());
  const ledger = await loadLedger(ws, { tenancyIds: [tn.id] });
  const open: OpenMonth[] = ledger
    .filter((r) => r.balance > 0 && (role !== "tenant" || r.pending === 0))
    // Already-billed future months (paid ahead in part) count toward the same advance limit.
    .filter((r) => r.month <= current || maxAhead > 0)
    .map((r) => ({
      chargeId: r.id,
      month: r.month,
      dueDate: r.dueDate,
      amount: r.amount,
      extra: r.extra,
      paid: r.paid,
      balance: r.balance,
    }));
  const upcoming = upcomingMonths(
    tn,
    ledger.map((r) => r.month),
    current,
    maxAhead,
  );
  return { open: [...open, ...upcoming], current, awaiting: ledger.filter((r) => r.pending > 0).length };
}

export async function planPayment(ws: Workspace, tn: Tenancy, a: Actor, req: AllocationRequest) {
  const maxAhead = await advanceLimit(a.ownerId, a.role);
  const { open, current, awaiting } = await openMonths(ws, tn, a.role, maxAhead);
  return { result: allocate(open, req, current), open, current, maxAhead, awaiting };
}

/** Friendly words for a refused plan. */
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** "2027-03" → "Mar 2027" for messages people read. */
const monthWords = (m: string | null) =>
  m ? `${MONTHS[Number(m.slice(5, 7)) - 1] ?? ""} ${m.slice(0, 4)}`.trim() : null;

export function planError(r: Extract<ReturnType<typeof allocate>, { ok: false }>) {
  const max = `₹${r.max.toLocaleString("en-IN")}`;
  const maxMonth = monthWords(r.maxMonth);
  switch (r.code) {
    case "nothing_due":
      return "Nothing is due on this tenancy right now.";
    case "over_max":
      return `That's more than can be paid now. The most is ${max}${maxMonth ? `, which covers rent up to ${maxMonth}` : ""}.`;
    case "beyond_limit":
      return `Rent can be paid up to ${maxMonth ?? "the current month"} for now.`;
    default:
      return "Enter a valid amount.";
  }
}

interface CommitInput {
  ownerId: string;
  tenancyId: number;
  lines: PlanLine[];
  method: "upi" | "cash" | "bank";
  utr: string;
  note: string;
  paidOn: string;
  status: "pending" | "confirmed";
  recordedBy: string;
  clientKey: string;
}

type CommitResult =
  | { ok: true; batch: Batch; paymentIds: number[]; duplicate: boolean }
  | { ok: false; reason: "changed" | "pending" | "key_reused" };

const batchByKey = async (ownerId: string, clientKey: string) =>
  (
    await db
      .select()
      .from(paymentBatches)
      .where(and(eq(paymentBatches.ownerId, ownerId), eq(paymentBatches.clientKey, clientKey)))
  )[0];

const batchPaymentIds = async (batchId: number) =>
  (await db.select({ id: payments.id }).from(payments).where(eq(payments.batchId, batchId)).orderBy(payments.id)).map(
    (r) => r.id,
  );

/** A replay of `clientKey`: the original batch when it is the same tenancy, otherwise a misuse of the key. */
export async function replay(ownerId: string, tenancyId: number, clientKey: string): Promise<CommitResult | null> {
  const b = await batchByKey(ownerId, clientKey);
  if (!b) return null;
  if (b.tenancyId !== tenancyId) return { ok: false, reason: "key_reused" };
  return { ok: true, batch: b, paymentIds: await batchPaymentIds(b.id), duplicate: true };
}

const messageOf = (e: unknown): string => {
  const parts: string[] = [];
  for (let x: unknown = e; x && parts.length < 5; x = (x as { cause?: unknown }).cause)
    parts.push(String((x as Error).message ?? x));
  return parts.join(" | ");
};

/** Writes the batch and its months in one transaction. Upcoming months get their charge in the same transaction. */
export async function commitPayment(v: CommitInput): Promise<CommitResult> {
  const total = v.lines.reduce((s, l) => s + l.applied, 0);
  const newMonths = v.lines.filter((l) => l.chargeId === null);
  const batchId = sql`(select id from ${paymentBatches} where owner_id = ${v.ownerId} and client_key = ${v.clientKey})`;
  const now = Date.now();
  const stmts = [
    ...(newMonths.length
      ? [
          db
            .insert(charges)
            .values(
              newMonths.map((l) => ({
                tenancyId: v.tenancyId,
                month: l.month,
                amount: l.amount,
                dueDate: l.dueDate,
                status: "upcoming",
              })),
            )
            .onConflictDoNothing(),
        ]
      : []),
    db.insert(paymentBatches).values({
      ownerId: v.ownerId,
      tenancyId: v.tenancyId,
      clientKey: v.clientKey,
      amount: total,
      months: v.lines.length,
      method: v.method,
      utr: v.utr,
      status: v.status,
      recordedBy: v.recordedBy,
      paidOn: v.paidOn,
      note: v.note,
    }),
    // Built with the query builder, not `db.run(sql…)`: drizzle's D1 batch can't bind parameters of raw statements.
    ...v.lines.map((l) =>
      db.insert(payments).values({
        chargeId: sql`(select id from ${charges} where tenancy_id = ${v.tenancyId} and month = ${l.month})`,
        amount: l.applied,
        method: v.method,
        utr: v.utr,
        status: v.status,
        recordedBy: v.recordedBy,
        paidOn: v.paidOn,
        note: v.note,
        createdAt: new Date(now),
        batchId,
      }),
    ),
  ];
  try {
    await db.batch(stmts as unknown as Parameters<typeof db.batch>[0]);
  } catch (e) {
    const m = messageOf(e);
    if (/payment_batches\.owner_id, payment_batches\.client_key|payment_batches_owner_key_uq/.test(m)) {
      // The same submission landed a moment ago (double tap, retry after a dropped connection).
      return (await replay(v.ownerId, v.tenancyId, v.clientKey)) ?? { ok: false, reason: "changed" };
    }
    if (m.includes("pos:payment_pending_exists")) return { ok: false, reason: "pending" };
    if (m.includes("pos:payment_exceeds_due") || m.includes("pos:payment_wrong_tenancy"))
      return { ok: false, reason: "changed" };
    throw e;
  }
  const batch = await batchByKey(v.ownerId, v.clientKey);
  await syncChargeStatuses(
    v.tenancyId,
    v.lines.map((l) => l.month),
  );
  return { ok: true, batch, paymentIds: await batchPaymentIds(batch.id), duplicate: false };
}

/** A batch in the actor's workspace (null when it isn't theirs). */
export async function ownedBatch(ownerId: string, batchId: number) {
  const [b] = await db
    .select()
    .from(paymentBatches)
    .where(and(eq(paymentBatches.id, batchId), eq(paymentBatches.ownerId, ownerId)));
  return b ?? null;
}

async function batchChargeIds(batchId: number) {
  const rows = await db.select({ chargeId: payments.chargeId }).from(payments).where(eq(payments.batchId, batchId));
  return rows.map((r) => r.chargeId);
}

/**
 * Confirms or rejects a pending batch, all months at once. Returns "done", "handled" (not pending any more) or
 * "no_fit" (confirming would overpay a month: something else was recorded since the tenant reported it).
 */
export async function settleBatch(b: Batch, action: "confirm" | "reject"): Promise<"done" | "handled" | "no_fit"> {
  const status = action === "confirm" ? "confirmed" : "rejected";
  let changed: { id: number }[][];
  try {
    changed = (await db.batch([
      db
        .update(paymentBatches)
        .set({ status })
        .where(and(eq(paymentBatches.id, b.id), eq(paymentBatches.status, "pending")))
        .returning({ id: paymentBatches.id }),
      db
        .update(payments)
        .set({ status })
        .where(and(eq(payments.batchId, b.id), eq(payments.status, "pending")))
        .returning({ id: payments.id }),
    ])) as { id: number }[][];
  } catch (e) {
    if (messageOf(e).includes("pos:payment_exceeds_due")) return "no_fit";
    throw e;
  }
  if (!changed[0].length) return "handled";
  await syncChargeStatusesById(await batchChargeIds(b.id));
  return "done";
}

/** Voids a confirmed batch: every month stops counting, the rows and the receipt stay on record. */
export async function voidBatch(b: Batch, reason: string, actorId: string): Promise<boolean> {
  const set = { status: "void", voidReason: reason, voidedBy: actorId, voidedAt: new Date() };
  const [done] = (await db.batch([
    db
      .update(paymentBatches)
      .set(set)
      .where(and(eq(paymentBatches.id, b.id), eq(paymentBatches.status, "confirmed")))
      .returning({ id: paymentBatches.id }),
    db
      .update(payments)
      .set(set)
      .where(and(eq(payments.batchId, b.id), eq(payments.status, "confirmed"))),
  ])) as unknown as [{ id: number }[]];
  if (!done.length) return false;
  await syncChargeStatusesById(await batchChargeIds(b.id));
  return true;
}

/** Removes a batch the owner marked "not received". Confirmed or void batches are never deleted. */
export async function deleteRejectedBatch(b: Batch): Promise<boolean> {
  if (b.status !== "rejected") return false;
  const ids = await batchChargeIds(b.id);
  await db.batch([
    db.delete(payments).where(and(eq(payments.batchId, b.id), eq(payments.status, "rejected"))),
    db
      .delete(paymentBatches)
      .where(
        and(
          eq(paymentBatches.id, b.id),
          eq(paymentBatches.status, "rejected"),
          sql`not exists (select 1 from ${payments} where batch_id = ${b.id})`,
        ),
      ),
  ]);
  await syncChargeStatusesById(ids);
  return true;
}

async function syncChargeStatusesById(chargeIds: number[]) {
  if (!chargeIds.length) return;
  const rows = await db
    .select({ tenancyId: charges.tenancyId, month: charges.month })
    .from(charges)
    .where(inArray(charges.id, chargeIds));
  const byTenancy = new Map<number, string[]>();
  for (const r of rows) byTenancy.set(r.tenancyId, [...(byTenancy.get(r.tenancyId) ?? []), r.month]);
  for (const [t, months] of byTenancy) await syncChargeStatuses(t, months);
}

/** A fresh idempotency key when the client didn't send one (the request then simply isn't retry-safe). */
export const cleanClientKey = (v: unknown) =>
  typeof v === "string" && /^[\w-]{8,64}$/.test(v) ? v : `srv-${randomToken(12)}`;
