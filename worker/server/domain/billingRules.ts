/**
 * Pure rules for late fees and recurring expenses. No database imports, so `tests/unit/fees.test.ts` and
 * `tests/unit/recurring.test.ts` can import this file directly.
 */
import { addDays, addMonths, daysInMonth, monthOf } from "../core/util.ts";

/* ---------- late fees ---------- */

/** The `late_fees` flow config. mode: 0 = flat amount, 1 = percent of the month's rent, 2 = amount per day late. */
interface LateFeeConfig {
  graceDays: number;
  mode: 0 | 1 | 2;
  amount: number;
  /** Most a month can collect in late fees (0 = no cap). */
  cap: number;
}

const int = (v: unknown, min: number, max: number, dflt: number) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : dflt;
};

/** Reads a stored config defensively (old or hand-edited rows never break the daily job). */
export function lateFeeConfig(raw: Record<string, unknown>): LateFeeConfig {
  const mode = int(raw.mode, 0, 2, 0) as 0 | 1 | 2;
  return {
    graceDays: int(raw.graceDays, 0, 60, 5),
    mode,
    amount: int(raw.amount, 0, mode === 1 ? 100 : 100_000, mode === 1 ? 2 : 500),
    cap: int(raw.cap, 0, 1_000_000, 0),
  };
}

/** The last day rent can be paid without a fee. A fee applies from the next day. */
export const graceEnd = (dueDate: string, graceDays: number) => addDays(dueDate, graceDays);

/** Rent part of a charge (what a percent fee is worked out on): pro-rated rent, or the amount less bills and fees. */
function rentBase(c: { amount: number; extra: number; fees: number; rentPart: number | null }): number {
  return Math.max(0, c.rentPart ?? c.amount - c.extra - c.fees);
}

/** Most per-day fees one daily run adds to a single month (it catches up over the following days). */
const MAX_FEE_ROWS_PER_RUN = 31;

/**
 * The fee rows to add to one unpaid month today. `existing` are the month's fee rows so far (waived ones included):
 * a period is never charged twice, the cap counts every fee ever added (waiving doesn't make room for more), and once
 * the owner has waived any fee on a month no further fees accrue on it.
 */
export function feesToAdd(
  c: { amount: number; extra: number; fees: number; rentPart: number | null; dueDate: string },
  existing: { period: string; amount: number; waived: boolean }[],
  cfg: LateFeeConfig,
  today: string,
): { period: string; amount: number }[] {
  if (cfg.amount <= 0) return [];
  const start = graceEnd(c.dueDate, cfg.graceDays);
  if (today <= start) return [];
  if (existing.some((e) => e.waived)) return [];
  const have = new Set(existing.map((e) => e.period));
  let room = cfg.cap > 0 ? cfg.cap - existing.reduce((s, e) => s + e.amount, 0) : Infinity;
  if (room <= 0) return [];
  const out: { period: string; amount: number }[] = [];
  const push = (period: string, amount: number) => {
    const a = Math.min(amount, room);
    if (a <= 0 || have.has(period)) return;
    out.push({ period, amount: a });
    room -= a;
  };
  if (cfg.mode === 0) push("once", cfg.amount);
  else if (cfg.mode === 1) push("once", Math.round((rentBase(c) * cfg.amount) / 100));
  else {
    for (let d = addDays(start, 1); d <= today && out.length < MAX_FEE_ROWS_PER_RUN && room > 0; d = addDays(d, 1)) {
      push(d, cfg.amount);
    }
  }
  return out;
}

/* ---------- recurring expenses ---------- */

export const FREQUENCIES = ["monthly", "quarterly", "half_yearly", "yearly"] as const;
export type Frequency = (typeof FREQUENCIES)[number];
const FREQUENCY_MONTHS: Record<Frequency, number> = { monthly: 1, quarterly: 3, half_yearly: 6, yearly: 12 };

/** Most periods one daily run generates for one recurring expense (an old start date catches up over a few days). */
const MAX_PERIODS_PER_RUN = 12;

/** The next date after `date`, keeping the day of month `day` (1–31) where the month has it. */
function nextPeriodDate(date: string, frequency: Frequency, day = Number(date.slice(8, 10))): string {
  const month = addMonths(monthOf(date), FREQUENCY_MONTHS[frequency]);
  const d = Math.min(day, daysInMonth(month));
  return `${month}-${String(d).padStart(2, "0")}`;
}

/**
 * Periods due on or before `today`, starting at `nextDate`, and the date the expense moves on to. `day` is the
 * day of month the expense was set up on (so a 31st survives February).
 */
export function duePeriods(
  nextDate: string,
  frequency: Frequency,
  today: string,
  day = Number(nextDate.slice(8, 10)),
  limit = MAX_PERIODS_PER_RUN,
): { dates: string[]; next: string } {
  const dates: string[] = [];
  let d = nextDate;
  while (d <= today && dates.length < limit) {
    dates.push(d);
    d = nextPeriodDate(d, frequency, day);
  }
  return { dates, next: d };
}
