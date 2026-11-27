/*
 * Receipts and rental agreements: numbering, lists, and the data each printable document needs. The PDFs
 * themselves are drawn in the browser (shared/pdf/), which keeps pdf-lib out of the Worker and every request
 * well inside the Cloudflare free plan's 10 ms CPU limit.
 */
import { and, desc, eq, inArray } from "drizzle-orm";
import {
  charges,
  db,
  documents,
  paymentBatches,
  payments,
  profiles,
  properties,
  tenancies,
  tenants,
  units,
} from "../../db/index.ts";
import type { AgreementModel, ReceiptLine, ReceiptModel } from "../../../shared/pdf/models.ts";
import { batchInfo } from "../domain/data.ts";
import { signedCode } from "../core/codes.ts";
import { defaultLeaseEnd, todayIST } from "../core/util.ts";
import { effectiveRates, receiptNumber, rupeesInWords } from "../domain/billing.ts";

/* ---------- data ---------- */

/** A confirmed payment with everything a receipt needs, scoped to the workspace. */
export async function paymentContext(ownerId: string, paymentId: number) {
  const [row] = await db
    .select({ p: payments, c: charges, tn: tenancies, u: units, pr: properties, t: tenants })
    .from(payments)
    .innerJoin(charges, eq(payments.chargeId, charges.id))
    .innerJoin(tenancies, eq(charges.tenancyId, tenancies.id))
    .innerJoin(units, eq(tenancies.unitId, units.id))
    .innerJoin(properties, eq(units.propertyId, properties.id))
    .innerJoin(tenants, eq(tenancies.tenantId, tenants.id))
    .where(and(eq(payments.id, paymentId), eq(properties.ownerId, ownerId)));
  return row ?? null;
}

/** Issues the receipt for a confirmed payment once. Repeats return the same receipt. */
export async function ensureReceipt(ownerId: string, paymentId: number) {
  const ctx = await paymentContext(ownerId, paymentId);
  if (!ctx || (ctx.p.status !== "confirmed" && ctx.p.status !== "void")) return null;
  // Any month of a multi-month payment leads to the batch's one receipt.
  if (ctx.p.batchId != null) return ensureBatchReceipt(ownerId, ctx.p.batchId);
  const [existing] = await db.select().from(documents).where(eq(documents.paymentId, paymentId));
  if (existing) return { doc: existing, created: false };
  // A voided payment keeps the receipt it already had, but never gets a new one.
  if (ctx.p.status !== "confirmed") return null;
  const inserted = await db
    .insert(documents)
    .values({ ownerId, tenancyId: ctx.tn.id, paymentId, kind: "receipt", number: "" })
    .onConflictDoNothing()
    .returning();
  if (!inserted.length) {
    const [again] = await db.select().from(documents).where(eq(documents.paymentId, paymentId));
    return { doc: again, created: false };
  }
  const number = receiptNumber(inserted[0].id, ctx.p.paidOn);
  const [doc] = await db.update(documents).set({ number }).where(eq(documents.id, inserted[0].id)).returning();
  return { doc, created: true };
}

/**
 * One receipt for a whole multi-month payment. It hangs off the batch's first month (`payment_id`, so the existing
 * unique index also stops a second receipt) and the batch (`batch_id`, unique too).
 */
async function ensureBatchReceipt(ownerId: string, batchId: number) {
  const [b] = await db
    .select()
    .from(paymentBatches)
    .where(and(eq(paymentBatches.id, batchId), eq(paymentBatches.ownerId, ownerId)));
  if (!b || (b.status !== "confirmed" && b.status !== "void")) return null;
  const [existing] = await db.select().from(documents).where(eq(documents.batchId, batchId));
  if (existing) return { doc: existing, created: false };
  if (b.status !== "confirmed") return null;
  const [anchor] = await db
    .select({ id: payments.id })
    .from(payments)
    .where(eq(payments.batchId, batchId))
    .orderBy(payments.id)
    .limit(1);
  if (!anchor) return null;
  const inserted = await db
    .insert(documents)
    .values({ ownerId, tenancyId: b.tenancyId, paymentId: anchor.id, batchId, kind: "receipt", number: "" })
    .onConflictDoNothing()
    .returning();
  if (!inserted.length) {
    const [again] = await db.select().from(documents).where(eq(documents.batchId, batchId));
    return again ? { doc: again, created: false } : null;
  }
  const number = receiptNumber(inserted[0].id, b.paidOn);
  const [doc] = await db.update(documents).set({ number }).where(eq(documents.id, inserted[0].id)).returning();
  return { doc, created: true };
}

/** Agreements are one per tenancy; generating again returns the same record and number. */
export async function ensureAgreement(ownerId: string, tenancyId: number) {
  const [existing] = await db
    .select()
    .from(documents)
    .where(and(eq(documents.tenancyId, tenancyId), eq(documents.kind, "agreement"), eq(documents.ownerId, ownerId)));
  if (existing) return existing;
  const [doc] = await db
    .insert(documents)
    .values({ ownerId, tenancyId, kind: "agreement", number: `A-${String(tenancyId).padStart(4, "0")}` })
    .returning();
  return doc;
}

