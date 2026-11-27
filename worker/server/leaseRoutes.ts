import type { Context, Hono } from "hono";
import { and, eq } from "drizzle-orm";
import { db, settlementDeductions, settlements, tenancies } from "../db/index.ts";
import { actorOf, roles, type Env } from "./core/auth.ts";
import type { Actor } from "./core/access.ts";
import { body } from "./core/http.ts";
import {
  addDays,
  addMonths,
  cleanDate,
  cleanInt,
  cleanStr,
  defaultLeaseEnd,
  dueDateFor,
  monthOf,
  oneOf,
  todayIST,
} from "./core/util.ts";
import { ensureCharges, loadWorkspace, logActivity, ownerProfile, type Workspace } from "./domain/data.ts";
import {
  applyRenewal,
  leaseHistory,
  leaseState,
  renewError,
  renewalDefaults,
  repriceMoveOutMonth,
  tenantItems,
  type RenewInput,
} from "./domain/leases.ts";
import {
  DEDUCTION_KINDS,
  figuresFor,
  finalize,
  markRefunded,
  openSettlement,
  recompute,
  settlementOf,
  type Deduction,
  type Settlement,
} from "./domain/settlement.ts";
import { announce } from "./domain/notifications.ts";
import type { SettlementModel } from "../../shared/pdf/models.ts";

type Tenancy = Workspace["tenancyRows"][number];

/** A tenancy the actor may see: any in the workspace for the owner, only their own for a tenant. */
function visibleTenancy(ws: Workspace, a: Actor, id: number): Tenancy | null {
  const tn = ws.tenancyRows.find((t) => t.id === id);
  if (!tn) return null;
  if (a.role === "tenant" && !a.tenantIds.includes(tn.tenantId)) return null;
  return tn;
}

function describe(ws: Workspace, tn: Tenancy) {
  const u = ws.unitRows.find((x) => x.id === tn.unitId);
  const p = u ? ws.props.find((x) => x.id === u.propertyId) : undefined;
  const t = ws.tenantRows.find((x) => x.id === tn.tenantId);
  return { u, p, t };
}

function settlementJson(s: Settlement, deductions: Deduction[]) {
  const total = deductions.reduce((n, d) => n + d.amount, 0);
  return {
    id: s.id,
    status: s.status,
    number: s.number,
    moveOutDate: s.moveOutDate,
    depositHeld: s.depositHeld,
    outstandingRent: s.outstandingRent,
    pendingUtilities: s.pendingUtilities,
    advanceUnused: s.advanceUnused,
    deductionTotal: total,
    refundAmount: s.refundAmount,
    refundStatus: s.refundStatus,
    refundMethod: s.refundMethod,
    refundRef: s.refundRef,
    refundPaidOn: s.refundPaidOn,
    note: s.note,
    finalizedAt: s.finalizedAt,
    deductions: deductions.map((d) => ({ id: d.id, kind: d.kind, description: d.description, amount: d.amount })),
  };
}

async function leaseJson(ownerId: string, ws: Workspace, tn: Tenancy, isOwner: boolean) {
  const terms = await leaseHistory(ownerId, tn);
  const { u, p, t } = describe(ws, tn);
  const st = await settlementOf(tn.id);
  // Tenants only see a settlement once it's final (a draft is the owner's working copy).
  const showSettlement = st && (isOwner || st.s.status === "final");
  return {
    tenancy: {
      id: tn.id,
      tenantId: tn.tenantId,
      tenantName: t?.fullName ?? "",
      unitLabel: u?.label ?? "",
      propertyName: p?.name ?? "",
      rent: tn.rent,
      dueDay: tn.dueDay,
      deposit: tn.deposit,
      startDate: tn.startDate,
      endDate: tn.endDate,
      moveOutDate: tn.moveOutDate,
      status: tn.status,
      state: leaseState(tn),
    },
    terms: terms.map((x) => ({
      id: x.id,
      startDate: x.startDate,
      endDate: x.endDate,
      rent: x.rent,
      dueDay: x.dueDay,
      deposit: x.deposit,
      reason: x.reason,
      note: x.note,
      createdAt: x.createdAt,
    })),
    renewal: isOwner && tn.status === "active" ? renewalDefaults(tn) : null,
    settlement: showSettlement ? settlementJson(st.s, st.deductions) : null,
  };
}

