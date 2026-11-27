/**
 * Pure billing helpers for receipts, meter bills and reminders.
 * No database imports, so `tests/unit/billing.test.ts` can import this file directly.
 */
import { daysBetween } from "../core/util.ts";

/** Bill in whole rupees for `usage` units at `ratePaise` per unit. */
export const billFor = (usage: number, ratePaise: number) => Math.max(0, Math.round((usage * ratePaise) / 100));

/** A property's own rate wins; a null column falls back to the owner's default (paise per unit). */
export const effectiveRates = (
  defaults: { electricity: number; water: number },
  property?: { electricityRate: number | null; waterRate: number | null } | null,
) => ({
  electricity: property?.electricityRate ?? defaults.electricity,
  water: property?.waterRate ?? defaults.water,
});

/**
 * Units used since the previous reading. A first reading (no previous) or a replaced meter (`reset`) uses 0.
 * Returns null when the new reading is lower than the previous one and the meter wasn't reset (a typo, most likely).
 */
export function meterUsage(reading: number, previous: number | null, reset = false): number | null {
  if (previous === null || reset) return 0;
  if (reading < previous) return null;
  return Math.round((reading - previous) * 10) / 10;
}

/** Receipt numbers read as R-YYYYMM-0001: the month the money arrived, then the document id. */
export const receiptNumber = (id: number, paidOn: string) =>
  `R-${paidOn.slice(0, 4)}${paidOn.slice(5, 7)}-${String(id).padStart(4, "0")}`;

const ONES = [
  "",
  "One",
  "Two",
  "Three",
  "Four",
  "Five",
  "Six",
  "Seven",
  "Eight",
  "Nine",
  "Ten",
  "Eleven",
  "Twelve",
  "Thirteen",
  "Fourteen",
  "Fifteen",
  "Sixteen",
  "Seventeen",
  "Eighteen",
  "Nineteen",
];
const TENS = ["", "", "Twenty", "Thirty", "Forty", "Fifty", "Sixty", "Seventy", "Eighty", "Ninety"];
function twoDigits(n: number) {
  return n < 20 ? ONES[n] : `${TENS[Math.floor(n / 10)]}${n % 10 ? `-${ONES[n % 10]}` : ""}`;
}
function threeDigits(n: number) {
  const h = Math.floor(n / 100),
    r = n % 100;
  return [h ? `${ONES[h]} Hundred` : "", r ? twoDigits(r) : ""].filter(Boolean).join(" ");
}
/** Indian numbering: 1,23,45,678 → One Crore Twenty-Three Lakh Forty-Five Thousand Six Hundred Seventy-Eight. */
export function rupeesInWords(n: number): string {
  n = Math.round(Math.abs(n));
  if (n === 0) return "Rupees Zero Only";
  const crore = Math.floor(n / 1e7),
    lakh = Math.floor((n % 1e7) / 1e5),
    thousand = Math.floor((n % 1e5) / 1e3),
    rest = n % 1e3;
  const parts = [
    crore ? `${crore >= 100 ? threeDigits(crore) : twoDigits(crore)} Crore` : "",
    lakh ? `${twoDigits(lakh)} Lakh` : "",
    thousand ? `${twoDigits(thousand)} Thousand` : "",
    rest ? threeDigits(rest) : "",
  ].filter(Boolean);
  return `Rupees ${parts.join(" ")} Only`;
}

/** True when an unpaid charge falls inside the reminder window (due within `daysBefore` days, or already late). */
export function inReminderWindow(
  c: { balance: number; status: string; dueDate: string },
  today: string,
  daysBefore: number,
) {
  return c.balance > 0 && c.status !== "awaiting" && daysBetween(today, c.dueDate) <= daysBefore;
}

/** Short, human reason shown next to a queued reminder. */
export function reminderReason(dueDate: string, today: string) {
  const d = daysBetween(today, dueDate);
  return d > 1
    ? `Due in ${d} days`
    : d === 1
      ? "Due tomorrow"
      : d === 0
        ? "Due today"
        : `${-d} ${d === -1 ? "day" : "days"} late`;
}

/** Indian financial year that a month falls in, by its starting year: 2026-03 → 2025 (FY 2025–26). */
export const fyOf = (month: string) =>
  Number(month.slice(5, 7)) >= 4 ? Number(month.slice(0, 4)) : Number(month.slice(0, 4)) - 1;
export const fyLabel = (fy: number) => `FY ${fy}–${String((fy + 1) % 100).padStart(2, "0")}`;

/** Monthly usage above this is always flagged, whatever the unit's history (kWh for electricity, units for water). */
const USAGE_CEILING: Record<"electricity" | "water", number> = { electricity: 1500, water: 100 };
/** Usage more than this many times the unit's recent average is flagged. */
const USAGE_SPIKE_FACTOR = 3;

/**
 * Sanity check for a new reading. Returns a short reason when usage looks wrong (a misread digit, most often),
 * or null when it looks normal. `recent` holds the usage of the unit's last few readings of the same meter.
 */
export function unusualUsage(usage: number, recent: number[], kind: "electricity" | "water"): string | null {
  const unit = kind === "water" ? "units" : "kWh";
  if (usage > USAGE_CEILING[kind]) {
    return `${usage} ${unit} is above the ${USAGE_CEILING[kind]} ${unit} limit for one reading.`;
  }
  const past = recent.filter((u) => Number.isFinite(u) && u > 0);
  if (!past.length) return null;
  const avg = past.reduce((s, u) => s + u, 0) / past.length;
  if (usage > avg * USAGE_SPIKE_FACTOR) {
    return `${usage} ${unit} is more than ${USAGE_SPIKE_FACTOR}× the recent average of ${Math.round(avg * 10) / 10} ${unit}.`;
  }
  return null;
}
