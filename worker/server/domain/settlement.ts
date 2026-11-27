import { and, eq, sql } from "drizzle-orm";
import { db, settlementDeductions, settlements, tenancies } from "../../db/index.ts";
import { monthOf, todayIST } from "../core/util.ts";
import { insertPaymentIfDue, loadLedger, syncChargeStatuses, type Workspace } from "./data.ts";

/*
 * Move-out and deposit settlement. One `settlements` row per tenancy. While it is a draft the numbers are
 * recomputed from the ledger on every change; finalising freezes them (and the deductions), applies the rent and
 * utility deductions to the unpaid months from the deposit, and numbers the statement (S-0001).
 *
 *   refund = deposit held − deductions + unused advance
 *
 * A negative refund means the tenant still owes that much.
 */

type Tenancy = typeof tenancies.$inferSelect;
export type Settlement = typeof settlements.$inferSelect;
export type Deduction = typeof settlementDeductions.$inferSelect;
export const DEDUCTION_KINDS = ["damage", "rent", "utility", "other"] as const;
type DeductionKind = (typeof DEDUCTION_KINDS)[number];

interface SettlementFigures {
  depositHeld: number;
  /** Unpaid rent (and late fees) up to the move-out month. */
  outstandingRent: number;
  /** Unpaid utility bills up to the move-out month. */
  pendingUtilities: number;
  /** Money already paid for months after the move-out month. */
  advanceUnused: number;
  /** The unpaid months, oldest first (what rent and utility deductions are applied to on finalising). */
  unpaid: { chargeId: number; month: string; balance: number; utilities: number }[];
}

/** Pure: the numbers for a tenancy's settlement from its ledger rows. */
function figuresFrom(
  deposit: number,
  moveOutDate: string,
  rows: { id: number; month: string; balance: number; extra: number; paid: number }[],
): SettlementFigures {
  const last = monthOf(moveOutDate);
  let outstandingRent = 0;
  let pendingUtilities = 0;
  let advanceUnused = 0;
  const unpaid: SettlementFigures["unpaid"] = [];
  for (const r of [...rows].sort((a, b) => a.month.localeCompare(b.month))) {
    if (r.month > last) {
      advanceUnused += r.paid;
      continue;
    }
    if (r.balance <= 0) continue;
    // Payments go to rent first in people's minds, so what's left unpaid is the utilities first.
    const utilities = Math.min(r.balance, r.extra);
    pendingUtilities += utilities;
    outstandingRent += r.balance - utilities;
    unpaid.push({ chargeId: r.id, month: r.month, balance: r.balance, utilities });
  }
  return { depositHeld: Math.max(0, deposit), outstandingRent, pendingUtilities, advanceUnused, unpaid };
}

/** Pure: the refund (negative when the tenant owes). */
const refundOf = (f: Pick<SettlementFigures, "depositHeld" | "advanceUnused">, deductions: number) =>
  f.depositHeld - deductions + f.advanceUnused;

export async function figuresFor(ws: Workspace, tn: Tenancy, moveOutDate: string) {
  const rows = await loadLedger(ws, { tenancyIds: [tn.id] });
  return figuresFrom(tn.deposit, moveOutDate, rows);
}

export async function settlementOf(tenancyId: number) {
  const [s] = await db.select().from(settlements).where(eq(settlements.tenancyId, tenancyId));
  if (!s) return null;
  const deductions = await db
    .select()
    .from(settlementDeductions)
    .where(eq(settlementDeductions.settlementId, s.id))
    .orderBy(settlementDeductions.id);
  return { s, deductions };
}

/**
 * Opens (or returns) the draft for a tenancy. The suggested deductions are the unpaid rent and utilities, which the
 * owner can remove or change. Idempotent: the unique tenancy index means a second call returns the first draft.
 */
