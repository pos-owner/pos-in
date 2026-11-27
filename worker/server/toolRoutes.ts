import type { Context, Hono } from "hono";
import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import { env } from "./core/bindings.ts";
import { db, documents, meterReadings, charges, profiles, properties, tenancies } from "../db/index.ts";
import { actorOf, roles, type Env } from "./core/auth.ts";
import type { Actor } from "./core/access.ts";
import { activeTenancyByUnit, ensureCharges, loadWorkspace, logActivity } from "./domain/data.ts";
import { body, signKeys, validPhotoKey } from "./core/http.ts";
import { getPhoto } from "./core/storage.ts";
import {
  agreementData,
  ensureAgreement,
  ensureReceipt,
  listReceipts,
  paymentContext,
  receiptData,
} from "./pdf/documents.ts";
import type { ReportModel } from "../../shared/pdf/models.ts";
import {
  applyBillToRent,
  billFor,
  effectiveRates,
  lastReading,
  meterAiEnabled,
  rates,
  readMeterPhoto,
  recentUsage,
  removeBillFromRent,
  unusualUsage,
  type MeterKind,
} from "./domain/meters.ts";
import { buildReport } from "./domain/reports.ts";
import { FLOWS, flow, loadFlows, logRun, recentRuns, saveFlow, type FlowKey } from "./domain/automations.ts";
import { cleanDate, cleanInt, oneOf, safeEqual, todayIST } from "./core/util.ts";
import { rateLimit } from "./core/rateLimit.ts";
import { isClientKeyConflict, KEY_TAKEN, offlineKey } from "./core/idempotency.ts";
import { meterUsage } from "./domain/billing.ts";
import { ownerIds, reminderQueue, runDailyCycle, runDailyForOwner } from "./domain/daily.ts";

/*
 * Printable documents: the routes below return each document's data as JSON (`…/receipt.json`, `…/agreement.json`,
 * `/reports/print.json`) and the browser draws the PDF (shared/pdf/, src/lib/pdf.ts). Drawing PDFs takes far more
 * CPU time than the free plan's 10 ms per request allows, and phones do it in a fraction of a second.
 */
const doc = (c: Context, data: unknown) => c.json(data, 200, { "cache-control": "private, no-store" });

/** Tenant may read a payment's receipt only if the payment is on their own tenancy and a receipt was issued. */
async function tenantOwnsPayment(a: Actor, paymentId: number) {
  const ctx = await paymentContext(a.ownerId, paymentId);
  return !!ctx && a.tenantIds.includes(ctx.tn.tenantId);
}

/* ---------- manual daily run ---------- */

/** `POST /api/cron/daily` runs the cycle by hand. It needs the `CRON_SECRET` Worker secret in `x-cron-secret`. */
export async function cronDaily(c: Context<Env>) {
  const given = c.req.header("x-cron-secret") ?? "";
  const expected = env("CRON_SECRET");
  if (!given || !expected || !(await safeEqual(given, expected))) return c.json({ error: "Forbidden" }, 403);
  // ?owner=<id> re-runs one workspace; with no parameter every workspace runs in this one request.
  const owner = c.req.query("owner");
  if (owner) {
    if (!(await ownerIds()).includes(owner)) return c.json({ error: "Unknown workspace" }, 404);
    return c.json({ ok: true, ...(await runDailyForOwner(owner)) });
  }
  return c.json(await runDailyCycle());
}

/* ---------- routes ---------- */

