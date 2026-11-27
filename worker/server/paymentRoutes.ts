import type { Hono } from "hono";
import { actorOf, roles, type Env } from "./core/auth.ts";
import type { Actor } from "./core/access.ts";
import { body } from "./core/http.ts";
import { cleanDate, cleanInt, cleanStr, oneOf, todayIST } from "./core/util.ts";
import { ensureCharges, loadWorkspace, logActivity, ownerProfile, type Workspace } from "./domain/data.ts";
import { afterPaymentConfirmed } from "./domain/automations.ts";
import { announce, paymentNotice } from "./domain/notifications.ts";
import type { AllocationRequest } from "./domain/allocation.ts";
import { cleanClientKey, commitPayment, planError, planPayment, replay } from "./domain/payments.ts";

/*
 * Multi-month and advance rent (see domain/payments.ts).
 *
 *   GET  /api/tenancies/:id/pay-plan            months that can take money, and how far ahead rent can be paid
 *   GET  /api/tenancies/:id/pay-plan?amount=N   how N rupees would be spread (oldest month first)
 *   GET  /api/tenancies/:id/pay-plan?through=M  what clears every month up to M
 *   POST /api/tenancies/:id/payments            record it (owner: confirmed) or report it (tenant: pending)
 *
 * The browser only previews. The plan is worked out again on the server when the payment is saved, and the
 * database re-checks every month as it writes.
 */

/** The tenancy, when the actor may pay on it: any tenancy in the owner's workspace, or the tenant's own. */
function tenancyFor(ws: Workspace, a: Actor, id: number) {
  const tn = ws.tenancyRows.find((t) => t.id === id);
  if (!tn) return null;
  if (a.role === "tenant" && !a.tenantIds.includes(tn.tenantId)) return null;
  return tn;
}

/** `amount` or `throughMonth` from a query string or body. Returns null when neither (or a bad one) was given. */
function requestOf(amount: unknown, through: unknown): AllocationRequest | "bad" | null {
  if (typeof through === "string" && through) return /^\d{4}-\d{2}$/.test(through) ? { throughMonth: through } : "bad";
  if (amount !== undefined && amount !== null && amount !== "") {
    const n = cleanInt(amount, 1);
    return n === null ? "bad" : { amount: n };
  }
  return null;
}

