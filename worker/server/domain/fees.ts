import { and, eq, inArray } from "drizzle-orm";
import { chargeAdjustments, db } from "../../db/index.ts";
import { daysBetween, todayIST } from "../core/util.ts";
import { flow } from "./automations.ts";
import { feesToAdd, graceEnd, lateFeeConfig } from "./billingRules.ts";
import { loadLedger, type Workspace } from "./data.ts";
import { notify, type NotifyInput } from "./notifications.ts";

/*
 * Late fees (the `late_fees` flow, off by default). Once a month's rent is still unpaid `graceDays` after its due
 * date, the daily job adds `charge_adjustments` rows (kind `late_fee`). Triggers add them to `charges.fees` and
 * `charges.amount` (and take one off again when the owner waives it), so the ledger, balances and receipts see it.
 *
 *  - mode 0 (flat):     `amount` rupees, once per month (period "once")
 *  - mode 1 (percent):  `amount` percent of the month's rent part, once per month (period "once")
 *  - mode 2 (per day):  `amount` rupees for every day it stays unpaid (period = that day, YYYY-MM-DD)
 *
 * The rules themselves (cap, waived months, per-day catch-up) are pure functions in billingRules.ts. The unique
 * (charge, kind, period) index makes a repeat run a no-op.
 */

/** Daily: applies late fees to overdue charges when the `late_fees` flow is on. Returns how many fees were added. */
export async function applyLateFees(ownerId: string, ws: Workspace, today = todayIST()): Promise<number> {
  const f = await flow(ownerId, "late_fees");
  if (!f.enabled) return 0;
  const cfg = lateFeeConfig(f.config);
  const activeIds = ws.tenancyRows.filter((t) => t.status === "active").map((t) => t.id);
  if (!activeIds.length) return 0;
  // Unpaid months past the grace period. A month with a payment waiting for the owner's confirmation is left alone:
  // the tenant says they've paid.
  const rows = (await loadLedger(ws, { tenancyIds: activeIds })).filter(
    (r) => r.balance > 0 && r.pending === 0 && today > graceEnd(r.dueDate, cfg.graceDays),
  );
  if (!rows.length) return 0;
  const existing = await db
    .select()
    .from(chargeAdjustments)
    .where(
      and(
        eq(chargeAdjustments.ownerId, ownerId),
        eq(chargeAdjustments.kind, "late_fee"),
        inArray(
          chargeAdjustments.chargeId,
          rows.map((r) => r.id),
        ),
      ),
    );
  const values: (typeof chargeAdjustments.$inferInsert)[] = [];
  for (const r of rows) {
    const mine = existing
      .filter((x) => x.chargeId === r.id)
      .map((x) => ({ period: x.period, amount: x.amount, waived: !!x.waivedAt }));
    const add = feesToAdd(r, mine, cfg, today);
    for (const fee of add) {
      values.push({
        ownerId,
        chargeId: r.id,
        kind: "late_fee",
        period: fee.period,
        amount: fee.amount,
        note:
          cfg.mode === 2
            ? `Late fee for ${fee.period} (${daysBetween(r.dueDate, fee.period)} days after the due date)`
            : `Late fee: unpaid ${daysBetween(r.dueDate, today)} days after the due date`,
      });
    }
  }
  if (!values.length) return 0;
  const created: { id: number; chargeId: number; amount: number }[] = [];
  // 7 columns a row, so 14 rows stay under D1's 100-parameter cap.
  for (let k = 0; k < values.length; k += 14) {
    created.push(
      ...(await db
        .insert(chargeAdjustments)
        .values(values.slice(k, k + 14))
        .onConflictDoNothing()
        .returning({
          id: chargeAdjustments.id,
          chargeId: chargeAdjustments.chargeId,
          amount: chargeAdjustments.amount,
        })),
    );
  }
  // Tell the tenant (best-effort; `notify` never throws): one message per month, whatever the number of fee rows.
  // Per-day fees notify once per month, not every day.
  const byCharge = new Map<number, { amount: number; firstId: number }>();
  for (const adj of created) {
    const cur = byCharge.get(adj.chargeId);
    byCharge.set(adj.chargeId, { amount: (cur?.amount ?? 0) + adj.amount, firstId: cur?.firstId ?? adj.id });
  }
  const items: NotifyInput[] = [];
  for (const [chargeId, sum] of byCharge) {
    const r = rows.find((x) => x.id === chargeId);
    if (!r) continue;
    const uid = ws.tenantRows.find((t) => t.id === r.tenantId)?.userId;
    if (!uid) continue;
    items.push({
      ownerId,
      recipientId: uid,
      kind: "late_fee",
      title: `Late fee of ₹${sum.amount.toLocaleString("en-IN")} added`,
      body:
        cfg.mode === 2
          ? `Rent for ${r.month} is overdue, so a fee is added for each day it stays unpaid. Pay now to stop it growing.`
          : `Rent for ${r.month} is still unpaid after the due date. Pay soon to avoid more charges.`,
      url: "/",
      entity: "charge",
      entityId: r.id,
      dedupe: cfg.mode === 2 ? `late_fee:${r.id}:daily` : `late_fee:${sum.firstId}`,
    });
  }
  if (items.length) await notify(items);
  return created.length;
}