export function registerToolRoutes(api: Hono<Env>) {
  /* Receipts and agreements */

  api.get("/receipts", roles("owner", "tenant"), async (c) => {
    const a = actorOf(c);
    if (a.role === "owner") return c.json(await listReceipts(a.ownerId));
    const ws = await loadWorkspace(a.ownerId);
    const mine = ws.tenancyRows.filter((t) => a.tenantIds.includes(t.tenantId)).map((t) => t.id);
    return c.json(await listReceipts(a.ownerId, mine));
  });

  api.post("/payments/:id/receipt", roles("owner"), async (c) => {
    const a = actorOf(c);
    const r = await ensureReceipt(a.ownerId, Number(c.req.param("id")));
    if (!r) return c.json({ error: "Receipts are issued for confirmed payments only." }, 400);
    if (r.created) await logActivity(a.id, "issue", "receipt", r.doc.id);
    return c.json({ id: r.doc.id, number: r.doc.number, created: r.created });
  });

  api.get("/payments/:id/receipt.json", roles("owner", "tenant"), async (c) => {
    const a = actorOf(c);
    const id = Number(c.req.param("id"));
    if (a.role === "tenant" && !(await tenantOwnsPayment(a, id))) return c.json({ error: "Receipt not found." }, 404);
    const data = await receiptData(a.ownerId, id, new URL(c.req.url).origin);
    if (!data) return c.json({ error: "No receipt has been issued for this payment yet." }, 404);
    return doc(c, data);
  });

  api.get("/agreements", roles("owner"), async (c) => {
    const a = actorOf(c);
    const ws = await loadWorkspace(a.ownerId);
    const ids = ws.tenancyRows.map((t) => t.id);
    const docs = ids.length
      ? await db
          .select()
          .from(documents)
          .where(
            and(eq(documents.ownerId, a.ownerId), eq(documents.kind, "agreement"), inArray(documents.tenancyId, ids)),
          )
      : [];
    const unitById = new Map(ws.unitRows.map((u) => [u.id, u]));
    const propById = new Map(ws.props.map((p) => [p.id, p]));
    const tenantById = new Map(ws.tenantRows.map((t) => [t.id, t]));
    return c.json(
      ws.tenancyRows
        .filter((t) => t.status === "active")
        .map((t) => {
          const u = unitById.get(t.unitId)!;
          const d = docs.find((x) => x.tenancyId === t.id);
          return {
            tenancyId: t.id,
            tenantId: t.tenantId,
            tenantName: tenantById.get(t.tenantId)?.fullName ?? "",
            tenantPhone: tenantById.get(t.tenantId)?.phone ?? "",
            unitLabel: u.label,
            propertyName: propById.get(u.propertyId)?.name ?? "",
            rent: t.rent,
            startDate: t.startDate,
            endDate: t.endDate,
            document: d ? { id: d.id, number: d.number, createdAt: d.createdAt } : null,
          };
        }),
    );
  });

  api.post("/tenancies/:id/agreement", roles("owner"), async (c) => {
    const a = actorOf(c);
    const id = Number(c.req.param("id"));
    const ws = await loadWorkspace(a.ownerId);
    if (!ws.tenancyRows.some((t) => t.id === id)) return c.json({ error: "Tenancy not found." }, 404);
    const d = await ensureAgreement(a.ownerId, id);
    await logActivity(a.id, "issue", "agreement", d.id);
    return c.json({ id: d.id, number: d.number });
  });

  api.get("/tenancies/:id/agreement.json", roles("owner", "tenant"), async (c) => {
    const a = actorOf(c);
    const id = Number(c.req.param("id"));
    const ws = await loadWorkspace(a.ownerId);
    const tn = ws.tenancyRows.find((t) => t.id === id);
    if (!tn || (a.role === "tenant" && !a.tenantIds.includes(tn.tenantId)))
      return c.json({ error: "Agreement not found." }, 404);
    if (a.role === "tenant") {
      const [d] = await db
        .select()
        .from(documents)
        .where(and(eq(documents.tenancyId, id), eq(documents.kind, "agreement")));
      if (!d) return c.json({ error: "Your owner hasn't shared an agreement yet." }, 404);
    }
    const data = await agreementData(a.ownerId, id);
    if (!data) return c.json({ error: "Agreement not found." }, 404);
    return doc(c, data);
  });

  api.get("/tenant/documents", roles("tenant"), async (c) => {
    const a = actorOf(c);
    const ws = await loadWorkspace(a.ownerId);
    const mine = ws.tenancyRows.filter((t) => a.tenantIds.includes(t.tenantId)).map((t) => t.id);
    const receipts = await listReceipts(a.ownerId, mine);
    const agreements = mine.length
      ? await db
          .select()
          .from(documents)
          .where(and(eq(documents.kind, "agreement"), inArray(documents.tenancyId, mine)))
      : [];
    return c.json({
      receipts,
      agreements: agreements.map((d) => ({
        id: d.id,
        number: d.number,
        tenancyId: d.tenancyId,
        createdAt: d.createdAt,
      })),
    });
  });

  /* Meter readings */

  api.get("/meters", roles("owner", "staff"), async (c) => {
    const a = actorOf(c);
    const ws = await loadWorkspace(a.ownerId);
    await ensureCharges(a.ownerId, ws);
    const unitIds = ws.unitRows.map((u) => u.id);
    const rows = unitIds.length
      ? await db
          .select()
          .from(meterReadings)
          .where(inArray(meterReadings.unitId, unitIds))
          .orderBy(desc(meterReadings.readOn), desc(meterReadings.id))
          .limit(200)
      : [];
    const active = activeTenancyByUnit(ws);
    const tenantById = new Map(ws.tenantRows.map((t) => [t.id, t]));
    const photos = await signKeys(rows.map((r) => r.photoPath));
    let pi = 0;
    const readings = rows.map((r) => {
      const u = ws.unitRows.find((x) => x.id === r.unitId)!;
      return {
        id: r.id,
        unitId: r.unitId,
        unitLabel: u?.label ?? "",
        kind: r.kind,
        reading: r.reading,
        previous: r.previous,
        usage: r.usage,
        rate: r.rate,
        amount: r.amount,
        confidence: r.confidence,
        readOn: r.readOn,
        applied: !!r.chargeId,
        status: r.status === "pending" ? "pending" : "approved",
        flag: r.flag,
        recordedByName: r.recordedByName,
        photo: r.photoPath ? photos[pi++] : null,
      };
    });
    const defaults = await rates(a.ownerId);
    return c.json({
      rates: defaults,
      // Each property's effective rates; `custom` marks rates set on the property instead of the default.
      properties: ws.props.map((p) => ({
        id: p.id,
        name: p.name,
        ...effectiveRates(defaults, p),
        custom: { electricity: p.electricityRate !== null, water: p.waterRate !== null },
      })),
      autoBill: (await flow(a.ownerId, "meter_to_bill")).enabled,
      pendingCount: readings.filter((r) => r.status === "pending").length,
      units: ws.unitRows.map((u) => {
        const tn = active.get(u.id);
        const last = (kind: string) => readings.find((r) => r.unitId === u.id && r.kind === kind) ?? null;
        return {
          id: u.id,
          label: u.label,
          propertyId: u.propertyId,
          propertyName: ws.props.find((p) => p.id === u.propertyId)?.name ?? "",
          tenantName: tn ? (tenantById.get(tn.tenantId)?.fullName ?? "") : "",
          occupied: !!tn,
          last: { electricity: last("electricity"), water: last("water") },
        };
      }),
      readings,
    });
  });

  api.post("/meters/scan", roles("owner", "staff"), async (c) => {
    const a = actorOf(c);
    const b = await body(c);
    const kind = oneOf(b.kind, ["electricity", "water"] as const) ?? "electricity";
    if (!(await validPhotoKey(a, b.photoKey)) || typeof b.photoKey !== "string")
      return c.json({ error: "Take a photo of the meter first." }, 400);
    if (!meterAiEnabled())
      return c.json({
        reading: null,
        confidence: 0,
        note: "Photo reading isn't switched on yet. Type the number from the meter.",
      });
    try {
      if (!(await rateLimit(`meter-scan:${a.ownerId}`, 60, 24 * 60 * 60_000)))
        return c.json({ error: "That's a lot of scans today. Type the reading instead." }, 429);
    } catch (e) {
      console.error("meter scan rate limit unavailable", e);
      return c.json({ error: "Meter scans are temporarily unavailable." }, 503);
    }
    const bytes = await getPhoto(b.photoKey);
    if (!bytes) return c.json({ error: "That photo is no longer available. Take it again." }, 404);
    const mime = b.photoKey.endsWith(".png") ? "image/png" : b.photoKey.endsWith(".webp") ? "image/webp" : "image/jpeg";
    try {
      return c.json(await readMeterPhoto(bytes, mime, kind));
    } catch (e) {
      console.error("meter scan failed", e);
      return c.json({
        reading: null,
        confidence: 0,
        note: "Couldn't read the photo right now. Type the number from the meter.",
      });
    }
  });

  api.post("/meters", roles("owner", "staff"), async (c) => {
    const a = actorOf(c);
    const b = await body(c);
    const ws = await loadWorkspace(a.ownerId);
    const unit = ws.unitRows.find((u) => u.id === Number(b.unitId));
    if (!unit) return c.json({ error: "Choose a unit." }, 400);
    const kind = (oneOf(b.kind, ["electricity", "water"] as const) ?? "electricity") as MeterKind;
    // A retry from the offline outbox returns the reading it already saved (before any check, since the saved
    // reading is now the latest one and would otherwise be compared with itself).
    const clientKey = offlineKey(b.clientKey);
    const replayed = async () => {
      if (!clientKey) return null;
      const [old] = await db.select().from(meterReadings).where(eq(meterReadings.clientKey, clientKey));
      if (!old) return null;
      if (old.recordedBy !== a.id || !ws.unitRows.some((u) => u.id === old.unitId))
        return c.json({ error: KEY_TAKEN }, 409);
      return c.json({
        id: old.id,
        usage: old.usage,
        amount: old.amount,
        applied: old.chargeId !== null,
        pending: old.status === "pending",
        flag: old.flag,
        firstReading: old.previous === null,
        replayed: true,
      });
    };
    const again = await replayed();
    if (again) return again;
    const reading = typeof b.reading === "number" ? b.reading : Number(String(b.reading ?? "").replace(/[,\s]/g, ""));
    if (!Number.isFinite(reading) || reading < 0 || reading > 1e9)
      return c.json({ error: "Enter the number shown on the meter." }, 400);
    const readOn = cleanDate(b.readOn) ?? todayIST();
    const prev = await lastReading(unit.id, kind);
    const previous = prev?.reading ?? null;
    if (previous !== null && reading < previous && b.reset !== true) {
      return c.json(
        {
          error: `That's lower than the last reading (${previous}). Check the number, or mark it as a new meter.`,
          code: "lower",
        },
        400,
      );
    }
    const usage = meterUsage(reading, previous, b.reset === true) ?? 0;
    const r = effectiveRates(
      await rates(a.ownerId),
      ws.props.find((p) => p.id === unit.propertyId),
    );
    const rate = kind === "water" ? r.water : r.electricity;
    const amount = billFor(usage, rate);

    // Sanity check on every reading: unusually high usage must be confirmed before it is saved.
    const flag = usage > 0 ? unusualUsage(usage, await recentUsage(unit.id, kind), kind) : null;
    if (flag && b.confirmUnusual !== true) {
      return c.json(
        { error: `${flag} Check the number on the meter, then confirm to save it.`, code: "unusual", usage, amount },
        409,
      );
    }

    const photoPath = (await validPhotoKey(a, b.photoKey)) ? (b.photoKey as string) : null;
    const confidence = typeof b.confidence === "number" ? Math.min(1, Math.max(0, b.confidence)) : null;
    // Staff readings never change a charge: they wait for the owner, who approves them with /meters/:id/apply.
    const pending = a.role !== "owner";
    let row: typeof meterReadings.$inferSelect;
    try {
      [row] = await db
        .insert(meterReadings)
        .values({
          unitId: unit.id,
          kind,
          reading,
          previous,
          usage,
          rate,
          amount,
          confidence,
          photoPath,
          readOn,
          recordedBy: a.id,
          recordedByName: a.name,
          status: pending ? "pending" : "approved",
          flag: flag ?? "",
          approvedBy: pending ? null : a.id,
          approvedAt: pending ? null : new Date(),
          clientKey,
        })
        .returning();
    } catch (e) {
      // Two retries of the same entry at once: the other one saved it.
      if (isClientKeyConflict(e)) return (await replayed()) ?? c.json({ error: KEY_TAKEN }, 409);
      throw e;
    }
    await logActivity(a.id, "create", "meter_reading", row.id);

    let applied = false;
    if (!pending) {
      // The owner chooses per reading; the "meter → bill" automation sets the default.
      const auto = (await flow(a.ownerId, "meter_to_bill")).enabled;
      const wantBill = typeof b.addToRent === "boolean" ? b.addToRent : auto;
      const tn = activeTenancyByUnit(ws).get(unit.id);
      if (wantBill && amount > 0 && tn) {
        await ensureCharges(a.ownerId, ws, true);
        // One transaction: the bill, the charge amount and its status (see applyBillToRent).
        const ch = await applyBillToRent(row.id, tn.id);
        if (ch) {
          applied = true;
          if (auto) await logRun(a.ownerId, "bill", "meter_reading", row.id);
        }
      }
    }
    return c.json({ id: row.id, usage, amount, applied, pending, flag: flag ?? "", firstReading: previous === null });
  });

  /** Owner approves a reading (staff readings arrive pending) and adds its bill to the rent when there is one. */
  api.post("/meters/:id/apply", roles("owner"), async (c) => {
    const a = actorOf(c);
    const ws = await loadWorkspace(a.ownerId);
    const [r] = await db
      .select()
      .from(meterReadings)
      .where(eq(meterReadings.id, Number(c.req.param("id"))));
    if (!r || !ws.unitRows.some((u) => u.id === r.unitId)) return c.json({ error: "Reading not found." }, 404);
    const tn = activeTenancyByUnit(ws).get(r.unitId!);
    if (r.status !== "pending" && !(r.amount > 0 && !r.chargeId))
      return c.json({ error: "Nothing to add. It may already be on the rent." }, 409);
    if (r.status !== "pending" && !tn) return c.json({ error: "This unit has no tenant to bill." }, 400);
    if (r.amount > 0 && !r.chargeId && tn) await ensureCharges(a.ownerId, ws, true);
    // Both are decided again on a fresh read, because a second tap (or a delete) may have changed the reading.
    // Applying the bill is itself a single guarded statement (see applyBillToRent), so it can't happen twice.
    const res = await (async (): Promise<
      { error: string; status: 400 | 404 | 409 } | { applied: boolean; approved: boolean }
    > => {
      const [live] = await db.select().from(meterReadings).where(eq(meterReadings.id, r.id));
      if (!live) return { error: "Reading not found.", status: 404 };
      const wasPending = live.status === "pending";
      const billable = live.amount > 0 && !live.chargeId;
      if (!wasPending && !billable) return { error: "Nothing to add. It may already be on the rent.", status: 409 };
      if (!wasPending && !tn) return { error: "This unit has no tenant to bill.", status: 400 };
      let applied = false;
      if (billable && tn) {
        if (await applyBillToRent(live.id, tn.id)) applied = true;
        else if (!wasPending) return { error: "Nothing to add. It may already be on the rent.", status: 409 };
      }
      let approved = false;
      if (wasPending) {
        const done = await db
          .update(meterReadings)
          .set({ status: "approved", approvedBy: a.id, approvedAt: new Date() })
          .where(and(eq(meterReadings.id, live.id), eq(meterReadings.status, "pending")))
          .returning({ id: meterReadings.id });
        approved = done.length > 0;
      }
      return { applied, approved };
    })();
    if ("error" in res) return c.json({ error: res.error }, res.status);
    if (res.approved) await logActivity(a.id, "approve", "meter_reading", r.id);
    return c.json({ ok: true, applied: res.applied, approved: res.approved });
  });

  api.delete("/meters/:id", roles("owner"), async (c) => {
    const a = actorOf(c);
    const ws = await loadWorkspace(a.ownerId);
    const [r] = await db
      .select()
      .from(meterReadings)
      .where(eq(meterReadings.id, Number(c.req.param("id"))));
    if (!r || !ws.unitRows.some((u) => u.id === r.unitId)) return c.json({ error: "Reading not found." }, 404);
    // The bill comes off the rent first (refused when that would leave the rent overpaid). The delete only removes
    // a reading with no bill still linked, so a bill added in between is never deleted with its reading.
    const refused = await (async (): Promise<{ error: string; status: 404 | 409 } | null> => {
      if ((await removeBillFromRent(r.id)) === "overpaid") {
        return {
          error:
            "This rent has already been paid, and removing the bill would leave it overpaid. Void the payment first.",
          status: 409,
        };
      }
      const gone = await db
        .delete(meterReadings)
        .where(and(eq(meterReadings.id, r.id), isNull(meterReadings.chargeId)))
        .returning({ id: meterReadings.id, photo: meterReadings.photoPath });
      return gone.length ? null : { error: "Reading not found.", status: 404 };
    })();
    if (refused) return c.json({ error: refused.error }, refused.status);
    await logActivity(a.id, "delete", "meter_reading", r.id);
    return c.json({ ok: true });
  });

  api.patch("/meters/rates", roles("owner"), async (c) => {
    const a = actorOf(c);
    const b = await body(c);
    const toPaise = (v: unknown) => {
      const n = typeof v === "number" ? v : Number(String(v ?? "").trim());
      return Number.isFinite(n) && n >= 0 && n <= 1000 ? Math.round(n * 100) : null;
    };
    // With a propertyId, `null` (or a missing value) means "use the default rate" for that utility.
    if (b.propertyId !== undefined && b.propertyId !== null) {
      const ws = await loadWorkspace(a.ownerId);
      const prop = ws.props.find((p) => p.id === Number(b.propertyId));
      if (!prop) return c.json({ error: "Property not found." }, 404);
      const e = b.electricity == null || b.electricity === "" ? null : toPaise(b.electricity);
      const w = b.water == null || b.water === "" ? null : toPaise(b.water);
      if (
        (b.electricity != null && b.electricity !== "" && e === null) ||
        (b.water != null && b.water !== "" && w === null)
      ) {
        return c.json({ error: "Enter rates in rupees per unit, like 8 or 7.5." }, 400);
      }
      await db.update(properties).set({ electricityRate: e, waterRate: w }).where(eq(properties.id, prop.id));
      await logActivity(a.id, "update", "property_rates", prop.id);
      return c.json({ ok: true });
    }
    const e = toPaise(b.electricity),
      w = toPaise(b.water);
    if (e === null || w === null) return c.json({ error: "Enter rates in rupees per unit, like 8 or 7.5." }, 400);
    await db.update(profiles).set({ electricityRate: e, waterRate: w }).where(eq(profiles.id, a.ownerId));
    return c.json({ ok: true });
  });

  /* Reports */

  /** `?fy=2026` reports one financial year (Apr 2026 – Mar 2027); otherwise `?span=` months back from now. */
  const reportArgs = (c: Context<Env>) => {
    const fy = cleanInt(c.req.query("fy"), 2000, 2100);
    const span = cleanInt(c.req.query("span"), 3, 24) ?? 6;
    const pid = Number(c.req.query("propertyId")) || undefined;
    return { win: fy !== null ? { fy } : { span }, pid };
  };

  api.get("/reports", roles("owner"), async (c) => {
    const a = actorOf(c);
    const { win, pid } = reportArgs(c);
    return c.json(await buildReport(a.ownerId, win, pid));
  });

  /** The report plus what its printed header needs; the browser draws the PDF. */
  api.get("/reports/print.json", roles("owner"), async (c) => {
    const a = actorOf(c);
    const { win, pid } = reportArgs(c);
    const [r, [owner]] = await Promise.all([
      buildReport(a.ownerId, win, pid),
      db.select({ fullName: profiles.fullName }).from(profiles).where(eq(profiles.id, a.ownerId)),
    ]);
    const scope = pid ? (r.properties.find((p) => p.id === pid)?.name ?? "One property") : "All properties";
    const slug = r.fy !== null ? r.label.replace(/\W+/g, "-").replace(/-+$/, "") : `${r.from}-to-${r.to}`;
    const model: ReportModel = {
      kind: "report",
      filename: `pOS-report-${slug}.pdf`,
      ownerName: owner?.fullName ?? "",
      scope,
      report: r,
    };
    return doc(c, model);
  });

  /* Automations and reminders */

  api.get("/automations", roles("owner"), async (c) => {
    const a = actorOf(c);
    const [flows, runs, queue] = await Promise.all([
      loadFlows(a.ownerId),
      recentRuns(a.ownerId),
      reminderQueue(a.ownerId),
    ]);
    return c.json({
      flows,
      queued: queue.items.length,
      runs: runs.map((r) => ({
        id: r.id,
        action: r.action.replace(/^auto_/, ""),
        entity: r.entity,
        entityId: r.entityId,
        createdAt: r.createdAt,
      })),
    });
  });

  api.patch("/automations/:key", roles("owner"), async (c) => {
    const a = actorOf(c);
    const key = c.req.param("key") as FlowKey;
    if (!Object.hasOwn(FLOWS, key)) return c.json({ error: "Unknown automation." }, 404);
    const b = await body(c);
    const cur = await flow(a.ownerId, key);
    const config: Record<string, number> = { ...cur.config };
    if (key === "rent_reminders") {
      const before = cleanInt((b.config as Record<string, unknown> | undefined)?.daysBefore, 0, 10);
      const every = cleanInt((b.config as Record<string, unknown> | undefined)?.repeatEvery, 1, 14);
      if (before !== null) config.daysBefore = before;
      if (every !== null) config.repeatEvery = every;
    }
    const given = (b.config && typeof b.config === "object" ? b.config : {}) as Record<string, unknown>;
    if (key === "advance_rent") {
      const ahead = cleanInt(given.maxMonthsAhead, 1, 24);
      if (ahead !== null) config.maxMonthsAhead = ahead;
    }
    if (key === "lease_alerts") {
      for (const k of ["first", "second", "last"] as const) {
        const v = cleanInt(given[k], 1, 180);
        if (v !== null) config[k] = v;
      }
    }
    if (key === "prorate") {
      const m = cleanInt(given.method, 0, 1);
      if (m !== null) config.method = m;
    }
    if (key === "late_fees") {
      const mode = cleanInt(given.mode, 0, 2);
      if (mode !== null) config.mode = mode;
      const grace = cleanInt(given.graceDays, 0, 60);
      if (grace !== null) config.graceDays = grace;
      const amount = cleanInt(given.amount, 0, config.mode === 1 ? 100 : 100_000);
      if (amount !== null) config.amount = amount;
      else if (config.mode === 1 && config.amount > 100) config.amount = 2; // switched to percent from a big flat fee
      const cap = cleanInt(given.cap, 0, 1_000_000);
      if (cap !== null) config.cap = cap;
    }
    const enabled = typeof b.enabled === "boolean" ? b.enabled : cur.enabled;
    await saveFlow(a.ownerId, key, enabled, config);
    await logActivity(a.id, enabled ? "enable" : "disable", "automation", key);
    return c.json({ ok: true });
  });

  api.get("/reminders", roles("owner"), async (c) => {
    const a = actorOf(c);
    return c.json(await reminderQueue(a.ownerId));
  });

  api.post("/charges/:id/reminded", roles("owner"), async (c) => {
    const a = actorOf(c);
    const id = Number(c.req.param("id"));
    const [row] = await db
      .select({ id: charges.id, tenancyId: charges.tenancyId })
      .from(charges)
      .innerJoin(tenancies, eq(charges.tenancyId, tenancies.id))
      .where(eq(charges.id, id));
    const ws = await loadWorkspace(a.ownerId);
    if (!row || !ws.tenancyRows.some((t) => t.id === row.tenancyId)) return c.json({ error: "Charge not found." }, 404);
    await logActivity(a.id, "remind", "charge", id);
    return c.json({ ok: true });
  });
}
