import { dateLabel, daysFromToday, rupees } from "./format";
import type { LeaseState, LeaseTerm } from "./types";

/* Lease wording shared by the owner's tenant screen and the tenant's own lease screen. */

export const LEASE_STATE: Record<LeaseState, { label: string; cls: string }> = {
  active: { label: "Running", cls: "green" },
  ending: { label: "Ending soon", cls: "orange" },
  holdover: { label: "Holdover", cls: "red" },
  moving_out: { label: "Moving out", cls: "purple" },
  ended: { label: "Ended", cls: "gray" },
};

export const TERM_REASON: Record<LeaseTerm["reason"], string> = {
  initial: "Original lease",
  renewal: "Renewal",
  revision: "Rent revision",
};

/** "₹12,000 from 1 Apr 2026 to 28 Feb 2027" */
export function termLine(t: Pick<LeaseTerm, "rent" | "startDate" | "endDate">) {
  return `${rupees(t.rent)} from ${dateLabel(t.startDate, true)}${t.endDate ? ` to ${dateLabel(t.endDate, true)}` : ""}`;
}

/** One line on where the lease stands, for the owner and the tenant. */
export function leaseStatusText(
  tn: { state?: LeaseState; endDate: string | null; moveOutDate?: string | null },
  you = false,
) {
  const state = tn.state ?? "active";
  if (state === "moving_out" && tn.moveOutDate)
    return `${you ? "You move" : "Moves"} out on ${dateLabel(tn.moveOutDate, true)}. Rent runs until then.`;
  if (state === "holdover" && tn.endDate) {
    const d = -daysFromToday(tn.endDate);
    return `The lease ended ${d} ${d === 1 ? "day" : "days"} ago. Rent continues at the last amount until it's renewed or a move-out is set.`;
  }
  if (state === "ending" && tn.endDate) {
    const d = daysFromToday(tn.endDate);
    return `The lease ends in ${d} ${d === 1 ? "day" : "days"}, on ${dateLabel(tn.endDate, true)}.`;
  }
  if (state === "ended") return "This tenancy has ended.";
  return tn.endDate ? `Runs until ${dateLabel(tn.endDate, true)}.` : "No end date set. It runs month to month.";
}
