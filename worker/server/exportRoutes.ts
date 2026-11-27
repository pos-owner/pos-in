import type { Hono } from "hono";
import { and, eq, inArray } from "drizzle-orm";
import {
  automations,
  chargeAdjustments,
  charges,
  db,
  documents,
  expenses,
  leaseTerms,
  maintenanceRequests,
  meterReadings,
  paymentBatches,
  payments,
  profiles,
  properties,
  recurringExpenses,
  requestComments,
  settlementDeductions,
  settlements,
  tenancies,
  tenants,
  units,
} from "../db/index.ts";
import { actorOf, roles, type Env } from "./core/auth.ts";
import { rateLimit } from "./core/rateLimit.ts";
import { todayIST } from "./core/util.ts";
import { logActivity } from "./domain/data.ts";

/*
 * Export and backup.
 *
 *   GET /api/backup.json   (owner) everything in the owner's workspace as one JSON document
 *
 * The phone turns the same document into the CSV exports (properties, tenants, leases, payments, expenses…), so the
 * Worker only reads rows and the free plan's CPU limit is never at risk. Every table is scoped to the owner through
 * `properties.owner_id` / `owner_id` subqueries (not id lists, which would hit D1's 100-parameter limit), and the
 * whole read is one `db.batch`, so it counts as a single query.
 *
 * Left out on purpose: sign-in data (accounts, sessions, password resets), invites (tokens and PIN hashes), push
 * subscriptions, rate limits, server secrets and each person's notification inbox. Photos stay in storage; the
 * backup keeps their keys.
 */

const BACKUP_VERSION = 1;

/** Reads the owner's whole workspace. Pure reads, one batch. */
async function buildBackup(ownerId: string) {
  const propIds = db.select({ id: properties.id }).from(properties).where(eq(properties.ownerId, ownerId));
  const unitIds = db.select({ id: units.id }).from(units).where(inArray(units.propertyId, propIds));
  const tenancyIds = db.select({ id: tenancies.id }).from(tenancies).where(inArray(tenancies.unitId, unitIds));
  const chargeIds = db.select({ id: charges.id }).from(charges).where(inArray(charges.tenancyId, tenancyIds));
  const requestIds = db
    .select({ id: maintenanceRequests.id })
    .from(maintenanceRequests)
    .where(inArray(maintenanceRequests.unitId, unitIds));
  const settlementIds = db.select({ id: settlements.id }).from(settlements).where(eq(settlements.ownerId, ownerId));
  const person = {
    id: profiles.id,
    role: profiles.role,
    fullName: profiles.fullName,
    email: profiles.email,
    phone: profiles.phone,
  };

  const [
    [owner],
    team,
    propertyRows,
    unitRows,
    tenantRows,
    tenancyRows,
    leaseTermRows,
    chargeRows,
    adjustmentRows,
    batchRows,
    paymentRows,
    expenseRows,
    recurringRows,
    requestRows,
    commentRows,
    readingRows,
    documentRows,
    settlementRows,
    deductionRows,
    automationRows,
  ] = await db.batch([
    db
      .select({
        ...person,
        upiId: profiles.upiId,
        pan: profiles.pan,
        electricityRate: profiles.electricityRate,
        waterRate: profiles.waterRate,
        locale: profiles.locale,
      })
      .from(profiles)
      .where(and(eq(profiles.id, ownerId), eq(profiles.role, "owner"))),
    db
      .select(person)
      .from(profiles)
      .where(and(eq(profiles.ownerId, ownerId), inArray(profiles.role, ["staff", "tenant"]))),
    db.select().from(properties).where(eq(properties.ownerId, ownerId)).orderBy(properties.id),
    db.select().from(units).where(inArray(units.propertyId, propIds)).orderBy(units.id),
    db.select().from(tenants).where(eq(tenants.ownerId, ownerId)).orderBy(tenants.id),
    db.select().from(tenancies).where(inArray(tenancies.unitId, unitIds)).orderBy(tenancies.id),
    db.select().from(leaseTerms).where(eq(leaseTerms.ownerId, ownerId)).orderBy(leaseTerms.id),
    db.select().from(charges).where(inArray(charges.tenancyId, tenancyIds)).orderBy(charges.id),
    db.select().from(chargeAdjustments).where(eq(chargeAdjustments.ownerId, ownerId)).orderBy(chargeAdjustments.id),
    db.select().from(paymentBatches).where(eq(paymentBatches.ownerId, ownerId)).orderBy(paymentBatches.id),
    db.select().from(payments).where(inArray(payments.chargeId, chargeIds)).orderBy(payments.id),
    db.select().from(expenses).where(inArray(expenses.propertyId, propIds)).orderBy(expenses.id),
    db.select().from(recurringExpenses).where(eq(recurringExpenses.ownerId, ownerId)).orderBy(recurringExpenses.id),
    db
      .select()
      .from(maintenanceRequests)
      .where(inArray(maintenanceRequests.unitId, unitIds))
      .orderBy(maintenanceRequests.id),
    db.select().from(requestComments).where(inArray(requestComments.requestId, requestIds)).orderBy(requestComments.id),
    db.select().from(meterReadings).where(inArray(meterReadings.unitId, unitIds)).orderBy(meterReadings.id),
    db.select().from(documents).where(eq(documents.ownerId, ownerId)).orderBy(documents.id),
    db.select().from(settlements).where(eq(settlements.ownerId, ownerId)).orderBy(settlements.id),
    db
      .select()
      .from(settlementDeductions)
      .where(inArray(settlementDeductions.settlementId, settlementIds))
      .orderBy(settlementDeductions.id),
    db.select().from(automations).where(eq(automations.ownerId, ownerId)).orderBy(automations.id),
  ]);

  return {
    app: "pOS",
    version: BACKUP_VERSION,
    exportedAt: new Date().toISOString(),
    exportedOn: todayIST(),
    owner: owner ?? null,
    team,
    properties: propertyRows,
    units: unitRows,
    tenants: tenantRows,
    tenancies: tenancyRows,
    leaseTerms: leaseTermRows,
    charges: chargeRows,
    chargeAdjustments: adjustmentRows,
    paymentBatches: batchRows,
    payments: paymentRows,
    expenses: expenseRows,
    recurringExpenses: recurringRows,
    maintenanceRequests: requestRows,
    requestComments: commentRows,
    meterReadings: readingRows,
    documents: documentRows,
    settlements: settlementRows,
    settlementDeductions: deductionRows,
    automations: automationRows,
  };
}

export function registerExportRoutes(api: Hono<Env>) {
  api.get("/backup.json", roles("owner"), async (c) => {
    const a = actorOf(c);
    try {
      if (!(await rateLimit(`backup:${a.id}`, 30, 60 * 60_000)))
        return c.json({ error: "That's a lot of backups in an hour. Try again in a while." }, 429);
    } catch (e) {
      console.error("backup rate limit unavailable", e);
    }
    const backup = await buildBackup(a.ownerId);
    await logActivity(a.id, "export", "backup");
    return c.json(backup, 200, { "cache-control": "private, no-store" });
  });
}
