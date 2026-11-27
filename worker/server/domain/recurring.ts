import { and, eq, inArray, lte, sql } from "drizzle-orm";
import { db, expenses, properties, recurringExpenses } from "../../db/index.ts";
import { todayIST } from "../core/util.ts";
import { flow } from "./automations.ts";
import { duePeriods, FREQUENCIES, type Frequency } from "./billingRules.ts";
import { notify } from "./notifications.ts";

/*
 * Recurring expenses: society maintenance, property tax, internet. Each rule keeps `next_date`, the
 * next day an expense is due. The daily job turns every due period into an ordinary, approved `expenses` row with
 * `(recurring_id, period)` unique, so running twice (or two isolates at once) can never log a period twice, and
 * deleting a rule keeps the expenses it already logged (`recurring_id` is set to NULL).
 *
 * The day of month a rule was set up on is the date of its first logged expense (or `next_date` before then), so a
 * bill on the 31st lands on the 28th/29th/30th in short months and goes back to the 31st afterwards.
 */

type RecurringRow = typeof recurringExpenses.$inferSelect;

/** The first date each rule logged an expense for (its anchor day), or nothing for a rule that never ran. */
export async function firstLogged(ids: number[]): Promise<Map<number, { first: string; last: string; count: number }>> {
  const out = new Map<number, { first: string; last: string; count: number }>();
  if (!ids.length) return out;
  const rows = await db
    .select({
      id: expenses.recurringId,
      first: sql<string>`min(${expenses.date})`,
      last: sql<string>`max(${expenses.date})`,
      count: sql<number>`count(*)`,
    })
    .from(expenses)
    .where(inArray(expenses.recurringId, ids))
    .groupBy(expenses.recurringId);
  for (const r of rows) if (r.id != null) out.set(r.id, { first: r.first, last: r.last, count: Number(r.count) });
  return out;
}

const anchorDay = (rule: Pick<RecurringRow, "nextDate">, first?: string) =>
  Number((first ?? rule.nextDate).slice(8, 10));

const asFrequency = (f: string): Frequency =>
  (FREQUENCIES as readonly string[]).includes(f) ? (f as Frequency) : "monthly";

/**
 * Logs every due period of one rule and moves `next_date` on, in one atomic batch. The update is guarded by the
 * `next_date` it started from, so a second run at the same moment changes nothing (and its inserts are no-ops).
 */
async function runRule(rule: RecurringRow, today: string, first?: string): Promise<number> {
  const { dates, next } = duePeriods(rule.nextDate, asFrequency(rule.frequency), today, anchorDay(rule, first));
  if (!dates.length) return 0;
  const values = dates.map((date) => ({
    propertyId: rule.propertyId,
    category: rule.category,
    amount: rule.amount,
    date,
    note: rule.note || "Recurring expense",
    submittedBy: rule.createdBy,
    approved: true,
    recurringId: rule.id,
    period: date.slice(0, 7),
  }));
  const [inserted] = await db.batch([
    db.insert(expenses).values(values).onConflictDoNothing().returning({ id: expenses.id }),
    db
      .update(recurringExpenses)
      .set({ nextDate: next })
      .where(and(eq(recurringExpenses.id, rule.id), eq(recurringExpenses.nextDate, rule.nextDate))),
  ]);
  return inserted.length;
}

/**
 * Daily (and right after a rule is saved): turns each due recurring expense into `expenses` rows. Idempotent per
 * period. Returns the number of rows created. `onlyId` limits the run to one rule (used after saving it, so a rule
 * whose first date is today or already past shows its expense straight away).
 */
export async function generateRecurringExpenses(ownerId: string, today = todayIST(), onlyId?: number): Promise<number> {
  const f = await flow(ownerId, "recurring_expenses");
  if (!f.enabled) return 0;
  const where = and(
    eq(recurringExpenses.ownerId, ownerId),
    eq(recurringExpenses.active, true),
    lte(recurringExpenses.nextDate, today),
    ...(onlyId ? [eq(recurringExpenses.id, onlyId)] : []),
  );
  // Only rules on properties that still belong to the owner (a property moved or deleted takes its rules with it).
  const rows = await db
    .select({ r: recurringExpenses })
    .from(recurringExpenses)
    .innerJoin(properties, eq(recurringExpenses.propertyId, properties.id))
    .where(and(where, eq(properties.ownerId, ownerId)))
    .limit(20);
  if (!rows.length) return 0;
  const firsts = await firstLogged(rows.map((x) => x.r.id));
  let created = 0;
  for (const { r } of rows) {
    try {
      created += await runRule(r, today, firsts.get(r.id)?.first);
    } catch (e) {
      console.error("recurring expense failed", r.id, e);
    }
  }
  if (created && !onlyId)
    await notify([
      {
        ownerId,
        recipientId: ownerId,
        kind: "recurring_expense",
        title: `${created} recurring ${created === 1 ? "expense" : "expenses"} logged`,
        body: "Society maintenance, taxes and other regular bills were added to your expenses.",
        url: "/more/expenses",
        entity: "expense",
        dedupe: `recurring_expense:${today}`,
      },
    ]);
  return created;
}
