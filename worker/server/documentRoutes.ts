import type { Hono } from "hono";
import { and, desc, eq, inArray, or } from "drizzle-orm";
import { db, documents, maintenanceRequests, meterReadings, profiles, tenants } from "../db/index.ts";
import { actorOf, roles, type Env } from "./core/auth.ts";
import type { Actor } from "./core/access.ts";
import { body } from "./core/http.ts";
import { readCode, signedCode } from "./core/codes.ts";
import { rateLimit } from "./core/rateLimit.ts";
import { cleanStr, todayIST } from "./core/util.ts";
import { activeTenancyByUnit, ensureCharges, loadLedger, loadWorkspace, ownerProfile } from "./domain/data.ts";
import { buildStatement, fysOf, periodRange, type StatementPeriod } from "./domain/statements.ts";
import { receiptData } from "./pdf/documents.ts";

/*
 * PAN, rent statements, unit QR codes and receipt verification.
 *
 *   GET   /api/pan                          your PAN (owner: their own; tenant: the PAN on their tenant record)
 *   PATCH /api/pan                          { pan } sets or clears it (AAAAA9999A)
 *   GET   /api/statements                   tenancies a rent statement can be made for, and the financial years
 *   GET   /api/tenancies/:id/statement.json ?period=month|year|fy&value=YYYY-MM|YYYY  the statement's data (PDF in the browser)
 *   GET   /api/qr                           one signed code per unit (owner), for printing
 *   GET   /api/u/:code                      what scanning a unit's code opens, for the person who scanned it
 *   GET   /api/verify/:code                 (signed out) checks a receipt from the QR code printed on it
 *
 * Codes are HMAC-signed (core/codes.ts), so they can't be guessed or walked from one unit or receipt to the next.
 */

const PAN_RE = /^[A-Z]{5}[0-9]{4}[A-Z]$/;

/** Upper-cases and strips spaces. Returns "" to clear, the PAN when valid, or null when it isn't a PAN. */
function cleanPan(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const s = v.replace(/\s+/g, "").toUpperCase();
  if (!s) return "";
  return PAN_RE.test(s) ? s : null;
}

/** The actor's tenancies a statement can be made for: every one in the workspace for the owner, their own for a tenant. */
function statementTenancies(ws: Awaited<ReturnType<typeof loadWorkspace>>, a: Actor) {
  return a.role === "owner" ? ws.tenancyRows : ws.tenancyRows.filter((t) => a.tenantIds.includes(t.tenantId));
}