export function registerPaymentRoutes(api: Hono<Env>) {
  api.get("/tenancies/:id/pay-plan", roles("owner", "tenant"), async (c) => {
    const a = actorOf(c);
    const ws = await loadWorkspace(a.ownerId);
    await ensureCharges(a.ownerId, ws);
    const tn = tenancyFor(ws, a, Number(c.req.param("id")));
    if (!tn) return c.json({ error: "Tenancy not found." }, 404);
    const req = requestOf(c.req.query("amount"), c.req.query("through"));
    if (req === "bad") return c.json({ error: "Enter a valid amount or month." }, 400);
    const plan = await planPayment(ws, tn, a, req ?? { amount: Number.MAX_SAFE_INTEGER });
    const months = plan.open
      .filter((o) => o.balance > 0)
      .sort((x, y) => x.month.localeCompare(y.month))
      .map((o) => ({ ...o, advance: o.month > plan.current }));
    const owner = a.role === "tenant" ? await ownerProfile(a.ownerId) : null;
    return c.json({
      tenancyId: tn.id,
      current: plan.current,
      maxMonthsAhead: plan.maxAhead,
      months,
      max: months.reduce((s, o) => s + o.balance, 0),
      /** Months that already have a claim waiting (tenants can't report those again). */
      awaiting: plan.awaiting,
      plan: req ? (plan.result.ok ? { lines: plan.result.lines, total: plan.result.total } : null) : null,
      error: req && !plan.result.ok ? planError(plan.result) : null,
      payee: owner ? { name: owner.fullName, upiId: owner.upiId, phone: owner.phone } : null,
    });
  });

  api.post("/tenancies/:id/payments", roles("owner", "tenant"), async (c) => {
    const a = actorOf(c);
    const b = await body(c);
    const ws = await loadWorkspace(a.ownerId);
    await ensureCharges(a.ownerId, ws);
    const tn = tenancyFor(ws, a, Number(c.req.param("id")));
    if (!tn) return c.json({ error: "Tenancy not found." }, 404);
    const clientKey = cleanClientKey(b.clientKey);

    // A retry of something already saved returns the original, whatever the balances are now.
    const again = await replay(a.ownerId, tn.id, clientKey);
    if (again?.ok) return c.json(response(again.batch, again.paymentIds, true));
    if (again) return c.json({ error: "This payment was already used for another tenancy." }, 409);

    const req = requestOf(b.amount, b.throughMonth);
    if (!req || req === "bad") return c.json({ error: "Enter the amount, or choose the months to pay." }, 400);

    const isTenant = a.role === "tenant";
    const method = isTenant ? "upi" : oneOf(b.method, ["cash", "bank", "upi"] as const);
    if (!method) return c.json({ error: "Choose how it was paid." }, 400);
    const paidOn = isTenant ? todayIST() : b.paidOn ? cleanDate(b.paidOn) : todayIST();
    if (!paidOn) return c.json({ error: "Enter a valid date." }, 400);
    if (paidOn > todayIST()) return c.json({ error: "The payment date can't be in the future." }, 400);

    const plan = await planPayment(ws, tn, a, req);
    if (!plan.result.ok) {
      if (isTenant && plan.result.code === "nothing_due" && plan.awaiting)
        return c.json({ error: "You've already told the owner about a payment. It's awaiting confirmation." }, 409);
      return c.json(
        { error: planError(plan.result), code: plan.result.code, max: plan.result.max },
        plan.result.code === "nothing_due" ? 409 : 400,
      );
    }
    // A tenant's claim must match what they actually sent: when an amount was given it is spread exactly.
    const r = await commitPayment({
      ownerId: a.ownerId,
      tenancyId: tn.id,
      lines: plan.result.lines,
      method,
      utr: cleanStr(b.utr, 40).replace(/\s/g, ""),
      note: cleanStr(b.note, 200),
      paidOn,
      status: isTenant ? "pending" : "confirmed",
      recordedBy: a.id,
      clientKey,
    });
    if (!r.ok) {
      const error =
        r.reason === "pending"
          ? "You've already told the owner about a payment for one of these months. It's awaiting confirmation."
          : r.reason === "key_reused"
            ? "This payment was already used for another tenancy."
            : "The rent changed a moment ago. Pull to refresh and try again.";
      return c.json({ error }, 409);
    }
    if (!r.duplicate) {
      if (r.batch.status === "confirmed") await afterPaymentConfirmed(a.ownerId, r.paymentIds[0]);
      await logActivity(a.id, isTenant ? "mark_paid" : "record_payment", "payment_batch", r.batch.id);
      if (isTenant)
        await announce(
          c,
          await paymentNotice(a.ownerId, {
            event: "claim",
            tenancyId: tn.id,
            amount: r.batch.amount,
            months: r.batch.months,
            ref: `b${r.batch.id}`,
          }),
        );
    }
    return c.json(response(r.batch, r.paymentIds, r.duplicate, plan.result.lines));
  });
}

function response(
  batch: { id: number; amount: number; months: number; status: string },
  paymentIds: number[],
  duplicate: boolean,
  lines?: { month: string; applied: number; balanceAfter: number; advance: boolean }[],
) {
  return {
    ok: true,
    batchId: batch.id,
    /** The first month's payment: receipts and confirmations can be reached from it. */
    paymentId: paymentIds[0],
    paymentIds,
    amount: batch.amount,
    months: batch.months,
    status: batch.status,
    duplicate,
    lines: lines?.map((l) => ({
      month: l.month,
      applied: l.applied,
      balanceAfter: l.balanceAfter,
      advance: l.advance,
    })),
  };
}