export async function openSettlement(ownerId: string, ws: Workspace, tn: Tenancy, moveOutDate: string, note: string) {
  const existing = await settlementOf(tn.id);
  if (existing) return { ...existing, created: false };
  const f = await figuresFor(ws, tn, moveOutDate);
  const suggested: { kind: DeductionKind; description: string; amount: number }[] = [];
  if (f.outstandingRent > 0) suggested.push({ kind: "rent", description: "Unpaid rent", amount: f.outstandingRent });
  if (f.pendingUtilities > 0)
    suggested.push({ kind: "utility", description: "Unpaid utility bills", amount: f.pendingUtilities });
  const deductionTotal = suggested.reduce((s, d) => s + d.amount, 0);
  const [s] = await db
    .insert(settlements)
    .values({
      ownerId,
      tenancyId: tn.id,
      moveOutDate,
      depositHeld: f.depositHeld,
      outstandingRent: f.outstandingRent,
      pendingUtilities: f.pendingUtilities,
      advanceUnused: f.advanceUnused,
      refundAmount: refundOf(f, deductionTotal),
      note,
    })
    .onConflictDoNothing()
    .returning();
  if (!s) {
    const again = await settlementOf(tn.id);
    return { ...again!, created: false };
  }
  if (suggested.length)
    await db.insert(settlementDeductions).values(suggested.map((d) => ({ ...d, settlementId: s.id })));
  return { ...(await settlementOf(tn.id))!, created: true };
}

/** Recomputes a draft's numbers from the ledger and its deductions (no-op once final). */
export async function recompute(ws: Workspace, tn: Tenancy, s: Settlement, moveOutDate = s.moveOutDate) {
  if (s.status !== "draft") return s;
  const f = await figuresFor(ws, tn, moveOutDate);
  const [{ total }] = await db
    .select({ total: sql<number>`coalesce(sum(${settlementDeductions.amount}), 0)` })
    .from(settlementDeductions)
    .where(eq(settlementDeductions.settlementId, s.id));
  const [next] = await db
    .update(settlements)
    .set({
      moveOutDate,
      depositHeld: f.depositHeld,
      outstandingRent: f.outstandingRent,
      pendingUtilities: f.pendingUtilities,
      advanceUnused: f.advanceUnused,
      refundAmount: refundOf(f, Number(total)),
    })
    .where(and(eq(settlements.id, s.id), eq(settlements.status, "draft")))
    .returning();
  return next ?? s;
}

const settlementNumber = (id: number) => `S-${String(id).padStart(4, "0")}`;

/**
 * Finalises a draft: recomputes, freezes it (only one call can win: the update is guarded by status = 'draft'),
 * then applies the rent and utility deductions to the unpaid months, oldest first, as confirmed payments noted as
 * "Adjusted from the security deposit". Each insert re-checks the balance itself, so nothing can be overpaid.
 */
export async function finalize(ws: Workspace, tn: Tenancy, s: Settlement, actorId: string) {
  const fresh = await recompute(ws, tn, s);
  const number = settlementNumber(s.id);
  const [done] = await db
    .update(settlements)
    .set({ status: "final", finalizedAt: new Date(), finalizedBy: actorId, number })
    .where(and(eq(settlements.id, s.id), eq(settlements.status, "draft")))
    .returning();
  if (!done) return null;
  const deductions = await db.select().from(settlementDeductions).where(eq(settlementDeductions.settlementId, s.id));
  let cover = deductions.filter((d) => d.kind === "rent" || d.kind === "utility").reduce((t, d) => t + d.amount, 0);
  cover = Math.min(cover, fresh.depositHeld + fresh.advanceUnused);
  const f = await figuresFor(ws, tn, fresh.moveOutDate);
  const months: string[] = [];
  const today = todayIST();
  for (const u of f.unpaid) {
    if (cover <= 0) break;
    const amount = Math.min(cover, u.balance);
    const id = await insertPaymentIfDue({
      chargeId: u.chargeId,
      amount,
      method: "cash",
      utr: number,
      status: "confirmed",
      recordedBy: actorId,
      paidOn: today,
      note: `Adjusted from the security deposit (settlement ${number})`,
    });
    if (id !== null) {
      cover -= amount;
      months.push(u.month);
    }
  }
  await syncChargeStatuses(tn.id, months);
  return { settlement: done, appliedMonths: months.length };
}

/** Records that the refund was paid (final settlements with money to give back only). Once. */
export async function markRefunded(s: Settlement, v: { method: string; ref: string; paidOn: string }) {
  const [done] = await db
    .update(settlements)
    .set({ refundStatus: "paid", refundMethod: v.method, refundRef: v.ref, refundPaidOn: v.paidOn })
    .where(and(eq(settlements.id, s.id), eq(settlements.status, "final"), eq(settlements.refundStatus, "pending")))
    .returning();
  return done ?? null;
}
