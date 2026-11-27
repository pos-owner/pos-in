import { eq, inArray } from "drizzle-orm";
import {
  db,
  properties,
  units,
  tenants,
  tenancies,
  charges,
  payments,
  maintenanceRequests,
  requestComments,
  expenses,
  documents,
  meterReadings,
  activityLog,
} from "../../db/index.ts";
import { billFor, effectiveRates, receiptNumber } from "./billing.ts";
import { rates } from "./meters.ts";
import { ensureCharges, loadWorkspace } from "./data.ts";
import { addDays, addMonths, computeStatus, monthOf, todayIST } from "../core/util.ts";

/**
 * Demo data so a new owner can explore every screen right away:
 * 2 properties, 7 units, 6 tenants, a few months of charges in every state, requests, expenses,
 * receipts for confirmed payments, and electricity and water meter readings.
 * Sai Krupa has its own utility rates (society water meters), so per-property rates show up in the demo.
 *
 * Cloudflare's free plan allows 50 database queries per request, and this runs inside the onboarding request, so
 * related writes go out as single multi-row inserts or one `db.batch` (a batch counts as one query). About 20 in all.
 */
export async function seedWorkspace(ownerId: string, ownerName: string) {
  const today = todayIST();
  const cur = monthOf(today);
  const first = (back: number) => `${addMonths(cur, -back)}-01`;

  const [p1, p2] = await db
    .insert(properties)
    .values([
      { ownerId, name: "Lakshmi Nilaya", address: "14, 6th Cross, HAL 2nd Stage, Indiranagar, Bengaluru 560038" },
      {
        ownerId,
        name: "Sai Krupa Apartments",
        address: "Plot 22, Paud Road, Kothrud, Pune 411038",
        electricityRate: 750,
        waterRate: 3000,
      },
    ])
    .returning();

  const u = await db
    .insert(units)
    .values([
      { propertyId: p1.id, label: "Ground floor", type: "2BHK", baseRent: 26500 },
      { propertyId: p1.id, label: "First floor", type: "2BHK", baseRent: 27500 },
      { propertyId: p1.id, label: "Terrace studio", type: "1RK", baseRent: 11800 },
      { propertyId: p1.id, label: "Second floor", type: "3BHK", baseRent: 38000 },
      { propertyId: p2.id, label: "A-101", type: "1BHK", baseRent: 14200 },
      { propertyId: p2.id, label: "A-102", type: "1BHK", baseRent: 14500 },
      { propertyId: p2.id, label: "B-203", type: "2BHK", baseRent: 21000 },
    ])
    .returning();

  const t = await db
    .insert(tenants)
    .values([
      {
        ownerId,
        fullName: "Ananya Raghavan",
        phone: "919845012376",
        email: "ananya.r@example.in",
        idNote: "Aadhaar ending 4417",
        emergencyContact: "K. Raghavan (father) 9845011890",
        moveInDate: first(7),
        deposit: 80000,
      },
      {
        ownerId,
        fullName: "Farhan Qureshi",
        phone: "919900234561",
        email: "farhanq@example.in",
        idNote: "PAN on file",
        emergencyContact: "Sana Qureshi 9900234500",
        moveInDate: first(5),
        deposit: 82500,
      },
      {
        ownerId,
        fullName: "Meera Pillai",
        phone: "918971345208",
        email: "",
        idNote: "Aadhaar ending 0932",
        emergencyContact: "Arjun Pillai 8971345200",
        moveInDate: first(3),
        deposit: 23600,
      },
      {
        ownerId,
        fullName: "Rohit Deshmukh",
        phone: "919822456713",
        email: "rohit.d@example.in",
        idNote: "Company lease letter",
        emergencyContact: "Pallavi Deshmukh 9822456700",
        moveInDate: first(10),
        deposit: 42600,
      },
      {
        ownerId,
        fullName: "Kavya & Nikhil Joshi",
        phone: "917720398845",
        email: "kavya.joshi@example.in",
        idNote: "Aadhaar x2",
        emergencyContact: "Sunita Joshi 7720398800",
        moveInDate: first(4),
        deposit: 43500,
      },
      {
        ownerId,
        fullName: "Tenzin Dorjee",
        phone: "918830112294",
        email: "",
        idNote: "Passport copy",
        emergencyContact: "Pema 8830112200",
        moveInDate: first(2),
        deposit: 63000,
      },
    ])
    .returning();

  const leaseEnd = addDays(today, 34);
  const tn = await db
    .insert(tenancies)
    .values([
      {
        unitId: u[0].id,
        tenantId: t[0].id,
        rent: 26500,
        dueDay: 5,
        deposit: 80000,
        startDate: first(7),
        endDate: null,
      },
      {
        unitId: u[1].id,
        tenantId: t[1].id,
        rent: 27500,
        dueDay: 5,
        deposit: 82500,
        startDate: first(5),
        endDate: leaseEnd,
      },
      {
        unitId: u[2].id,
        tenantId: t[2].id,
        rent: 11800,
        dueDay: 10,
        deposit: 23600,
        startDate: first(3),
        endDate: null,
      },
      {
        unitId: u[4].id,
        tenantId: t[3].id,
        rent: 14200,
        dueDay: 7,
        deposit: 42600,
        startDate: first(10),
        endDate: null,
      },
      {
        unitId: u[5].id,
        tenantId: t[4].id,
        rent: 14500,
        dueDay: 28,
        deposit: 43500,
        startDate: first(4),
        endDate: null,
      },
      {
        unitId: u[6].id,
        tenantId: t[5].id,
        rent: 21000,
        dueDay: 1,
        deposit: 63000,
        startDate: first(2),
        endDate: null,
      },
    ])
    .returning();

  await ensureCharges(ownerId, await loadWorkspace(ownerId), true);
  const ch = await db
    .select()
    .from(charges)
    .where(
      inArray(
        charges.tenancyId,
        tn.map((x) => x.id),
      ),
    );

  const pays: (typeof payments.$inferInsert)[] = [];
  const day = (m: string, d: number) => `${m}-${String(d).padStart(2, "0")}`;
  for (const c of ch) {
    const idx = tn.findIndex((x) => x.id === c.tenancyId);
    const isCur = c.month === cur;
    const base = { chargeId: c.id, recordedBy: ownerId, utr: "", note: "" };
    if (!isCur) {
      // Past months: all paid, with a mix of methods; one tenant paid a past month in two parts.
      if (idx === 3 && c.month === addMonths(cur, -2)) {
        pays.push({ ...base, amount: 8000, method: "cash", paidOn: day(c.month, 8), note: "First part" });
        pays.push({ ...base, amount: c.amount - 8000, method: "upi", utr: "432918877120", paidOn: day(c.month, 19) });
      } else {
        const method = idx % 3 === 0 ? "upi" : idx % 3 === 1 ? "bank" : "cash";
        pays.push({
          ...base,
          amount: c.amount,
          method,
          utr: method === "upi" ? String(410000000000 + c.id * 7919) : "",
          paidOn: day(c.month, Math.min(28, 3 + idx)),
        });
      }
      continue;
    }
    // Current month: one of each state.
    if (idx === 0) pays.push({ ...base, amount: c.amount, method: "upi", utr: "533120984467", paidOn: day(cur, 4) });
    if (idx === 2) pays.push({ ...base, amount: 6000, method: "cash", paidOn: day(cur, 9), note: "Rest after salary" });
    if (idx === 3)
      pays.push({
        ...base,
        amount: c.amount,
        method: "upi",
        utr: "533187702145",
        status: "pending",
        recordedBy: null,
        paidOn: today,
        note: "Paid via PhonePe",
      });
    // idx 1 and 5: overdue. idx 4: due later this month.
  }
  const paid = pays.length ? await db.insert(payments).values(pays).returning() : [];

  // Receipts for every confirmed payment, numbered like the live flow (R-YYYYMM-0001).
  const tenancyOfCharge = new Map(ch.map((c) => [c.id, c.tenancyId]));
  // Oldest first, so receipt numbers increase with the payment date as they do in the live flow.
  const confirmed = paid
    .filter((p) => p.status === "confirmed")
    .sort((a, b) => String(a.paidOn).localeCompare(String(b.paidOn)) || a.id - b.id);
  if (confirmed.length) {
    const docs = await db
      .insert(documents)
      .values(
        confirmed.map((p) => ({
          ownerId,
          tenancyId: tenancyOfCharge.get(p.chargeId)!,
          paymentId: p.id,
          kind: "receipt",
          number: "",
        })),
      )
      .returning();
    // One D1 batch: every receipt gets its number in a single round trip, all or nothing.
    const paidOnOf = new Map(confirmed.map((p) => [p.id, p.paidOn]));
    const numbering = docs.map((d) =>
      db
        .update(documents)
        .set({ number: receiptNumber(d.id, paidOnOf.get(d.paymentId!)!) })
        .where(eq(documents.id, d.id)),
    );
    // The automation run log for this month's receipts goes in the same batch.
    const recent = confirmed.filter((p) => monthOf(p.paidOn) === cur);
    const log = recent.length
      ? [
          db.insert(activityLog).values(
            recent.map((p) => ({
              actorId: ownerId,
              action: "auto_receipt",
              entity: "payment",
              entityId: String(p.id),
            })),
          ),
        ]
      : [];
    const all = [...numbering, ...log];
    if (all.length) await db.batch(all as [(typeof all)[number], ...typeof all]);
  }

  // Meter readings: last month's readings set the starting point; this month's are billed into rent.
  // Electricity for every let unit; water only at Sai Krupa (tenancies 3–5), which bills society water meters.
  const defaults = await rates(ownerId);
  const rateOf = (i: number, kind: "electricity" | "water") => {
    const r = effectiveRates(defaults, i >= 3 ? p2 : p1);
    return kind === "water" ? r.water : r.electricity;
  };
  const lastMonth = day(addMonths(cur, -1), 1);
  const start: { i: number; kind: "electricity" | "water"; reading: number }[] = [
    ...[4031.2, 2210.4, 1187.9, 6602.5, 3340.0, 5120.7].map((reading, i) => ({
      i,
      kind: "electricity" as const,
      reading,
    })),
    ...[312.4, 188.9, 451.2].map((reading, k) => ({ i: 3 + k, kind: "water" as const, reading })),
  ];
  await db.insert(meterReadings).values(
    start.map(({ i, kind, reading }) => ({
      unitId: tn[i].unitId,
      kind,
      reading,
      previous: null,
      usage: 0,
      rate: rateOf(i, kind),
      amount: 0,
      readOn: lastMonth,
      recordedBy: ownerId,
      recordedByName: ownerName,
    })),
  );
  const thisMonth: [number, "electricity" | "water", number, number][] = [
    [2, "electricity", 96.5, 0.96],
    [4, "electricity", 142.8, 0.94],
    [4, "water", 9.6, 0.91],
    [5, "water", 14.2, 0.88],
  ];
  const readings = await db
    .insert(meterReadings)
    .values(
      thisMonth.map(([i, kind, usage, confidence]) => {
        const prev = start.find((x) => x.i === i && x.kind === kind)!.reading;
        const rate = rateOf(i, kind);
        return {
          unitId: tn[i].unitId,
          kind,
          reading: Math.round((prev + usage) * 10) / 10,
          previous: prev,
          usage,
          rate,
          amount: billFor(usage, rate),
          confidence,
          readOn: day(cur, 1),
          recordedBy: ownerId,
          recordedByName: ownerName,
        };
      }),
    )
    .returning();
  /*
   * Put each bill on this month's rent, like `applyBillToRent` does in the live flow: linking the reading to the
   * charge makes the meter_bill_add trigger add the amount. Charges, payments and statuses are already known here,
   * so every link, status update and run-log row goes out in one batch.
   */
  const billed = new Map<number, number>();
  const linkOps = [];
  const logRows: (typeof activityLog.$inferInsert)[] = [];
  for (let k = 0; k < thisMonth.length; k++) {
    const [i, kind] = thisMonth[k];
    const r = readings.find((x) => x.unitId === tn[i].unitId && x.kind === kind);
    const c = ch.find((x) => x.tenancyId === tn[i].id && x.month === cur);
    if (!r || !c || r.amount <= 0) continue;
    billed.set(c.id, (billed.get(c.id) ?? c.amount) + r.amount);
    linkOps.push(db.update(meterReadings).set({ chargeId: c.id }).where(eq(meterReadings.id, r.id)));
    logRows.push({ actorId: ownerId, action: "auto_bill", entity: "meter_reading", entityId: String(r.id) });
  }
  for (const [chargeId, amount] of billed) {
    const c = ch.find((x) => x.id === chargeId)!;
    const { status } = computeStatus(
      { ...c, amount },
      paid.filter((p) => p.chargeId === chargeId),
      today,
    );
    if (status !== c.status) linkOps.push(db.update(charges).set({ status }).where(eq(charges.id, chargeId)));
  }
  if (logRows.length) linkOps.push(db.insert(activityLog).values(logRows));
  if (linkOps.length) await db.batch(linkOps as [(typeof linkOps)[number], ...typeof linkOps]);

  const reqs = await db
    .insert(maintenanceRequests)
    .values([
      {
        unitId: u[0].id,
        raisedByName: "Ananya Raghavan",
        title: "Kitchen sink draining slowly",
        description: "Water takes a few minutes to drain since the weekend. No leak under the cabinet.",
        priority: "medium",
        status: "open",
      },
      {
        unitId: u[6].id,
        raisedByName: "Tenzin Dorjee",
        title: "Geyser trips the MCB",
        description: "Bathroom geyser switches off the main breaker within a minute of turning it on.",
        priority: "high",
        status: "in_progress",
      },
      {
        unitId: u[4].id,
        raisedByName: ownerName,
        title: "Repaint balcony grill",
        description: "Rust spots near the railing. Schedule before monsoon.",
        priority: "low",
        status: "done",
      },
    ])
    .returning();
  await db.insert(requestComments).values([
    { requestId: reqs[1].id, authorName: ownerName, body: "Electrician Suresh is coming Thursday 11 am." },
    { requestId: reqs[1].id, authorName: "Tenzin Dorjee", body: "Thanks, I'll be home." },
    { requestId: reqs[2].id, authorName: ownerName, body: "Done. Used Asian Paints anti-rust primer." },
  ]);

  const m1 = addMonths(cur, -1);
  await db.insert(expenses).values([
    {
      propertyId: p1.id,
      category: "Repairs",
      amount: 1850,
      date: day(cur, 3),
      note: "Plumber: bathroom tap cartridge",
      submittedBy: ownerId,
      approved: true,
    },
    {
      propertyId: p1.id,
      category: "Utilities",
      amount: 2340,
      date: day(m1, 12),
      note: "Common area electricity (BESCOM)",
      submittedBy: ownerId,
      approved: true,
    },
    {
      propertyId: p2.id,
      category: "Maintenance",
      amount: 3600,
      date: day(m1, 6),
      note: "Society maintenance, A-wing",
      submittedBy: ownerId,
      approved: true,
    },
    {
      propertyId: p2.id,
      category: "Cleaning",
      amount: 900,
      date: day(cur, 2),
      note: "Water tank cleaning (staff entry)",
      submittedBy: ownerId,
      approved: false,
    },
    {
      propertyId: p1.id,
      category: "Tax",
      amount: 14275,
      date: day(addMonths(cur, -3), 20),
      note: "BBMP property tax, half year",
      submittedBy: ownerId,
      approved: true,
    },
  ]);
}
