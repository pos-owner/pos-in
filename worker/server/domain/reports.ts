import { and, eq, gte, inArray, lt, lte } from "drizzle-orm";
import { charges, db, expenses, payments } from "../../db/index.ts";
import { loadWorkspace } from "./data.ts";
import { addMonths, daysBetween, monthOf, todayIST } from "../core/util.ts";
import { fyLabel, fyOf } from "./billing.ts";

interface ReportMonth {
  month: string;
  income: number;
  expenses: number;
  profit: number;
  billed: number;
  collectedOnBill: number;
  occupied: number;
  units: number;
}

/** Either the last `span` months, or one financial year (April to March, cut off at the current month). */
type ReportWindow = { span: number } | { fy: number };

/**
 * Income, expenses, profit, occupancy and late-payment trends for a window of months.
 * Income is cash basis (confirmed payments by the date they were received); expenses count only approved entries.
 */
export async function buildReport(ownerId: string, win: ReportWindow, propertyId?: number) {
  const ws = await loadWorkspace(ownerId);
  const today = todayIST();
  const cur = monthOf(today);
  const fy = "fy" in win ? Math.min(win.fy, fyOf(cur)) : null;
  const first = fy !== null ? `${fy}-04` : addMonths(cur, -((win as { span: number }).span - 1));
  const last = fy !== null ? (`${fy + 1}-03` < cur ? `${fy + 1}-03` : cur) : cur;
  const span =
    (Number(last.slice(0, 4)) - Number(first.slice(0, 4))) * 12 +
    Number(last.slice(5, 7)) -
    Number(first.slice(5, 7)) +
    1;
  const months = Array.from({ length: span }, (_, i) => addMonths(first, i));
  const inWindow = (m: string) => m >= first && m <= last;

  const props = propertyId ? ws.props.filter((p) => p.id === propertyId) : ws.props;
  const propIds = new Set(props.map((p) => p.id));
  const unitRows = ws.unitRows.filter((u) => propIds.has(u.propertyId));
  const unitIds = new Set(unitRows.map((u) => u.id));
  const tenancyRows = ws.tenancyRows.filter((t) => unitIds.has(t.unitId));
  const tenancyById = new Map(tenancyRows.map((t) => [t.id, t]));
  const tenantById = new Map(ws.tenantRows.map((t) => [t.id, t]));

  const tIds = tenancyRows.map((t) => t.id);
  const chargeRows = tIds.length
    ? await db
        .select()
        .from(charges)
        .where(and(inArray(charges.tenancyId, tIds), gte(charges.month, first), lte(charges.month, last)))
    : [];
  const allChargeRows = tIds.length
    ? await db
        .select({ id: charges.id, tenancyId: charges.tenancyId })
        .from(charges)
        .where(inArray(charges.tenancyId, tIds))
    : [];
  const chargeTenancy = new Map(allChargeRows.map((c) => [c.id, c.tenancyId]));
  const payRows = allChargeRows.length
    ? await db
        .select()
        .from(payments)
        .where(
          and(
            inArray(
              payments.chargeId,
              allChargeRows.map((c) => c.id),
            ),
            eq(payments.status, "confirmed"),
          ),
        )
    : [];
  const expRows = propIds.size
    ? await db
        .select()
        .from(expenses)
        .where(
          and(
            inArray(expenses.propertyId, [...propIds]),
            eq(expenses.approved, true),
            gte(expenses.date, `${first}-01`),
            lt(expenses.date, `${addMonths(last, 1)}-01`),
          ),
        )
    : [];

  const covers = (t: (typeof tenancyRows)[number], m: string) =>
    monthOf(t.startDate) <= m && (!t.endDate || monthOf(t.endDate) >= m) && (t.status === "active" || !!t.endDate);

  const byMonth: ReportMonth[] = months.map((m) => {
    const income = payRows.filter((p) => monthOf(p.paidOn) === m).reduce((s, p) => s + p.amount, 0);
    const spend = expRows.filter((e) => monthOf(e.date) === m).reduce((s, e) => s + e.amount, 0);
    const mc = chargeRows.filter((c) => c.month === m);
    const billed = mc.reduce((s, c) => s + c.amount, 0);
    const collectedOnBill = mc.reduce(
      (s, c) =>
        s +
        Math.min(
          c.amount,
          payRows.filter((p) => p.chargeId === c.id).reduce((x, p) => x + p.amount, 0),
        ),
      0,
    );
    const occ = new Set(tenancyRows.filter((t) => covers(t, m)).map((t) => t.unitId));
    return {
      month: m,
      income,
      expenses: spend,
      profit: income - spend,
      billed,
      collectedOnBill,
      occupied: occ.size,
      units: unitRows.length,
    };
  });

  /* Per property */
  const byProperty = props.map((p) => {
    const pu = new Set(unitRows.filter((u) => u.propertyId === p.id).map((u) => u.id));
    const income = payRows
      .filter((x) => {
        const tn = tenancyById.get(chargeTenancy.get(x.chargeId) ?? -1);
        return tn && pu.has(tn.unitId) && inWindow(monthOf(x.paidOn));
      })
      .reduce((s, x) => s + x.amount, 0);
    const spend = expRows.filter((e) => e.propertyId === p.id).reduce((s, e) => s + e.amount, 0);
    const occupiedNow = new Set(
      tenancyRows.filter((t) => t.status === "active" && pu.has(t.unitId)).map((t) => t.unitId),
    ).size;
    return {
      id: p.id,
      name: p.name,
      income,
      expenses: spend,
      profit: income - spend,
      units: pu.size,
      occupied: occupiedNow,
    };
  });

  /* Expense categories */
  const cat = new Map<string, number>();
  for (const e of expRows) cat.set(e.category, (cat.get(e.category) ?? 0) + e.amount);
  const categories = [...cat.entries()]
    .map(([category, amount]) => ({ category, amount }))
    .sort((a, b) => b.amount - a.amount);

  /* Late payments: for each charge already due, when did confirmed payments first cover it? */
  const late = new Map<number, { tenantId: number; months: number; late: number; daysLate: number; unpaid: number }>();
  for (const c of chargeRows) {
    if (c.dueDate >= today) continue;
    const tn = tenancyById.get(c.tenancyId);
    if (!tn) continue;
    const rec = late.get(tn.tenantId) ?? { tenantId: tn.tenantId, months: 0, late: 0, daysLate: 0, unpaid: 0 };
    rec.months++;
    let sum = 0;
    let settledOn: string | null = null;
    for (const p of payRows.filter((x) => x.chargeId === c.id).sort((a, b) => a.paidOn.localeCompare(b.paidOn))) {
      sum += p.amount;
      if (sum >= c.amount) {
        settledOn = p.paidOn;
        break;
      }
    }
    const d = daysBetween(c.dueDate, settledOn ?? today);
    if (!settledOn) {
      rec.late++;
      rec.unpaid++;
      rec.daysLate += Math.max(0, d);
    } else if (d > 0) {
      rec.late++;
      rec.daysLate += d;
    }
    late.set(tn.tenantId, rec);
  }
  const latePayers = [...late.values()]
    .filter((r) => r.late > 0)
    .map((r) => ({
      tenantId: r.tenantId,
      tenantName: tenantById.get(r.tenantId)?.fullName ?? "Tenant",
      lateMonths: r.late,
      months: r.months,
      unpaid: r.unpaid,
      avgDaysLate: Math.round(r.daysLate / r.late),
    }))
    .sort((a, b) => b.lateMonths - a.lateMonths || b.avgDaysLate - a.avgDaysLate);

  /* Rent received per tenant in the window (for the owner's books and tenants' HRA claims). */
  const unitById = new Map(ws.unitRows.map((u) => [u.id, u]));
  const recv = new Map<number, { received: number; billed: number; units: Set<string> }>();
  const tenantRec = (tenantId: number) => {
    let r = recv.get(tenantId);
    if (!r) recv.set(tenantId, (r = { received: 0, billed: 0, units: new Set() }));
    return r;
  };
  for (const p of payRows) {
    if (!inWindow(monthOf(p.paidOn))) continue;
    const tn = tenancyById.get(chargeTenancy.get(p.chargeId) ?? -1);
    if (!tn) continue;
    const r = tenantRec(tn.tenantId);
    r.received += p.amount;
    r.units.add(unitById.get(tn.unitId)?.label ?? "");
  }
  for (const c of chargeRows) {
    const tn = tenancyById.get(c.tenancyId);
    if (!tn) continue;
    const r = tenantRec(tn.tenantId);
    r.billed += c.amount;
    r.units.add(unitById.get(tn.unitId)?.label ?? "");
  }
  const byTenant = [...recv.entries()]
    .map(([tenantId, r]) => ({
      tenantId,
      tenantName: tenantById.get(tenantId)?.fullName ?? "Tenant",
      units: [...r.units].filter(Boolean).join(", "),
      received: r.received,
      billed: r.billed,
    }))
    .sort((a, b) => b.received - a.received);

  const income = byMonth.reduce((s, m) => s + m.income, 0);
  const spend = byMonth.reduce((s, m) => s + m.expenses, 0);
  const billed = byMonth.reduce((s, m) => s + m.billed, 0);
  const collected = byMonth.reduce((s, m) => s + m.collectedOnBill, 0);
  const unitMonths = byMonth.reduce((s, m) => s + m.units, 0);
  const occMonths = byMonth.reduce((s, m) => s + m.occupied, 0);

  /* Vacancy for each unit over the window (months without a tenancy). */
  const vacancy = unitRows
    .map((u) => {
      const vacant = months.filter((m) => !tenancyRows.some((t) => t.unitId === u.id && covers(t, m))).length;
      return {
        unitId: u.id,
        unitLabel: u.label,
        propertyName: ws.props.find((p) => p.id === u.propertyId)?.name ?? "",
        vacantMonths: vacant,
      };
    })
    .filter((v) => v.vacantMonths > 0)
    .sort((a, b) => b.vacantMonths - a.vacantMonths);

  /*
   * Income from house property, as a starting point for the owner's CA: rent received less municipal (property) tax
   * paid gives the net annual value; a flat 30% standard deduction applies to that. Home-loan interest is not tracked.
   */
  const municipalTax = expRows.filter((e) => e.category === "Tax").reduce((s, e) => s + e.amount, 0);
  const netAnnualValue = Math.max(0, income - municipalTax);
  const standardDeduction = Math.round(netAnnualValue * 0.3);

  /* Financial years with any data, newest first (from the earliest tenancy to the current year). */
  const earliest = ws.tenancyRows.reduce((m, t) => (t.startDate < m ? t.startDate : m), today);
  const years = Array.from({ length: fyOf(cur) - fyOf(monthOf(earliest)) + 1 }, (_, i) => fyOf(cur) - i);

  return {
    span,
    from: first,
    to: last,
    today,
    fy,
    label: fy !== null ? fyLabel(fy) : `Last ${span} months`,
    years: years.map((y) => ({ fy: y, label: fyLabel(y) })),
    complete: fy === null || last === `${fy + 1}-03`,
    properties: ws.props.map((p) => ({ id: p.id, name: p.name })),
    totals: {
      income,
      expenses: spend,
      profit: income - spend,
      billed,
      collected,
      collectionRate: billed ? collected / billed : 1,
      occupancy: unitMonths ? occMonths / unitMonths : 0,
      units: unitRows.length,
    },
    months: byMonth,
    byProperty,
    categories,
    latePayers,
    vacancy,
    byTenant,
    tax: {
      rentReceived: income,
      municipalTax,
      netAnnualValue,
      standardDeduction,
      taxable: netAnnualValue - standardDeduction,
    },
  };
}
