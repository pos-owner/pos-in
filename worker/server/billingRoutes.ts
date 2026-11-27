import type { Context, Hono } from "hono";
import { and, desc, eq, inArray } from "drizzle-orm";
import { chargeAdjustments, charges, db, properties, recurringExpenses, tenancies, units } from "../db/index.ts";
import { actorOf, roles, type Env } from "./core/auth.ts";
import { canReadLedger, type Actor } from "./core/access.ts";
import { body } from "./core/http.ts";
import { cleanDate, cleanInt, cleanStr, oneOf, todayIST } from "./core/util.ts";
import { loadWorkspace, logActivity, syncChargeStatus } from "./domain/data.ts";
import { flow } from "./domain/automations.ts";
import { FREQUENCIES } from "./domain/billingRules.ts";
import { firstLogged, generateRecurringExpenses } from "./domain/recurring.ts";

/*
 * Late fees and recurring expenses. Pro-rating has no routes of its own: it is an automation
 * setting (`PATCH /api/automations/prorate`) that `ensureCharges` reads when it creates a month.
 *
 *   GET    /api/charges/:id/fees          the month's late fees, waived ones included (owner, or the tenant on it)
 *   POST   /api/fees/:id/waive            { reason } takes a fee off the month (owner). Once.
 *   GET    /api/recurring                 the owner's recurring expenses
 *   POST   /api/recurring                 { propertyId, category, amount, frequency, nextDate, note }
 *   PATCH  /api/recurring/:id             any of the above, plus { active }
 *   DELETE /api/recurring/:id             stops it; expenses already logged stay
 */

/** A charge in the actor's workspace, with the tenant it belongs to, or null. */
async function chargeInWorkspace(a: Actor, chargeId: number) {
  const [row] = await db
    .select({ c: charges, tenantId: tenancies.tenantId })
    .from(charges)
    .innerJoin(tenancies, eq(charges.tenancyId, tenancies.id))
    .innerJoin(units, eq(tenancies.unitId, units.id))
    .innerJoin(properties, eq(units.propertyId, properties.id))
    .where(and(eq(charges.id, chargeId), eq(properties.ownerId, a.ownerId)));
  if (!row || !canReadLedger(a, { ownerId: a.ownerId, tenantId: row.tenantId })) return null;
  return row;
}

async function ownedRule(a: Actor, id: number) {
  const [r] = await db
    .select({ r: recurringExpenses })
    .from(recurringExpenses)
    .innerJoin(properties, eq(recurringExpenses.propertyId, properties.id))
    .where(
      and(eq(recurringExpenses.id, id), eq(recurringExpenses.ownerId, a.ownerId), eq(properties.ownerId, a.ownerId)),
    );
  return r?.r ?? null;
}

const FEE_PAID = "This fee is already covered by a payment. Void that payment first, then waive the fee.";