export function registerDocumentRoutes(api: Hono<Env>) {
  /* ---------- PAN ---------- */

  api.get("/pan", roles("owner", "tenant"), async (c) => {
    const a = actorOf(c);
    if (a.role === "owner") {
      const p = await ownerProfile(a.id);
      return c.json({ pan: p?.pan ?? "", role: "owner" });
    }
    const [t] = a.tenantIds.length
      ? await db.select({ pan: tenants.pan }).from(tenants).where(inArray(tenants.id, a.tenantIds)).limit(1)
      : [];
    return c.json({ pan: t?.pan ?? "", role: "tenant" });
  });

  api.patch("/pan", roles("owner", "tenant"), async (c) => {
    const a = actorOf(c);
    const b = await body(c);
    const pan = cleanPan(b.pan);
    if (pan === null) return c.json({ error: "Enter a valid PAN, like ABCDE1234F." }, 400);
    if (a.role === "owner") await db.update(profiles).set({ pan }).where(eq(profiles.id, a.id));
    else if (a.tenantIds.length)
      await db
        .update(tenants)
        .set({ pan })
        .where(and(inArray(tenants.id, a.tenantIds), eq(tenants.ownerId, a.ownerId)));
    else return c.json({ error: "No tenant record is linked to your account." }, 409);
    return c.json({ ok: true, pan });
  });

  /* ---------- rent statements ---------- */

  api.get("/statements", roles("owner", "tenant"), async (c) => {
    const a = actorOf(c);
    const ws = await loadWorkspace(a.ownerId);
    await ensureCharges(a.ownerId, ws);
    const mine = statementTenancies(ws, a);
    const ledger = await loadLedger(ws, { tenancyIds: mine.map((t) => t.id) });
    const unitById = new Map(ws.unitRows.map((u) => [u.id, u]));
    const propById = new Map(ws.props.map((p) => [p.id, p]));
    const tenantById = new Map(ws.tenantRows.map((t) => [t.id, t]));
    return c.json({
      tenancies: mine
        .map((t) => {
          const u = unitById.get(t.unitId);
          const months = ledger
            .filter((r) => r.tenancyId === t.id)
            .map((r) => r.month)
            .sort();
          return {
            tenancyId: t.id,
            tenantId: t.tenantId,
            tenantName: tenantById.get(t.tenantId)?.fullName ?? "",
            unitLabel: u?.label ?? "",
            propertyName: u ? (propById.get(u.propertyId)?.name ?? "") : "",
            startDate: t.startDate,
            status: t.status,
            firstMonth: months[0] ?? null,
            lastMonth: months[months.length - 1] ?? null,
          };
        })
        .sort((x, y) =>
          x.status === y.status ? x.tenantName.localeCompare(y.tenantName) : x.status === "active" ? -1 : 1,
        ),
      fys: fysOf(ledger.map((r) => r.month)),
      today: todayIST(),
    });
  });

  api.get("/tenancies/:id/statement.json", roles("owner", "tenant"), async (c) => {
    const a = actorOf(c);
    const ws = await loadWorkspace(a.ownerId);
    const tn = statementTenancies(ws, a).find((t) => t.id === Number(c.req.param("id")));
    if (!tn) return c.json({ error: "Tenancy not found." }, 404);
    const period = (["month", "year", "fy"] as const).find((p) => p === c.req.query("period")) as
      StatementPeriod | undefined;
    const range = period ? periodRange(period, c.req.query("value") ?? "") : null;
    if (!period || !range) return c.json({ error: "Choose a month, a year or a financial year." }, 400);
    await ensureCharges(a.ownerId, ws);
    const rows = await loadLedger(ws, { tenancyIds: [tn.id] });
    if (!rows.some((r) => r.month >= range.from && r.month <= range.to))
      return c.json({ error: `There's no rent on record for ${range.label}.` }, 404);
    const owner = await ownerProfile(a.ownerId);
    const model = await buildStatement(
      ws,
      tn,
      rows,
      period,
      range,
      { ownerName: owner?.fullName ?? "", ownerPhone: owner?.phone ?? "", ownerPan: owner?.pan ?? "" },
      todayIST(),
    );
    return c.json(model, 200, { "cache-control": "private, no-store" });
  });

  /* ---------- unit QR codes ---------- */

  api.get("/qr", roles("owner"), async (c) => {
    const a = actorOf(c);
    const ws = await loadWorkspace(a.ownerId);
    const active = activeTenancyByUnit(ws);
    const tenantById = new Map(ws.tenantRows.map((t) => [t.id, t]));
    const propById = new Map(ws.props.map((p) => [p.id, p]));
    const units = await Promise.all(
      ws.unitRows.map(async (u) => {
        const tn = active.get(u.id);
        return {
          unitId: u.id,
          label: u.label,
          propertyName: propById.get(u.propertyId)?.name ?? "",
          tenantName: tn ? (tenantById.get(tn.tenantId)?.fullName ?? "") : "",
          code: await signedCode("unit", u.id),
        };
      }),
    );
    return c.json({ units });
  });

  api.get("/u/:code", roles("owner", "staff", "tenant"), async (c) => {
    const a = actorOf(c);
    const id = await readCode("unit", c.req.param("code"));
    const ws = await loadWorkspace(a.ownerId);
    const u = id ? ws.unitRows.find((x) => x.id === id) : undefined;
    if (!u) return c.json({ error: "This QR code isn't for a unit in your account." }, 404);
    const p = ws.props.find((x) => x.id === u.propertyId);
    const tn = activeTenancyByUnit(ws).get(u.id);
    const mine = a.role === "tenant" && !!tn && a.tenantIds.includes(tn.tenantId);
    const team = a.role === "owner" || a.role === "staff";
    const tenant = tn ? ws.tenantRows.find((t) => t.id === tn.tenantId) : undefined;
    const openRequests =
      team || mine
        ? await db
            .select({
              id: maintenanceRequests.id,
              title: maintenanceRequests.title,
              status: maintenanceRequests.status,
              priority: maintenanceRequests.priority,
            })
            .from(maintenanceRequests)
            .where(
              and(
                eq(maintenanceRequests.unitId, u.id),
                or(eq(maintenanceRequests.status, "open"), eq(maintenanceRequests.status, "in_progress")),
              ),
            )
            .orderBy(desc(maintenanceRequests.updatedAt))
            .limit(10)
        : [];
    const readings = team
      ? await db
          .select({ kind: meterReadings.kind, reading: meterReadings.reading, readOn: meterReadings.readOn })
          .from(meterReadings)
          .where(eq(meterReadings.unitId, u.id))
          .orderBy(desc(meterReadings.readOn), desc(meterReadings.id))
          .limit(10)
      : [];
    const lastReadings = (["electricity", "water"] as const)
      .map((k) => readings.find((r) => r.kind === k))
      .filter((r): r is NonNullable<typeof r> => !!r);
    return c.json({
      unit: { id: u.id, label: u.label, type: u.type, propertyName: p?.name ?? "", address: p?.address ?? "" },
      tenancy:
        tn && (team || mine)
          ? { id: tn.id, tenantId: tn.tenantId, tenantName: tenant?.fullName ?? "", endDate: tn.endDate }
          : null,
      role: a.role,
      mine,
      openRequests,
      lastReadings,
    });
  });
}

/** Routes that work signed out (registered before `requireUser`): receipt verification from the QR code. */
export function registerPublicDocumentRoutes(api: Hono<Env>) {
  api.get("/verify/:code", async (c) => {
    const ip = c.req.header("cf-connecting-ip") ?? c.req.header("x-forwarded-for")?.split(",")[0] ?? "local";
    try {
      if (!(await rateLimit(`verify:${ip}`, 60, 60 * 60_000)))
        return c.json({ error: "Too many checks. Try again in a while." }, 429);
    } catch (e) {
      console.error("verify rate limit unavailable", e);
    }
    const id = await readCode("receipt", c.req.param("code"));
    const [d] = id
      ? await db
          .select()
          .from(documents)
          .where(and(eq(documents.id, id), eq(documents.kind, "receipt")))
      : [];
    const data = d?.ownerId && d.paymentId ? await receiptData(d.ownerId, d.paymentId) : null;
    if (!d || !data) return c.json({ valid: false }, 404, { "cache-control": "no-store" });
    return c.json(
      {
        valid: true,
        number: data.number,
        amount: data.amount,
        paidOn: data.paidOn,
        month: data.month,
        monthTo: data.monthTo ?? null,
        voided: data.voided,
        voidedOn: data.voided ? data.voidedOn : null,
        issuedOn: data.issuedOn,
        method: data.method,
        months: data.lines?.length || 1,
        tenant: data.tenantName,
        unit: data.unitLabel,
        property: data.propertyName,
        landlord: cleanStr(data.ownerName, 80),
        checkedAt: new Date().toISOString(),
      },
      200,
      { "cache-control": "no-store" },
    );
  });
}