async function tenancyContext(ownerId: string, tenancyId: number) {
  const [row] = await db
    .select({ tn: tenancies, u: units, pr: properties, t: tenants })
    .from(tenancies)
    .innerJoin(units, eq(tenancies.unitId, units.id))
    .innerJoin(properties, eq(units.propertyId, properties.id))
    .innerJoin(tenants, eq(tenancies.tenantId, tenants.id))
    .where(and(eq(tenancies.id, tenancyId), eq(properties.ownerId, ownerId)));
  return row ?? null;
}

/** Receipts issued in a workspace, newest first. `tenancyIds` scopes the list for tenants. */
export async function listReceipts(ownerId: string, tenancyIds?: number[]) {
  if (tenancyIds && !tenancyIds.length) return [];
  const where = tenancyIds
    ? and(eq(documents.ownerId, ownerId), eq(documents.kind, "receipt"), inArray(documents.tenancyId, tenancyIds))
    : and(eq(documents.ownerId, ownerId), eq(documents.kind, "receipt"));
  const rows = await db
    .select({ d: documents, p: payments, c: charges, t: tenants, u: units })
    .from(documents)
    .innerJoin(payments, eq(documents.paymentId, payments.id))
    .innerJoin(charges, eq(payments.chargeId, charges.id))
    .innerJoin(tenancies, eq(charges.tenancyId, tenancies.id))
    .innerJoin(tenants, eq(tenancies.tenantId, tenants.id))
    .innerJoin(units, eq(tenancies.unitId, units.id))
    .where(where)
    .orderBy(desc(payments.paidOn), desc(documents.id))
    .limit(200);
  const batches = await batchInfo(rows.map((r) => r.d.batchId).filter((x): x is number => x != null));
  return rows.map(({ d, p, c, t, u }) => {
    const b = d.batchId != null ? batches.get(d.batchId) : undefined;
    return {
      id: d.id,
      number: d.number,
      paymentId: p.id,
      amount: b ? b.amount : p.amount,
      method: p.method,
      paidOn: p.paidOn,
      voided: b ? b.status === "void" : p.status === "void",
      month: b?.from || c.month,
      /** Last month covered, when the receipt is for several months. */
      monthTo: b && b.to !== b.from ? b.to : null,
      months: b ? b.months : 1,
      tenantName: t.fullName,
      tenantPhone: t.phone,
      unitLabel: u.label,
      createdAt: d.createdAt,
    };
  });
}

/* ---------- printable document data ---------- */

const isoDay = (d: Date) => d.toISOString().slice(0, 10);

/**
 * Everything the browser needs to draw a receipt, or null when none was issued for this payment. With `origin` (the app's address), it also carries the verification link printed as a QR
 * code on the receipt, so anyone holding the paper can check it at `/verify/<code>`.
 */
export async function receiptData(ownerId: string, paymentId: number, origin?: string): Promise<ReceiptModel | null> {
  const ctx = await paymentContext(ownerId, paymentId);
  if (!ctx || (ctx.p.status !== "confirmed" && ctx.p.status !== "void")) return null;
  const data =
    ctx.p.batchId != null ? await batchReceiptData(ownerId, ctx.p.batchId, ctx) : await singleReceiptData(ownerId, ctx);
  if (data && origin) data.verifyUrl = `${origin}/verify/${await signedCode("receipt", data.documentId)}`;
  return data;
}

async function singleReceiptData(
  ownerId: string,
  ctx: NonNullable<Awaited<ReturnType<typeof paymentContext>>>,
): Promise<ReceiptModel | null> {
  const paymentId = ctx.p.id;
  const [[docRow], [owner], pays] = await db.batch([
    db.select().from(documents).where(eq(documents.paymentId, paymentId)),
    db.select().from(profiles).where(eq(profiles.id, ownerId)),
    db
      .select()
      .from(payments)
      .where(and(eq(payments.chargeId, ctx.c.id), eq(payments.status, "confirmed"))),
  ]);
  if (!docRow) return null;
  const paidTotal = pays.reduce((s, x) => s + x.amount, 0);
  const { p, c, u, pr, t } = ctx;
  return {
    kind: "receipt",
    documentId: docRow.id,
    filename: `${docRow.number}.pdf`,
    number: docRow.number,
    issuedOn: isoDay(docRow.createdAt),
    voided: p.status === "void",
    voidedOn: p.voidedAt ? isoDay(p.voidedAt) : null,
    voidReason: p.voidReason ?? "",
    amount: p.amount,
    amountWords: rupeesInWords(p.amount),
    tenantName: t.fullName,
    month: c.month,
    unitLabel: u.label,
    propertyName: pr.name,
    address: pr.address ?? "",
    paidOn: p.paidOn,
    method: p.method,
    utr: p.utr ?? "",
    note: p.note ?? "",
    chargeAmount: c.amount,
    extra: c.extra,
    paidTotal,
    balance: Math.max(0, c.amount - paidTotal),
    ownerName: owner?.fullName ?? "",
    ownerPhone: owner?.phone ?? "",
    ownerUpi: owner?.upiId ?? "",
  };
}