export function registerBillingRoutes(api: Hono<Env>) {
  /* ---------- late fees ---------- */

  api.get("/charges/:id/fees", roles("owner", "tenant"), async (c) => {
    const a = actorOf(c);
    const row = await chargeInWorkspace(a, Number(c.req.param("id")));
    if (!row) return c.json({ error: "Charge not found." }, 404);
    const fees = await db
      .select()
      .from(chargeAdjustments)
      .where(and(eq(chargeAdjustments.chargeId, row.c.id), eq(chargeAdjustments.ownerId, a.ownerId)))
      .orderBy(chargeAdjustments.period, chargeAdjustments.id);
    return c.json({
      fees: fees.map((f) => ({
        id: f.id,
        period: f.period,
        amount: f.amount,
        note: f.note,
        createdAt: f.createdAt,
        waivedAt: f.waivedAt,
        // The reason is the owner's note; tenants see that it was waived, not why.
        waiveReason: a.role === "owner" ? f.waiveReason : "",
      })),
    });
  });

  api.post("/fees/:id/waive", roles("owner"), async (c) => {
    const a = actorOf(c);
    const [fee] = await db
      .select()
      .from(chargeAdjustments)
      .where(and(eq(chargeAdjustments.id, Number(c.req.param("id"))), eq(chargeAdjustments.ownerId, a.ownerId)));
    if (!fee || !(await chargeInWorkspace(a, fee.chargeId))) return c.json({ error: "Fee not found." }, 404);
    if (fee.waivedAt) return c.json({ error: "This fee was already waived." }, 409);
    const b = await body(c);
    const reason = cleanStr(b.reason, 200);
    if (!reason) return c.json({ error: "Say why the fee is being waived." }, 400);
    let done: { id: number }[];
    try {
      // The trigger takes the fee off the month; its guard refuses when payments already cover it.
      done = await db
        .update(chargeAdjustments)
        .set({ waivedAt: new Date(), waivedBy: a.id, waiveReason: reason })
        .where(and(eq(chargeAdjustments.id, fee.id), eq(chargeAdjustments.ownerId, a.ownerId)))
        .returning({ id: chargeAdjustments.id });
    } catch (e) {
      if (/pos:fee_already_paid/.test(String((e as Error)?.message ?? e) + String((e as Error)?.cause ?? "")))
        return c.json({ error: FEE_PAID }, 409);
      throw e;
    }
    if (!done.length) return c.json({ error: "This fee was already waived." }, 409);
    await syncChargeStatus(fee.chargeId);
    await logActivity(a.id, "waive", "late_fee", fee.id);
    return c.json({ ok: true });
  });

  /* ---------- recurring expenses ---------- */

  api.get("/recurring", roles("owner"), async (c) => {
    const a = actorOf(c);
    const ws = await loadWorkspace(a.ownerId);
    const f = await flow(a.ownerId, "recurring_expenses");
    const propIds = ws.props.map((p) => p.id);
    const rows = propIds.length
      ? await db
          .select()
          .from(recurringExpenses)
          .where(and(eq(recurringExpenses.ownerId, a.ownerId), inArray(recurringExpenses.propertyId, propIds)))
          .orderBy(desc(recurringExpenses.active), recurringExpenses.nextDate)
      : [];
    const logged = await firstLogged(rows.map((r) => r.id));
    const nameOf = new Map(ws.props.map((p) => [p.id, p.name]));
    return c.json({
      enabled: f.enabled,
      items: rows.map((r) => ({
        id: r.id,
        propertyId: r.propertyId,
        propertyName: nameOf.get(r.propertyId) ?? "",
        category: r.category,
        amount: r.amount,
        frequency: r.frequency,
        nextDate: r.nextDate,
        note: r.note,
        active: r.active,
        generated: logged.get(r.id)?.count ?? 0,
        lastDate: logged.get(r.id)?.last ?? null,
      })),
      properties: ws.props.map((p) => ({ id: p.id, name: p.name })),
    });
  });

  /** Validates a create or edit. `cur` is the rule being edited (fields left out keep their value). */
  async function ruleInput(c: Context<Env>, a: Actor, cur?: typeof recurringExpenses.$inferSelect) {
    const b = await body(c);
    const out: Partial<typeof recurringExpenses.$inferInsert> = {};
    if (b.propertyId !== undefined || !cur) {
      const ws = await loadWorkspace(a.ownerId);
      const p = ws.props.find((x) => x.id === Number(b.propertyId));
      if (!p) return { error: "Choose a property." };
      out.propertyId = p.id;
    }
    if (b.category !== undefined || !cur) {
      const category = cleanStr(b.category, 40);
      if (!category) return { error: "Choose a category." };
      out.category = category;
    }
    if (b.amount !== undefined || !cur) {
      const amount = cleanInt(b.amount, 1, 10_000_000);
      if (!amount) return { error: "Enter the amount." };
      out.amount = amount;
    }
    if (b.frequency !== undefined || !cur) {
      const frequency = oneOf(b.frequency, FREQUENCIES);
      if (!frequency) return { error: "Choose how often it repeats." };
      out.frequency = frequency;
    }
    if (b.nextDate !== undefined || !cur) {
      const nextDate = cleanDate(b.nextDate);
      if (!nextDate) return { error: "Enter the date it's next due." };
      // A rule set up far in the past would log years of back expenses at once; catching up is capped anyway.
      if (nextDate < `${Number(todayIST().slice(0, 4)) - 1}${todayIST().slice(4)}`)
        return { error: "Choose a date within the last year." };
      out.nextDate = nextDate;
    }
    if (typeof b.note === "string") out.note = cleanStr(b.note, 200);
    if (typeof b.active === "boolean") out.active = b.active;
    return { values: out };
  }

  api.post("/recurring", roles("owner"), async (c) => {
    const a = actorOf(c);
    const r = await ruleInput(c, a);
    if ("error" in r) return c.json({ error: r.error }, 400);
    const v = r.values;
    const [row] = await db
      .insert(recurringExpenses)
      .values({
        ownerId: a.ownerId,
        propertyId: v.propertyId!,
        category: v.category!,
        amount: v.amount!,
        frequency: v.frequency!,
        nextDate: v.nextDate!,
        note: v.note ?? "",
        active: v.active ?? true,
        createdBy: a.id,
      })
      .returning();
    await logActivity(a.id, "create", "recurring_expense", row.id);
    // A first date of today (or earlier) is logged straight away, not tomorrow morning.
    const logged = await generateRecurringExpenses(a.ownerId, todayIST(), row.id);
    return c.json({ ok: true, id: row.id, logged });
  });

  api.patch("/recurring/:id", roles("owner"), async (c) => {
    const a = actorOf(c);
    const cur = await ownedRule(a, Number(c.req.param("id")));
    if (!cur) return c.json({ error: "Recurring expense not found." }, 404);
    const r = await ruleInput(c, a, cur);
    if ("error" in r) return c.json({ error: r.error }, 400);
    if (Object.keys(r.values).length)
      await db.update(recurringExpenses).set(r.values).where(eq(recurringExpenses.id, cur.id));
    await logActivity(a.id, "update", "recurring_expense", cur.id);
    const logged = await generateRecurringExpenses(a.ownerId, todayIST(), cur.id);
    return c.json({ ok: true, logged });
  });

  api.delete("/recurring/:id", roles("owner"), async (c) => {
    const a = actorOf(c);
    const cur = await ownedRule(a, Number(c.req.param("id")));
    if (!cur) return c.json({ error: "Recurring expense not found." }, 404);
    // Expenses it already logged stay (their recurring_id becomes NULL), so the books don't change.
    await db.delete(recurringExpenses).where(eq(recurringExpenses.id, cur.id));
    await logActivity(a.id, "delete", "recurring_expense", cur.id);
    return c.json({ ok: true });
  });
}
