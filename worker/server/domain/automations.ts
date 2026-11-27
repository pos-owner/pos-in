import { and, desc, eq, gte, inArray, like } from "drizzle-orm";
import { activityLog, automations, db } from "../../db/index.ts";
import { ensureReceipt } from "../pdf/documents.ts";

/**
 * Ready-made workflows. Each workspace stores only its overrides in the `automations` table;
 * anything not stored uses the defaults below.
 */
export const FLOWS = {
  meter_to_bill: {
    title: "Add meter bills to rent",
    sub: "Readings you save add their bill to that month's rent. Staff readings wait for your approval first",
    defaultOn: true,
    defaults: {},
  },
  rent_reminders: {
    title: "Rent reminder queue",
    sub: "Lines up one-tap WhatsApp reminders before and after the due date",
    defaultOn: true,
    defaults: { daysBefore: 2, repeatEvery: 3 },
  },
  auto_receipts: {
    title: "Receipt for every payment",
    sub: "Issues a numbered PDF receipt the moment a payment is confirmed",
    defaultOn: true,
    defaults: {},
  },
  advance_rent: {
    title: "Advance rent",
    sub: "Tenants can pay several months at once, including months ahead (never past the lease end)",
    defaultOn: true,
    defaults: { maxMonthsAhead: 12 },
  },
  lease_alerts: {
    title: "Lease expiry alerts",
    sub: "Reminds you before a lease ends, and flags leases that ran past their end date",
    defaultOn: true,
    /** Days before the lease end date that an alert goes out. */
    defaults: { first: 60, second: 30, last: 7 },
  },
  prorate: {
    title: "Pro-rate move-in and move-out",
    sub: "Charges only the days lived in during the first and last month",
    defaultOn: false,
    /** method: 0 = actual days in the month, 1 = a 30-day month. */
    defaults: { method: 0 },
  },
  late_fees: {
    title: "Late fees",
    sub: "Adds a late fee to rent that is still unpaid after the grace period. You can waive any fee",
    defaultOn: false,
    /** mode: 0 = flat amount, 1 = percent of the month's rent, 2 = amount per day late. cap 0 = no cap. */
    defaults: { graceDays: 5, mode: 0, amount: 500, cap: 0 },
  },
  recurring_expenses: {
    title: "Recurring expenses",
    sub: "Logs society maintenance, taxes and other regular bills on their due date",
    defaultOn: true,
    defaults: {},
  },
} as const;
export type FlowKey = keyof typeof FLOWS;
const FLOW_KEYS = Object.keys(FLOWS) as FlowKey[];

interface FlowState {
  key: FlowKey;
  title: string;
  sub: string;
  enabled: boolean;
  config: Record<string, number>;
}

export async function loadFlows(ownerId: string): Promise<FlowState[]> {
  const rows = await db.select().from(automations).where(eq(automations.ownerId, ownerId));
  return FLOW_KEYS.map((key) => {
    const f = FLOWS[key];
    const r = rows.find((x) => x.name === key);
    return {
      key,
      title: f.title,
      sub: f.sub,
      enabled: r ? r.enabled : f.defaultOn,
      config: { ...f.defaults, ...((r?.config ?? {}) as Record<string, number>) },
    };
  });
}

export async function flow(ownerId: string, key: FlowKey) {
  return (await loadFlows(ownerId)).find((f) => f.key === key)!;
}

export async function saveFlow(ownerId: string, key: FlowKey, enabled: boolean, config: Record<string, number>) {
  await db
    .insert(automations)
    .values({ ownerId, name: key, enabled, config })
    .onConflictDoUpdate({ target: [automations.ownerId, automations.name], set: { enabled, config } });
}

/** Run log entries are activity rows with an `auto_` action, written as the workspace owner. */
export async function logRun(ownerId: string, action: string, entity: string, entityId?: string | number) {
  await db.insert(activityLog).values({
    actorId: ownerId,
    action: `auto_${action}`,
    entity,
    entityId: entityId == null ? null : String(entityId),
  });
}

export async function recentRuns(ownerId: string, limit = 20) {
  return db
    .select()
    .from(activityLog)
    .where(and(eq(activityLog.actorId, ownerId), like(activityLog.action, "auto_%")))
    .orderBy(desc(activityLog.createdAt))
    .limit(limit);
}

/** Called after an owner confirms or records a payment. */
export async function afterPaymentConfirmed(ownerId: string, paymentId: number) {
  try {
    if (!(await flow(ownerId, "auto_receipts")).enabled) return;
    const doc = await ensureReceipt(ownerId, paymentId);
    if (doc?.created) await logRun(ownerId, "receipt", "payment", paymentId);
  } catch (e) {
    // A receipt failure must never undo the payment itself.
    console.error("auto receipt failed", e);
  }
}

/** Charges reminded within the last `days` days (owner tapped a reminder). */
export async function recentlyReminded(ownerId: string, chargeIds: number[], days: number) {
  if (!chargeIds.length) return new Set<number>();
  const since = new Date(Date.now() - days * 86400000);
  const rows = await db
    .select({ entityId: activityLog.entityId })
    .from(activityLog)
    .where(
      and(
        eq(activityLog.actorId, ownerId),
        eq(activityLog.action, "remind"),
        eq(activityLog.entity, "charge"),
        gte(activityLog.createdAt, since),
        inArray(activityLog.entityId, chargeIds.map(String)),
      ),
    );
  return new Set(rows.map((r) => Number(r.entityId)));
}