/** The receipt for a multi-month payment: one total, then what went to each month and what is left on it. */
async function batchReceiptData(
  ownerId: string,
  batchId: number,
  ctx: NonNullable<Awaited<ReturnType<typeof paymentContext>>>,
): Promise<ReceiptModel | null> {
  const [[b], [docRow], [owner]] = await db.batch([
    db
      .select()
      .from(paymentBatches)
      .where(and(eq(paymentBatches.id, batchId), eq(paymentBatches.ownerId, ownerId))),
    db.select().from(documents).where(eq(documents.batchId, batchId)),
    db.select().from(profiles).where(eq(profiles.id, ownerId)),
  ]);
  // Kept out of the batch: D1 batch results come back keyed by column name, so a join of two tables that share
  // column names (id, amount, status…) would overwrite one table's values with the other's.
  const parts = await db
    .select({ p: payments, c: charges })
    .from(payments)
    .innerJoin(charges, eq(payments.chargeId, charges.id))
    .where(eq(payments.batchId, batchId))
    .orderBy(charges.month);
  if (!b || !docRow || !parts.length) return null;
  const chargeIds = parts.map((x) => x.c.id);
  const confirmed = await db
    .select({ chargeId: payments.chargeId, amount: payments.amount })
    .from(payments)
    .where(and(inArray(payments.chargeId, chargeIds), eq(payments.status, "confirmed")));
  const paidOn = (id: number) => confirmed.filter((x) => x.chargeId === id).reduce((s, x) => s + x.amount, 0);
  const lines: ReceiptLine[] = parts.map(({ p, c }) => ({
    month: c.month,
    rent: c.amount - c.extra,
    extra: c.extra,
    chargeAmount: c.amount,
    applied: p.amount,
    balance: Math.max(0, c.amount - paidOn(c.id)),
  }));
  const { u, pr, t } = ctx;
  return {
    kind: "receipt",
    documentId: docRow.id,
    filename: `${docRow.number}.pdf`,
    number: docRow.number,
    issuedOn: isoDay(docRow.createdAt),
    voided: b.status === "void",
    voidedOn: b.voidedAt ? isoDay(b.voidedAt) : null,
    voidReason: b.voidReason ?? "",
    amount: b.amount,
    amountWords: rupeesInWords(b.amount),
    tenantName: t.fullName,
    month: lines[0].month,
    monthTo: lines[lines.length - 1].month,
    lines,
    unitLabel: u.label,
    propertyName: pr.name,
    address: pr.address ?? "",
    paidOn: b.paidOn,
    method: b.method,
    utr: b.utr ?? "",
    note: b.note ?? "",
    chargeAmount: lines.reduce((s, l) => s + l.chargeAmount, 0),
    extra: lines.reduce((s, l) => s + l.extra, 0),
    paidTotal: chargeIds.reduce((s, id) => s + paidOn(id), 0),
    balance: lines.reduce((s, l) => s + l.balance, 0),
    ownerName: owner?.fullName ?? "",
    ownerPhone: owner?.phone ?? "",
    ownerUpi: owner?.upiId ?? "",
  };
}

/** Everything the browser needs to draw a rental agreement (numbering it on first use). */
export async function agreementData(ownerId: string, tenancyId: number): Promise<AgreementModel | null> {
  const ctx = await tenancyContext(ownerId, tenancyId);
  if (!ctx) return null;
  const docRow = await ensureAgreement(ownerId, tenancyId);
  const [owner] = await db.select().from(profiles).where(eq(profiles.id, ownerId));
  const { tn, u, pr, t } = ctx;
  const end = tn.endDate ?? defaultLeaseEnd(tn.startDate);
  const months = Math.max(1, Math.round((Date.parse(end) - Date.parse(tn.startDate)) / (30.44 * 86400000)));
  const r = effectiveRates({ electricity: owner?.electricityRate ?? 0, water: owner?.waterRate ?? 0 }, pr);
  const place = pr.address ? pr.address.split(",").slice(-1)[0].replace(/\d+/g, "").trim() || pr.name : pr.name;
  return {
    kind: "agreement",
    filename: `Rental-agreement-${u.label.replace(/\W+/g, "-")}.pdf`,
    number: docRow.number,
    today: todayIST(),
    place,
    landlord: owner?.fullName || "the Landlord",
    ownerPhone: owner?.phone ?? "",
    ownerUpi: owner?.upiId ?? "",
    tenantName: t.fullName,
    tenantPhone: t.phone ?? "",
    tenantIdNote: t.idNote ?? "",
    unitLabel: u.label,
    unitType: u.type,
    propertyName: pr.name,
    address: pr.address ?? "",
    startDate: tn.startDate,
    endDate: end,
    months,
    rent: tn.rent,
    rentWords: rupeesInWords(tn.rent),
    dueDay: tn.dueDay,
    deposit: tn.deposit,
    depositWords: rupeesInWords(tn.deposit),
    electricityRate: r.electricity / 100,
    waterRate: r.water / 100,
  };
}
