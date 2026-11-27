import type { tenancies } from "../../db/index.ts";
import { daysInMonth, monthOf } from "../core/util.ts";
import { flow } from "./automations.ts";

type Tenancy = typeof tenancies.$inferSelect;

/*
 * Pro-rating (owner setting, the `prorate` flow, off by default): the move-in and move-out months are charged only
 * for the days lived in. `round(rent × days / base)`, where base is the actual number of days in the month
 * (method 0) or a flat 30 (method 1). A full month is always full rent, whatever the method.
 * Only the move-out date (`move_out_date`) ends billing; a lease that runs past its end date is a holdover and keeps
 * being charged in full.
 */

/** The owner's pro-rating rule, loaded once per `ensureCharges` run (null when pro-rating is off). */
interface ProrateRule {
  /** 0 = actual days in the month, 1 = a 30-day month. */
  method: number;
}

export async function prorateRule(ownerId: string): Promise<ProrateRule | null> {
  const f = await flow(ownerId, "prorate");
  if (!f.enabled) return null;
  return { method: Number(f.config.method) === 1 ? 1 : 0 };
}

/**
 * Days lived in `month` for a stay from `startDate` to `moveOutDate` (inclusive), or null for a full month.
 * Exported for tests and for repricing a move-out month after the charge already exists.
 */
function proratedDays(month: string, startDate: string, moveOutDate: string | null): number | null {
  const dim = daysInMonth(month);
  const first = monthOf(startDate) === month ? Number(startDate.slice(8, 10)) : 1;
  const last = moveOutDate && monthOf(moveOutDate) === month ? Number(moveOutDate.slice(8, 10)) : dim;
  if (first === 1 && last === dim) return null;
  return Math.max(0, last - first + 1);
}

/** Rent for `days` of `month` under `method`. A full month (or more) is full rent. */
function proratedRent(rent: number, month: string, days: number, method: number): number {
  const dim = daysInMonth(month);
  if (days >= dim) return rent;
  const base = method === 1 ? 30 : dim;
  return Math.min(rent, Math.round((rent * Math.min(days, base)) / base));
}

/** What a new charge for `month` costs, and how it was worked out. Full rent unless pro-rating applies. */
export function chargeRent(
  t: Tenancy,
  month: string,
  rule: ProrateRule | null,
): { amount: number; rentPart: number | null; proratedDays: number | null } {
  if (!rule) return { amount: t.rent, rentPart: null, proratedDays: null };
  const days = proratedDays(month, t.startDate, t.moveOutDate ?? null);
  if (days === null) return { amount: t.rent, rentPart: null, proratedDays: null };
  const rentPart = proratedRent(t.rent, month, days, rule.method);
  if (rentPart === t.rent) return { amount: t.rent, rentPart: null, proratedDays: null };
  return { amount: rentPart, rentPart, proratedDays: days };
}

/**
 * Repricing an existing charge (a move-out scheduled after the month's charge was generated). Returns the new rent
 * part and day count, or null when the month is (now) a full month. The caller moves `charges.amount` by
 * `rentPart - currentRentPart` in one guarded statement and never below what has already been paid.
 */
export function reproratedAmount(
  t: Pick<Tenancy, "rent" | "startDate"> & { moveOutDate: string | null },
  month: string,
  rule: ProrateRule | null,
): { rentPart: number; proratedDays: number } | null {
  if (!rule) return null;
  const days = proratedDays(month, t.startDate, t.moveOutDate);
  if (days === null) return null;
  const rentPart = proratedRent(t.rent, month, days, rule.method);
  return rentPart === t.rent ? null : { rentPart, proratedDays: days };
}
