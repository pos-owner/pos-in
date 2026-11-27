/**
 * Pure rules for spreading one payment over several months (multi-month and advance rent).
 * No database imports, so `tests/unit/allocation.test.ts` can import this file directly. The server builds the list
 * of open months from the ledger (domain/payments.ts) and the database re-checks every month when it writes.
 */
import { addMonths, chargeDueDate, monthOf } from "../core/util.ts";

/** A month that can take money: an existing charge with a balance, or an upcoming month not billed yet. */
export interface OpenMonth {
  /** Null for an upcoming month whose charge is created together with the payment. */
  chargeId: number | null;
  /** YYYY-MM */
  month: string;
  dueDate: string;
  /** The month's total (rent plus meter bills). */
  amount: number;
  /** Meter bills included in `amount`. */
  extra: number;
  /** Confirmed so far. */
  paid: number;
  /** Still due: amount - paid. Always > 0 for an open month. */
  balance: number;
}

export interface PlanLine extends OpenMonth {
  /** What this payment puts toward the month. */
  applied: number;
  /** What is left on the month afterwards. */
  balanceAfter: number;
  /** A month after the current one (rent paid ahead). */
  advance: boolean;
}

export type AllocationRequest = { amount: number } | { throughMonth: string };

type AllocationResult =
  | { ok: true; lines: PlanLine[]; total: number; max: number; maxMonth: string | null }
  | {
      ok: false;
      code: "nothing_due" | "over_max" | "beyond_limit" | "bad_amount";
      max: number;
      maxMonth: string | null;
    };

/**
 * Upcoming months the tenancy can be paid ahead for, that have no charge yet: from the month after `current` (or
 * the tenancy's first month, if it starts later) up to `maxAhead` months ahead, never past the lease end or a
 * scheduled move-out.
 * Ended tenancies can't be paid ahead.
 */
export function upcomingMonths(
  t: {
    startDate: string;
    endDate: string | null;
    status: string;
    rent: number;
    dueDay: number;
    moveOutDate?: string | null;
  },
  billedMonths: Iterable<string>,
  current: string,
  maxAhead: number,
): OpenMonth[] {
  if (t.status !== "active" || maxAhead < 1) return [];
  const billed = new Set(billedMonths);
  const start = monthOf(t.startDate);
  let m = start > current ? start : addMonths(current, 1);
  let last = addMonths(current, maxAhead);
  if (t.endDate && monthOf(t.endDate) < last) last = monthOf(t.endDate);
  // A scheduled move-out ends billing, so nothing can be paid ahead past it either.
  if (t.moveOutDate && monthOf(t.moveOutDate) < last) last = monthOf(t.moveOutDate);
  const out: OpenMonth[] = [];
  for (; m <= last; m = addMonths(m, 1)) {
    if (billed.has(m)) continue;
    out.push({
      chargeId: null,
      month: m,
      dueDate: chargeDueDate(m, t.dueDay, t.startDate),
      amount: t.rent,
      extra: 0,
      paid: 0,
      balance: t.rent,
    });
  }
  return out;
}

/**
 * Spreads a payment over open months, oldest first. Either a rupee `amount` (the last month it reaches may be paid in
 * part) or `throughMonth` (everything still due up to and including that month). Never puts more on a month than
 * its balance, and refuses more money than all open months together can take.
 */
export function allocate(open: OpenMonth[], req: AllocationRequest, current: string): AllocationResult {
  const months = open.filter((o) => o.balance > 0).sort((a, b) => a.month.localeCompare(b.month));
  const max = months.reduce((s, o) => s + o.balance, 0);
  const maxMonth = months.length ? months[months.length - 1].month : null;
  if (!months.length) return { ok: false, code: "nothing_due", max: 0, maxMonth: null };

  let remaining: number;
  if ("throughMonth" in req) {
    if (!/^\d{4}-\d{2}$/.test(req.throughMonth)) return { ok: false, code: "beyond_limit", max, maxMonth };
    if (maxMonth && req.throughMonth > maxMonth) return { ok: false, code: "beyond_limit", max, maxMonth };
    remaining = months.filter((o) => o.month <= req.throughMonth).reduce((s, o) => s + o.balance, 0);
    if (remaining <= 0) return { ok: false, code: "nothing_due", max, maxMonth };
  } else {
    if (!Number.isInteger(req.amount) || req.amount < 1) return { ok: false, code: "bad_amount", max, maxMonth };
    if (req.amount > max) return { ok: false, code: "over_max", max, maxMonth };
    remaining = req.amount;
  }

  const lines: PlanLine[] = [];
  for (const o of months) {
    if (remaining <= 0) break;
    const applied = Math.min(o.balance, remaining);
    remaining -= applied;
    lines.push({ ...o, applied, balanceAfter: o.balance - applied, advance: o.month > current });
  }
  return { ok: true, lines, total: lines.reduce((s, l) => s + l.applied, 0), max, maxMonth };
}

/** "Nov 2026" or "Nov 2026 – Feb 2027": the months a payment covers, for receipts and lists. */
export function monthSpan(months: string[]): { from: string; to: string } | null {
  if (!months.length) return null;
  const sorted = [...months].sort();
  return { from: sorted[0], to: sorted[sorted.length - 1] };
}
