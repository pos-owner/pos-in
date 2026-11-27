import { and, eq, inArray } from "drizzle-orm";
import { db, documents, paymentBatches } from "../../db/index.ts";
import type { StatementModel } from "../../../shared/pdf/models.ts";
import { fyLabel, fyOf } from "./billing.ts";
import type { LedgerRow, Workspace } from "./data.ts";

/*
 * Rent statements: one tenancy over a month, a calendar year or an April–March financial year, for the
 * tenant's HRA claim. Built from the ledger, so it always agrees with receipts and balances.
 */

export type StatementPeriod = "month" | "year" | "fy";

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

/** Pure: the months a period covers and how it is written. Null for a malformed value. */
export function periodRange(
  period: StatementPeriod,
  value: string,
): { from: string; to: string; label: string; slug: string } | null {
  if (period === "month") {
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(value)) return null;
    return {
      from: value,
      to: value,
      label: `${MONTHS[Number(value.slice(5, 7)) - 1]} ${value.slice(0, 4)}`,
      slug: value,
    };
  }
  if (!/^\d{4}$/.test(value)) return null;
  const y = Number(value);
  if (y < 2000 || y > 2100) return null;
  if (period === "year") return { from: `${y}-01`, to: `${y}-12`, label: String(y), slug: String(y) };
  return {
    from: `${y}-04`,
    to: `${y + 1}-03`,
    label: fyLabel(y).replace("–", "-"),
    slug: `FY${y}-${String((y + 1) % 100).padStart(2, "0")}`,
  };
}

/** Financial years (by starting year) that have a month in `months`, newest first. */
export const fysOf = (months: string[]) => [...new Set(months.map(fyOf))].sort((a, b) => b - a);

/** Pure: the month lines and totals of a statement from ledger rows. */
function statementLines(
  rows: Pick<LedgerRow, "month" | "amount" | "extra" | "fees" | "rentPart" | "paid" | "balance">[],
  from: string,
  to: string,
) {
  const months = rows
    .filter((r) => r.month >= from && r.month <= to)
    .sort((a, b) => a.month.localeCompare(b.month))
    .map((r) => {
      const rent = Math.max(0, r.rentPart ?? r.amount - r.extra - (r.fees ?? 0));
      return {
        month: r.month,
        rent,
        utilities: r.extra,
        fees: r.fees ?? 0,
        charged: r.amount,
        paid: r.paid,
        balance: r.balance,
      };
    });
  return {
    months,
    totalRent: months.reduce((s, m) => s + m.rent, 0),
    totalCharged: months.reduce((s, m) => s + m.charged, 0),
    totalPaid: months.reduce((s, m) => s + m.paid, 0),
    balance: months.reduce((s, m) => s + m.balance, 0),
  };
}

/**
 * The statement data for one tenancy and period. `rows` is the tenancy's ledger. Payments are the confirmed ones on
 * the period's months; a multi-month payment is one line with the months it covered.
 */
export async function buildStatement(
  ws: Workspace,
  tn: Workspace["tenancyRows"][number],
  rows: LedgerRow[],
  period: StatementPeriod,
  range: NonNullable<ReturnType<typeof periodRange>>,
  people: { ownerName: string; ownerPhone: string; ownerPan: string },
  issuedOn: string,
): Promise<StatementModel> {
  const u = ws.unitRows.find((x) => x.id === tn.unitId);
  const p = u ? ws.props.find((x) => x.id === u.propertyId) : undefined;
  const t = ws.tenantRows.find((x) => x.id === tn.tenantId);
  const lines = statementLines(rows, range.from, range.to);
  const inPeriod = rows.filter((r) => r.month >= range.from && r.month <= range.to);
  const pays = inPeriod.flatMap((r) =>
    r.payments.filter((x) => x.status === "confirmed").map((x) => ({ ...x, month: r.month })),
  );
  const paymentIds = pays.map((x) => x.id);
  const batchIds = [...new Set(pays.map((x) => x.batchId).filter((x): x is number => x != null))];
  const docs = paymentIds.length
    ? await db
        .select({ number: documents.number, paymentId: documents.paymentId })
        .from(documents)
        .where(and(eq(documents.kind, "receipt"), inArray(documents.paymentId, paymentIds)))
    : [];
  const batches = batchIds.length
    ? await db.select().from(paymentBatches).where(inArray(paymentBatches.id, batchIds))
    : [];
  // Receipts of multi-month payments hang off the batch's first month, which may be outside this period.
  const batchDocs = batchIds.length
    ? await db
        .select({ number: documents.number, batchId: documents.batchId })
        .from(documents)
        .where(inArray(documents.batchId, batchIds))
    : [];
  const out: StatementModel["payments"] = [];
  const seenBatch = new Set<number>();
  for (const x of pays.sort((a, b) => a.paidOn.localeCompare(b.paidOn) || a.month.localeCompare(b.month))) {
    if (x.batchId != null) {
      if (seenBatch.has(x.batchId)) continue;
      seenBatch.add(x.batchId);
      const b = batches.find((y) => y.id === x.batchId);
      const parts = pays.filter((y) => y.batchId === x.batchId);
      const ms = parts.map((y) => y.month).sort();
      out.push({
        paidOn: b?.paidOn ?? x.paidOn,
        // Only what went to months in this period counts toward it.
        amount: parts.reduce((s, y) => s + y.amount, 0),
        method: b?.method ?? x.method,
        utr: b?.utr ?? x.utr,
        receipt: batchDocs.find((d) => d.batchId === x.batchId)?.number ?? "",
        months: ms.length > 1 ? `${ms[0]} to ${ms[ms.length - 1]}` : ms[0],
      });
    } else {
      out.push({
        paidOn: x.paidOn,
        amount: x.amount,
        method: x.method,
        utr: x.utr,
        receipt: docs.find((d) => d.paymentId === x.id)?.number ?? "",
        months: x.month,
      });
    }
  }
  const unitSlug = (u?.label ?? "unit").replace(/\W+/g, "-");
  return {
    kind: "statement",
    filename: `Rent-statement-${range.slug}-${unitSlug}.pdf`,
    period,
    periodLabel: range.label,
    from: range.from,
    to: range.to,
    issuedOn,
    tenantName: t?.fullName ?? "",
    tenantPhone: t?.phone ?? "",
    tenantPan: t?.pan ?? "",
    unitLabel: u?.label ?? "",
    propertyName: p?.name ?? "",
    address: p?.address ?? "",
    ownerName: people.ownerName,
    ownerPhone: people.ownerPhone,
    ownerPan: people.ownerPan,
    months: lines.months,
    payments: out,
    totalRent: lines.totalRent,
    totalCharged: lines.totalCharged,
    totalPaid: lines.totalPaid,
    balance: lines.balance,
  };
}