async function tenancyFor(c: Context<Env>, id: number) {
  const a = actorOf(c);
  const ws = await loadWorkspace(a.ownerId);
  await ensureCharges(a.ownerId, ws);
  return { a, ws, tn: visibleTenancy(ws, a, id) };
}

/** Lease renewals, holdovers, move-out and deposit settlements. */
export function registerLeaseRoutes(api: Hono<Env>) {
  api.get("/tenancies/:id/lease", roles("owner", "tenant"), async (c) => {
    const { a, ws, tn } = await tenancyFor(c, Number(c.req.param("id")));
    if (!tn) return c.json({ error: "Tenancy not found." }, 404);
    return c.json(await leaseJson(a.ownerId, ws, tn, a.role === "owner"));
  });

  /** The tenant's own lease: the active tenancy, or the latest one after moving out. */
  api.get("/tenant/lease", roles("tenant"), async (c) => {
    const a = actorOf(c);
    const ws = await loadWorkspace(a.ownerId);
    await ensureCharges(a.ownerId, ws);
    const mine = ws.tenancyRows.filter((t) => a.tenantIds.includes(t.tenantId));
    const tn = mine.find((t) => t.status === "active") ?? mine[0];
    if (!tn) return c.json({ lease: null });
    return c.json({ lease: await leaseJson(a.ownerId, ws, tn, false) });
  });

  /** Renewal (new end date, usually new rent) or revision (new rent from a date, same lease). */
  api.post("/tenancies/:id/renew", roles("owner"), async (c) => {
    const { a, tn } = await tenancyFor(c, Number(c.req.param("id")));
    if (!tn) return c.json({ error: "Tenancy not found." }, 404);
    const b = await body(c);
    const kind = oneOf(b.kind, ["renewal", "revision"] as const) ?? "renewal";
    const defaults = renewalDefaults(tn);
    const effectiveFrom = b.effectiveFrom
      ? cleanDate(b.effectiveFrom)
      : kind === "renewal"
        ? defaults.effectiveFrom
        : todayIST();
    if (!effectiveFrom) return c.json({ error: "Enter the date the new terms start." }, 400);
    const months = cleanInt(b.months, 1, 60);
    let endDate: string | null = tn.endDate;
    if (b.endDate !== undefined && b.endDate !== null && b.endDate !== "") {
      endDate = cleanDate(b.endDate);
      if (!endDate) return c.json({ error: "Enter a valid end date." }, 400);
    } else if (months) {
      // The day before the same date `months` later (a 31st is clamped in shorter months, like the 11-month default).
      endDate = addDays(dueDateFor(addMonths(monthOf(effectiveFrom), months), Number(effectiveFrom.slice(8, 10))), -1);
    } else if (kind === "renewal") endDate = defaultLeaseEnd(effectiveFrom); // 11 months from the chosen start
    const rent = b.rent === undefined || b.rent === "" ? tn.rent : cleanInt(b.rent, 1);
    if (!rent) return c.json({ error: "Enter the monthly rent." }, 400);
    const dueDay = b.dueDay === undefined || b.dueDay === "" ? tn.dueDay : cleanInt(b.dueDay, 1, 28);
    if (!dueDay) return c.json({ error: "The due day must be between 1 and 28." }, 400);
    const deposit = b.deposit === undefined || b.deposit === "" ? tn.deposit : cleanInt(b.deposit, 0);
    if (deposit === null) return c.json({ error: "Enter a valid deposit." }, 400);
    const input: RenewInput = {
      kind,
      endDate,
      rent,
      effectiveFrom,
      dueDay,
      deposit,
      note: cleanStr(b.note, 200),
      actorId: a.id,
    };
    const err = renewError(tn, input);
    if (err) return c.json({ error: err }, 400);
    await leaseHistory(a.ownerId, tn); // make sure the initial term exists before the new one
    const r = await applyRenewal(a.ownerId, tn, input);
    await logActivity(a.id, kind === "renewal" ? "renew" : "revise", "tenancy", tn.id);
    const change = rent !== tn.rent ? ` New rent ₹${rent.toLocaleString("en-IN")} from ${effectiveFrom}.` : "";
    await announce(
      c,
      await tenantItems(tn.tenantId, {
        ownerId: a.ownerId,
        kind: "lease_renewed",
        title: kind === "renewal" ? "Your lease was renewed" : "Your rent was revised",
        body: `${kind === "renewal" && endDate ? `Now runs until ${endDate}.` : ""}${change}`.trim(),
        url: "/lease",
        entity: "lease_term",
        entityId: r.term.id,
        dedupe: `lease_renewed:${r.term.id}`,
      }),
    );
    return c.json({ ok: true, termId: r.term.id, repriced: r.repriced, endDate, rent });
  });

  /** Cancels a scheduled move-out: billing carries on as before (and the move-out month is repriced in full). */
  api.post("/tenancies/:id/move-out/cancel", roles("owner"), async (c) => {
    const { a, tn } = await tenancyFor(c, Number(c.req.param("id")));
    if (!tn) return c.json({ error: "Tenancy not found." }, 404);
    if (tn.status !== "active" || !tn.moveOutDate) return c.json({ error: "No move-out is scheduled." }, 409);
    const [s] = await db.select().from(settlements).where(eq(settlements.tenancyId, tn.id));
    if (s?.status === "final") return c.json({ error: "The settlement is already final." }, 409);
    const done = await db
      .update(tenancies)
      .set({ moveOutDate: null })
      .where(and(eq(tenancies.id, tn.id), eq(tenancies.status, "active")))
      .returning();
    if (!done.length) return c.json({ error: "This tenancy has already ended." }, 409);
    if (s) await db.delete(settlements).where(and(eq(settlements.id, s.id), eq(settlements.status, "draft")));
    await repriceMoveOutMonth(a.ownerId, done[0], tn.moveOutDate);
    await ensureCharges(a.ownerId, undefined, true);
    await logActivity(a.id, "cancel_move_out", "tenancy", tn.id);
    return c.json({ ok: true });
  });

  /* ---------- settlement ---------- */

  /** The settlement, or a preview of the numbers when none has been started. */
  api.get("/tenancies/:id/settlement", roles("owner"), async (c) => {
    const { ws, tn } = await tenancyFor(c, Number(c.req.param("id")));
    if (!tn) return c.json({ error: "Tenancy not found." }, 404);
    const { u, p, t } = describe(ws, tn);
    let st = await settlementOf(tn.id);
    if (st && st.s.status === "draft") {
      const s = await recompute(ws, tn, st.s);
      st = { s, deductions: st.deductions };
    }
    const moveOutDate =
      st?.s.moveOutDate ?? tn.moveOutDate ?? (tn.status === "ended" ? tn.endDate : null) ?? todayIST();
    const preview = st ? null : await figuresFor(ws, tn, moveOutDate);
    return c.json({
      tenancy: {
        id: tn.id,
        tenantId: tn.tenantId,
        tenantName: t?.fullName ?? "",
        unitLabel: u?.label ?? "",
        propertyName: p?.name ?? "",
        deposit: tn.deposit,
        startDate: tn.startDate,
        endDate: tn.endDate,
        moveOutDate: tn.moveOutDate,
        status: tn.status,
      },
      suggestedMoveOut: moveOutDate,
      settlement: st ? settlementJson(st.s, st.deductions) : null,
      preview: preview
        ? {
            depositHeld: preview.depositHeld,
            outstandingRent: preview.outstandingRent,
            pendingUtilities: preview.pendingUtilities,
            advanceUnused: preview.advanceUnused,
          }
        : null,
    });
  });

  /**
   * Starts the settlement. Also schedules the move-out on the tenancy when it isn't already (a past date ends it
   * the next time charges are generated). Idempotent.
   */
  api.post("/tenancies/:id/settlement", roles("owner"), async (c) => {
    const { a, ws, tn } = await tenancyFor(c, Number(c.req.param("id")));
    if (!tn) return c.json({ error: "Tenancy not found." }, 404);
    const b = await body(c);
    const moveOutDate = b.moveOutDate
      ? cleanDate(b.moveOutDate)
      : (tn.moveOutDate ?? (tn.status === "ended" ? tn.endDate : null) ?? todayIST());
    if (!moveOutDate) return c.json({ error: "Enter the move-out date." }, 400);
    if (moveOutDate < tn.startDate)
      return c.json({ error: "The move-out date can't be before the tenancy started." }, 400);
    if (tn.status === "active" && tn.moveOutDate !== moveOutDate) {
      const [updated] = await db
        .update(tenancies)
        .set({ moveOutDate })
        .where(and(eq(tenancies.id, tn.id), eq(tenancies.status, "active")))
        .returning();
      if (updated) {
        await repriceMoveOutMonth(a.ownerId, updated, tn.moveOutDate);
        Object.assign(tn, updated);
      }
    }
    const r = await openSettlement(a.ownerId, ws, tn, moveOutDate, cleanStr(b.note, 300));
    if (r.created) await logActivity(a.id, "create", "settlement", r.s.id);
    // A draft started earlier follows a changed move-out date (a final settlement never changes).
    const s =
      !r.created && r.s.status === "draft" && r.s.moveOutDate !== moveOutDate
        ? await recompute(ws, tn, r.s, moveOutDate)
        : r.s;
    return c.json({ ok: true, created: r.created, settlement: settlementJson(s, r.deductions) });
  });

  async function ownedSettlement(c: Context<Env>) {
    const a = actorOf(c);
    const [s] = await db
      .select()
      .from(settlements)
      .where(and(eq(settlements.id, Number(c.req.param("id"))), eq(settlements.ownerId, a.ownerId)));
    if (!s) return null;
    const ws = await loadWorkspace(a.ownerId);
    const tn = ws.tenancyRows.find((t) => t.id === s.tenancyId);
    return tn ? { a, s, ws, tn } : null;
  }

  api.post("/settlements/:id/deductions", roles("owner"), async (c) => {
    const found = await ownedSettlement(c);
    if (!found) return c.json({ error: "Settlement not found." }, 404);
    if (found.s.status !== "draft") return c.json({ error: "This settlement is final and can't change." }, 409);
    const b = await body(c);
    const kind = oneOf(b.kind, DEDUCTION_KINDS);
    if (!kind) return c.json({ error: "Choose what the deduction is for." }, 400);
    const amount = cleanInt(b.amount, 1, 10_000_000);
    if (!amount) return c.json({ error: "Enter the amount." }, 400);
    const description = cleanStr(b.description, 160);
    if (!description) return c.json({ error: "Describe the deduction." }, 400);
    await db.insert(settlementDeductions).values({ settlementId: found.s.id, kind, description, amount });
    const s = await recompute(found.ws, found.tn, found.s);
    const st = await settlementOf(found.tn.id);
    return c.json({ ok: true, settlement: settlementJson(s, st?.deductions ?? []) });
  });

  api.delete("/settlements/:id/deductions/:did", roles("owner"), async (c) => {
    const found = await ownedSettlement(c);
    if (!found) return c.json({ error: "Settlement not found." }, 404);
    if (found.s.status !== "draft") return c.json({ error: "This settlement is final and can't change." }, 409);
    await db
      .delete(settlementDeductions)
      .where(
        and(eq(settlementDeductions.id, Number(c.req.param("did"))), eq(settlementDeductions.settlementId, found.s.id)),
      );
    const s = await recompute(found.ws, found.tn, found.s);
    const st = await settlementOf(found.tn.id);
    return c.json({ ok: true, settlement: settlementJson(s, st?.deductions ?? []) });
  });

  api.patch("/settlements/:id", roles("owner"), async (c) => {
    const found = await ownedSettlement(c);
    if (!found) return c.json({ error: "Settlement not found." }, 404);
    if (found.s.status !== "draft") return c.json({ error: "This settlement is final and can't change." }, 409);
    const b = await body(c);
    if (typeof b.note === "string")
      await db
        .update(settlements)
        .set({ note: cleanStr(b.note, 300) })
        .where(eq(settlements.id, found.s.id));
    const [s] = await db.select().from(settlements).where(eq(settlements.id, found.s.id));
    const next = await recompute(found.ws, found.tn, s);
    const st = await settlementOf(found.tn.id);
    return c.json({ ok: true, settlement: settlementJson(next, st?.deductions ?? []) });
  });

  api.post("/settlements/:id/finalize", roles("owner"), async (c) => {
    const found = await ownedSettlement(c);
    if (!found) return c.json({ error: "Settlement not found." }, 404);
    if (found.s.status !== "draft") return c.json({ error: "This settlement is already final." }, 409);
    await ensureCharges(found.a.ownerId, found.ws, true);
    const r = await finalize(found.ws, found.tn, found.s, found.a.id);
    if (!r) return c.json({ error: "This settlement is already final." }, 409);
    await logActivity(found.a.id, "finalize", "settlement", found.s.id);
    const s = r.settlement;
    const owes = s.refundAmount < 0;
    await announce(
      c,
      await tenantItems(found.tn.tenantId, {
        ownerId: found.a.ownerId,
        kind: "settlement",
        title: "Your deposit settlement is ready",
        body: owes
          ? `₹${(-s.refundAmount).toLocaleString("en-IN")} is still owed after the deposit.`
          : `Refund: ₹${s.refundAmount.toLocaleString("en-IN")}.`,
        url: "/lease",
        entity: "settlement",
        entityId: s.id,
        dedupe: `settlement:${s.id}`,
      }),
    );
    const st = await settlementOf(found.tn.id);
    return c.json({ ok: true, appliedMonths: r.appliedMonths, settlement: settlementJson(s, st?.deductions ?? []) });
  });

  api.post("/settlements/:id/refund", roles("owner"), async (c) => {
    const found = await ownedSettlement(c);
    if (!found) return c.json({ error: "Settlement not found." }, 404);
    if (found.s.status !== "final") return c.json({ error: "Finalise the settlement first." }, 409);
    if (found.s.refundAmount <= 0) return c.json({ error: "There's nothing to refund." }, 409);
    const b = await body(c);
    const method = oneOf(b.method, ["upi", "cash", "bank"] as const);
    if (!method) return c.json({ error: "Choose how the refund was paid." }, 400);
    const paidOn = b.paidOn ? cleanDate(b.paidOn) : todayIST();
    if (!paidOn) return c.json({ error: "Enter a valid date." }, 400);
    const done = await markRefunded(found.s, { method, ref: cleanStr(b.ref, 60), paidOn });
    if (!done) return c.json({ error: "The refund is already recorded." }, 409);
    await logActivity(found.a.id, "refund", "settlement", found.s.id);
    return c.json({ ok: true });
  });

  /** The settlement statement's data; the browser draws the PDF. Owner (draft or final) and tenant (final). */
  api.get("/tenancies/:id/settlement.json", roles("owner", "tenant"), async (c) => {
    const a = actorOf(c);
    const ws = await loadWorkspace(a.ownerId);
    const tn = visibleTenancy(ws, a, Number(c.req.param("id")));
    if (!tn) return c.json({ error: "Settlement not found." }, 404);
    const st = await settlementOf(tn.id);
    if (!st || (a.role === "tenant" && st.s.status !== "final")) return c.json({ error: "Settlement not found." }, 404);
    const { u, p, t } = describe(ws, tn);
    const owner = await ownerProfile(a.ownerId);
    const total = st.deductions.reduce((n, d) => n + d.amount, 0);
    const model: SettlementModel = {
      kind: "settlement",
      filename: `${st.s.number || "Settlement-draft"}-${(u?.label ?? "unit").replace(/\W+/g, "-")}.pdf`,
      number: st.s.number,
      final: st.s.status === "final",
      issuedOn: (st.s.finalizedAt ?? new Date()).toISOString().slice(0, 10),
      tenantName: t?.fullName ?? "",
      tenantPhone: t?.phone ?? "",
      unitLabel: u?.label ?? "",
      propertyName: p?.name ?? "",
      address: p?.address ?? "",
      startDate: tn.startDate,
      moveOutDate: st.s.moveOutDate,
      depositHeld: st.s.depositHeld,
      outstandingRent: st.s.outstandingRent,
      pendingUtilities: st.s.pendingUtilities,
      advanceUnused: st.s.advanceUnused,
      deductions: st.deductions.map((d) => ({ kind: d.kind, description: d.description, amount: d.amount })),
      deductionTotal: total,
      refundAmount: st.s.refundAmount,
      refundStatus: st.s.refundStatus,
      refundMethod: st.s.refundMethod,
      refundRef: st.s.refundRef,
      refundPaidOn: st.s.refundPaidOn,
      note: st.s.note,
      ownerName: owner?.fullName ?? "",
      ownerPhone: owner?.phone ?? "",
      ownerPan: owner?.pan ?? "",
    };
    return c.json(model, 200, { "cache-control": "private, no-store" });
  });
}
