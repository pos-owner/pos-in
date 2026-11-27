import { Hono } from "hono";
import { and, count, eq, gt, inArray, desc, isNull, lt, max, or, sql } from "drizzle-orm";
import {
  db,
  profiles,
  properties,
  units,
  tenants,
  tenancies,
  invites,
  charges,
  payments,
  maintenanceRequests,
  requestComments,
  expenses,
  sessions,
  users,
} from "../db/index.ts";
import { rateLimit } from "./core/rateLimit.ts";
import { actorOf, requireUser, roles, type Env } from "./core/auth.ts";
import { canCommentOnRequest, canReadLedger, canReadRequest, canReadTenant, type Actor } from "./core/access.ts";
import {
  activeTenancyByUnit,
  ensureCharges,
  loadLedger,
  loadWorkspace,
  insertPaymentIfDue,
  isHoldover,
  lockCharge,
  logActivity,
  settlePendingPayment,
  ownerProfile,
  syncChargeStatus,
  type Workspace,
} from "./domain/data.ts";
import { seedWorkspace } from "./domain/seed.ts";
import { body, ownedPhotoKeys, savePhoto, secret, signKeys, validPhotoKey } from "./core/http.ts";
import { getPhoto, MAX_PHOTO_BYTES } from "./core/storage.ts";
import { cronDaily, registerToolRoutes } from "./toolRoutes.ts";
import { registerAccountRoutes, registerAuthRoutes } from "./authRoutes.ts";
import { registerPaymentRoutes } from "./paymentRoutes.ts";
import { registerLeaseRoutes } from "./leaseRoutes.ts";
import { registerBillingRoutes } from "./billingRoutes.ts";
import { registerNotificationRoutes } from "./notificationRoutes.ts";
import { registerDocumentRoutes, registerPublicDocumentRoutes } from "./documentRoutes.ts";
import { registerExportRoutes } from "./exportRoutes.ts";
import { deleteRejectedBatch, ownedBatch, settleBatch, voidBatch } from "./domain/payments.ts";
import { afterPaymentConfirmed } from "./domain/automations.ts";
import { leaseState, recordRevision, repriceMoveOutMonth } from "./domain/leases.ts";
import { announce, paymentNotice, workspaceManagers, type NotifyInput } from "./domain/notifications.ts";
import { isClientKeyConflict, KEY_TAKEN, offlineKey } from "./core/idempotency.ts";
import {
  addDays,
  cleanDate,
  cleanInt,
  cleanStr,
  detectImageMime,
  hashPin,
  monthOf,
  oneOf,
  randomPin,
  randomToken,
  signPath,
  todayIST,
  verifyPin,
  verifySignature,
} from "./core/util.ts";

const api = new Hono<Env>().basePath("/api");

/* ---------- helpers ---------- */

const PIN_LIMIT = 5;
const LOCKED = "Too many wrong PINs. Ask for a new invite.";

function tenancyIdsForTenant(ws: Workspace, a: Actor) {
  return ws.tenancyRows.filter((t) => a.tenantIds.includes(t.tenantId)).map((t) => t.id);
}

/* ---------- public ---------- */

// Deep check: answers 200 only when D1 answers, so an uptime monitor notices a broken database, not just a live Worker.
api.get("/health", async (c) => {
  try {
    await db.run(sql`select 1`);
    return c.json({ ok: true, db: true });
  } catch (e) {
    console.error("health: database check failed", e);
    return c.json({ ok: false, db: false }, 503);
  }
});

registerAuthRoutes(api);

api.get("/invites/:token/info", async (c) => {
  const [inv] = await db
    .select()
    .from(invites)
    .where(eq(invites.token, c.req.param("token")))
    .limit(1);
  if (!inv) return c.json({ error: "This invite link isn't valid." }, 404);
  const owner = await ownerProfile(inv.ownerId);
  let unitLabel = "";
  let propertyName = "";
  if (inv.unitId) {
    const [u] = await db.select().from(units).where(eq(units.id, inv.unitId));
    if (u) {
      unitLabel = u.label;
      const [p] = await db.select().from(properties).where(eq(properties.id, u.propertyId));
      propertyName = p?.name ?? "";
    }
  }
  const state =
    inv.claimedBy || inv.claimedAt
      ? "claimed"
      : inv.expiresAt < new Date()
        ? "expired"
        : inv.attempts >= PIN_LIMIT
          ? "locked"
          : "valid";
  return c.json({ role: inv.role, name: inv.name, ownerName: owner?.fullName ?? "", unitLabel, propertyName, state });
});

api.get("/photos/:key", async (c) => {
  const key = c.req.param("key");
  if (!(await verifySignature(await secret(), key, c.req.query("exp") ?? "", c.req.query("sig") ?? ""))) {
    return c.text("Link expired", 403);
  }
  const blob = await getPhoto(key);
  if (!blob) return c.text("Not found", 404);
  const type = key.endsWith(".png") ? "image/png" : key.endsWith(".webp") ? "image/webp" : "image/jpeg";
  return c.body(blob, 200, {
    "content-type": type,
    "x-content-type-options": "nosniff",
    "cache-control": "private, max-age=3600, immutable",
  });
});

/**
 * Checks an invite PIN against the attempt limit without a read-then-write race. One atomic
 * `UPDATE ... SET attempts = attempts + 1 WHERE attempts < limit RETURNING attempts` reserves the try before
 * the PIN is compared, so parallel guesses can never exceed the limit; the limit is re-checked on the returned
 * value. A correct PIN gives the reserved try back.
 */
async function tryPin(
  inv: typeof invites.$inferSelect,
  pin: string,
): Promise<{ ok: true } | { ok: false; status: 400 | 429; error: string }> {
  const [row] = await db
    .update(invites)
    .set({ attempts: sql`${invites.attempts} + 1` })
    .where(and(eq(invites.id, inv.id), lt(invites.attempts, PIN_LIMIT)))
    .returning({ attempts: invites.attempts });
  if (!row || row.attempts > PIN_LIMIT) return { ok: false, status: 429, error: LOCKED };
  if (await verifyPin(pin, inv.pinHash)) {
    await db
      .update(invites)
      .set({ attempts: sql`max(0, ${invites.attempts} - 1)` })
      .where(eq(invites.id, inv.id));
    return { ok: true };
  }
  const left = PIN_LIMIT - row.attempts;
  return {
    ok: false,
    status: 400,
    error: left > 0 ? `That PIN is incorrect. ${left} ${left === 1 ? "try" : "tries"} left.` : LOCKED,
  };
}

/** Checks the PIN before the invitee signs in. Wrong PINs count toward the 5-try limit. */
api.post("/invites/:token/check", async (c) => {
  const b = await body(c);
  const [inv] = await db
    .select()
    .from(invites)
    .where(eq(invites.token, c.req.param("token")))
    .limit(1);
  if (!inv) return c.json({ error: "This invite link isn't valid." }, 404);
  if (inv.claimedBy || inv.claimedAt) return c.json({ error: "This invite has already been used." }, 410);
  if (inv.expiresAt < new Date()) return c.json({ error: "This invite has expired. Ask for a new one." }, 410);
  try {
    if (!(await rateLimit(`invite-pin:${inv.id}`, 10, 15 * 60_000)))
      return c.json({ error: "Too many PIN attempts. Wait a few minutes and try again." }, 429);
  } catch (e) {
    console.error("invite PIN rate limit unavailable", e);
    return c.json({ error: "Sign-in checks are temporarily unavailable." }, 503);
  }
  const r = await tryPin(inv, cleanStr(b.pin, 12));
  if (!r.ok) return c.json({ error: r.error }, r.status);
  return c.json({ ok: true });
});

/** Daily job, by hand (the Cron Trigger calls the same code directly). Needs CRON_SECRET. */
api.post("/cron/daily", cronDaily);

registerPublicDocumentRoutes(api);

/* ---------- signed in ---------- */

api.use("/*", requireUser);

registerAccountRoutes(api);
registerLeaseRoutes(api);
registerBillingRoutes(api);
registerNotificationRoutes(api);
registerDocumentRoutes(api);
registerExportRoutes(api);

api.get("/me", async (c) => {
  const user = c.get("user");
  const actor = c.get("actor");
  if (!actor) return c.json({ user, profile: null });
  const [p] = await db.select().from(profiles).where(eq(profiles.id, actor.id));
  const owner = actor.role === "owner" ? p : await ownerProfile(actor.ownerId);
  return c.json({
    user,
    profile: {
      id: p.id,
      role: p.role,
      fullName: p.fullName,
      phone: p.phone,
      email: p.email || user.email,
      upiId: p.upiId,
      locale: p.locale === "hi" ? "hi" : "en",
    },
    ownerName: owner?.fullName ?? "",
  });
});

api.post("/onboard", async (c) => {
  const user = c.get("user");
  if (c.get("actor")) return c.json({ error: "Your account is already set up." }, 409);
  const b = await body(c);
  const fullName = cleanStr(b.fullName, 80);
  if (!fullName) return c.json({ error: "Enter your name." }, 400);
  // A double tap must not create two workspaces' worth of demo data: only the request that creates the profile seeds.
  const created = await db
    .insert(profiles)
    .values({
      id: user.id,
      role: "owner",
      ownerId: user.id,
      fullName,
      email: user.email,
      phone: cleanStr(b.phone, 20),
      upiId: cleanStr(b.upiId, 80),
    })
    .onConflictDoNothing()
    .returning({ id: profiles.id });
  if (!created.length) return c.json({ error: "Your account is already set up." }, 409);
  // D1 can't roll the demo data back as one unit. If seeding fails part way, the workspace is still set up (the
  // profile exists), so report it instead of failing onboarding, which a retry could never get past.
  let seeded = false;
  if (b.seed === true) {
    try {
      await seedWorkspace(user.id, fullName);
      seeded = true;
    } catch (e) {
      console.error("demo data failed", e);
    }
  }
  await logActivity(user.id, "onboard", "profile", user.id);
  return c.json({ ok: true, seeded: b.seed === true ? seeded : undefined });
});

api.post("/invites/:token/claim", async (c) => {
  const user = c.get("user");
  const b = await body(c);
  const pin = cleanStr(b.pin, 12);
  const [inv] = await db
    .select()
    .from(invites)
    .where(eq(invites.token, c.req.param("token")))
    .limit(1);
  if (!inv) return c.json({ error: "This invite link isn't valid." }, 404);
  if (inv.claimedBy || inv.claimedAt) return c.json({ error: "This invite has already been used." }, 410);
  if (inv.expiresAt < new Date()) return c.json({ error: "This invite has expired. Ask for a new one." }, 410);
  // Problems that a correct PIN can't fix are reported before a PIN try is spent.
  const existing = c.get("actor");
  if (existing && !(existing.role === "tenant" && inv.role === "tenant" && existing.ownerId === inv.ownerId)) {
    return c.json(
      { error: "This account is already set up. Sign in with a different email to accept this invite." },
      409,
    );
  }
  let tenantId = inv.tenantId;
  if (inv.role === "tenant" && !tenantId && inv.unitId) {
    const [tn] = await db
      .select({ tenantId: tenancies.tenantId })
      .from(tenancies)
      .innerJoin(units, eq(tenancies.unitId, units.id))
      .innerJoin(properties, eq(units.propertyId, properties.id))
      .where(and(eq(tenancies.unitId, inv.unitId), eq(tenancies.status, "active"), eq(properties.ownerId, inv.ownerId)))
      .limit(1);
    tenantId = tn?.tenantId ?? null;
  }
  if (inv.role === "tenant" && !tenantId) return c.json({ error: "No tenant record is linked to this invite." }, 400);
  if (tenantId) {
    // An older unused invite must not move a tenant record away from the person who already joined with it.
    const [t] = await db
      .select({ userId: tenants.userId, ownerId: tenants.ownerId })
      .from(tenants)
      .where(eq(tenants.id, tenantId));
    if (!t || t.ownerId !== inv.ownerId) return c.json({ error: "No tenant record is linked to this invite." }, 400);
    if (t.userId && t.userId !== user.id)
      return c.json({ error: "This tenant has already joined. Ask the owner for help." }, 409);
  }
  try {
    if (!(await rateLimit(`invite-claim:${inv.id}`, 10, 15 * 60_000)))
      return c.json({ error: "Too many attempts. Wait a few minutes and try again." }, 429);
  } catch (e) {
    console.error("invite claim rate limit unavailable", e);
    return c.json({ error: "Joining is temporarily unavailable." }, 503);
  }
  const r = await tryPin(inv, pin);
  if (!r.ok) return c.json({ error: r.error }, r.status);

  // Mark used first (single-use, guarded against a double tap).
  const claimed = await db
    .update(invites)
    .set({ claimedBy: null, claimedAt: new Date() })
    .where(and(eq(invites.id, inv.id), isNull(invites.claimedAt)))
    .returning();
  if (!claimed.length) return c.json({ error: "This invite has already been used." }, 410);

  const fullName = cleanStr(b.fullName, 80) || inv.name || user.name || user.email;
  try {
    if (!existing) {
      await db.insert(profiles).values({
        id: user.id,
        role: inv.role,
        ownerId: inv.ownerId,
        fullName,
        email: user.email,
      });
    }
    if (tenantId) await db.update(tenants).set({ userId: user.id }).where(eq(tenants.id, tenantId));
  } catch (err) {
    // Give the invite back so a failed sign-up doesn't burn the link.
    await db
      .update(invites)
      .set({ claimedAt: null })
      .where(and(eq(invites.id, inv.id), isNull(invites.claimedBy)));
    throw err;
  }
  await db.update(invites).set({ claimedBy: user.id }).where(eq(invites.id, inv.id));
  await logActivity(user.id, "claim_invite", "invite", inv.id);
  return c.json({ ok: true, role: inv.role });
});

api.patch("/profile", roles("owner", "staff", "tenant"), async (c) => {
  const a = actorOf(c);
  const b = await body(c);
  const patch: Partial<typeof profiles.$inferInsert> = {};
  if (typeof b.fullName === "string" && cleanStr(b.fullName)) patch.fullName = cleanStr(b.fullName, 80);
  if (typeof b.phone === "string") patch.phone = cleanStr(b.phone, 20);
  if (typeof b.upiId === "string" && a.role === "owner") patch.upiId = cleanStr(b.upiId, 80);
  if (b.locale === "en" || b.locale === "hi") patch.locale = b.locale;
  if (Object.keys(patch).length) await db.update(profiles).set(patch).where(eq(profiles.id, a.id));
  return c.json({ ok: true });
});

/* ---------- photos ---------- */

api.post("/photos", roles("owner", "staff", "tenant"), async (c) => {
  const a = actorOf(c);
  try {
    if (!(await rateLimit(`photos:${a.ownerId}`, 30, 60 * 60_000)))
      return c.json({ error: "That's a lot of photos. Try again later." }, 429);
  } catch (e) {
    console.error("photo rate limit unavailable", e);
    return c.json({ error: "Uploads are temporarily unavailable." }, 503);
  }
  const form = await c.req.formData().catch(() => null);
  const file = form?.get("file");
  if (!(file instanceof File)) return c.json({ error: "Choose a photo to upload." }, 400);
  if (file.size > MAX_PHOTO_BYTES)
    return c.json({ error: "That photo is too large (max 1.2 MB). Try a smaller photo or lower camera quality." }, 413);
  const bytes = await file.arrayBuffer();
  const actual = detectImageMime(bytes);
  const declared =
    file.type === "image/png"
      ? "image/png"
      : file.type === "image/webp"
        ? "image/webp"
        : file.type === "image/jpeg"
          ? "image/jpeg"
          : null;
  if (!declared || actual !== declared) return c.json({ error: "Use a genuine JPG, PNG or WebP photo." }, 415);
  const ext = actual === "image/png" ? "png" : actual === "image/webp" ? "webp" : "jpg";
  const key = await savePhoto(a, bytes, ext);
  return c.json({ key, url: await signPath(await secret(), key) });
});

/* ---------- workspace (owner + staff) ---------- */

api.get("/workspace", roles("owner", "staff"), async (c) => {
  const a = actorOf(c);
  const ws = await loadWorkspace(a.ownerId);
  await ensureCharges(a.ownerId, ws); // also ends expired leases, so their units show as vacant
  const active = activeTenancyByUnit(ws);
  const tenantById = new Map(ws.tenantRows.map((t) => [t.id, t]));
  return c.json({
    properties: ws.props.map((p) => ({
      id: p.id,
      name: p.name,
      address: p.address,
      units: ws.unitRows
        .filter((u) => u.propertyId === p.id)
        .map((u) => {
          const tn = active.get(u.id);
          const tt = tn ? tenantById.get(tn.tenantId) : undefined;
          return {
            id: u.id,
            label: u.label,
            type: u.type,
            baseRent: u.baseRent,
            tenancy: tn
              ? {
                  id: tn.id,
                  tenantId: tn.tenantId,
                  tenantName: tt?.fullName ?? "",
                  tenantPhone: tt?.phone ?? "",
                  rent: a.role === "owner" ? tn.rent : undefined,
                  endDate: tn.endDate,
                }
              : null,
          };
        }),
    })),
  });
});

api.post("/properties", roles("owner"), async (c) => {
  const a = actorOf(c);
  const b = await body(c);
  const name = cleanStr(b.name, 80);
  if (!name) return c.json({ error: "Give the property a name." }, 400);
  const [p] = await db
    .insert(properties)
    .values({ ownerId: a.id, name, address: cleanStr(b.address, 200) })
    .returning();
  await logActivity(a.id, "create", "property", p.id);
  return c.json(p);
});

async function ownedProperty(a: Actor, id: number) {
  const [p] = await db
    .select()
    .from(properties)
    .where(and(eq(properties.id, id), eq(properties.ownerId, a.ownerId)));
  return p;
}
async function ownedUnit(a: Actor, id: number) {
  const [row] = await db
    .select({ u: units, p: properties })
    .from(units)
    .innerJoin(properties, eq(units.propertyId, properties.id))
    .where(and(eq(units.id, id), eq(properties.ownerId, a.ownerId)));
  return row;
}

api.patch("/properties/:id", roles("owner"), async (c) => {
  const a = actorOf(c);
  const p = await ownedProperty(a, Number(c.req.param("id")));
  if (!p) return c.json({ error: "Property not found." }, 404);
  const b = await body(c);
  await db
    .update(properties)
    .set({
      name: cleanStr(b.name, 80) || p.name,
      address: typeof b.address === "string" ? cleanStr(b.address, 200) : p.address,
    })
    .where(eq(properties.id, p.id));
  return c.json({ ok: true });
});

api.delete("/properties/:id", roles("owner"), async (c) => {
  const a = actorOf(c);
  const p = await ownedProperty(a, Number(c.req.param("id")));
  if (!p) return c.json({ error: "Property not found." }, 404);
  const [busy] = await db
    .select({ id: tenancies.id })
    .from(tenancies)
    .innerJoin(units, eq(tenancies.unitId, units.id))
    .where(and(eq(units.propertyId, p.id), eq(tenancies.status, "active")))
    .limit(1);
  if (busy) return c.json({ error: "End the active tenancies before deleting this property." }, 409);
  await db.delete(properties).where(eq(properties.id, p.id));
  await logActivity(a.id, "delete", "property", p.id);
  return c.json({ ok: true });
});

api.post("/units", roles("owner"), async (c) => {
  const a = actorOf(c);
  const b = await body(c);
  const p = await ownedProperty(a, Number(b.propertyId));
  if (!p) return c.json({ error: "Choose a property." }, 400);
  const label = cleanStr(b.label, 40);
  if (!label) return c.json({ error: "Give the unit a name, like A-101." }, 400);
  const baseRent = b.baseRent === undefined ? 0 : cleanInt(b.baseRent);
  if (baseRent === null) return c.json({ error: "Enter a valid usual rent." }, 400);
  const [u] = await db
    .insert(units)
    .values({
      propertyId: p.id,
      label,
      type: cleanStr(b.type, 20) || "1BHK",
      baseRent,
    })
    .returning();
  return c.json(u);
});

api.patch("/units/:id", roles("owner"), async (c) => {
  const a = actorOf(c);
  const row = await ownedUnit(a, Number(c.req.param("id")));
  if (!row) return c.json({ error: "Unit not found." }, 404);
  const b = await body(c);
  const baseRent = b.baseRent === undefined ? row.u.baseRent : cleanInt(b.baseRent);
  if (baseRent === null) return c.json({ error: "Enter a valid usual rent." }, 400);
  await db
    .update(units)
    .set({
      label: cleanStr(b.label, 40) || row.u.label,
      type: cleanStr(b.type, 20) || row.u.type,
      baseRent,
    })
    .where(eq(units.id, row.u.id));
  return c.json({ ok: true });
});

api.delete("/units/:id", roles("owner"), async (c) => {
  const a = actorOf(c);
  const row = await ownedUnit(a, Number(c.req.param("id")));
  if (!row) return c.json({ error: "Unit not found." }, 404);
  const [busy] = await db
    .select({ id: tenancies.id })
    .from(tenancies)
    .where(and(eq(tenancies.unitId, row.u.id), eq(tenancies.status, "active")))
    .limit(1);
  if (busy) return c.json({ error: `End the active tenancy on ${row.u.label} before deleting it.` }, 409);
  await db.delete(units).where(eq(units.id, row.u.id));
  await logActivity(a.id, "delete", "unit", row.u.id);
  return c.json({ ok: true });
});

/* ---------- tenants ---------- */

api.get("/tenants", roles("owner", "staff"), async (c) => {
  const a = actorOf(c);
  const ws = await loadWorkspace(a.ownerId);
  const isOwner = a.role === "owner";
  let balances = new Map<number, { balance: number; overdue: boolean; awaiting: boolean }>();
  await ensureCharges(a.ownerId, ws);
  if (isOwner) {
    for (const r of await loadLedger(ws)) {
      const cur = balances.get(r.tenantId) ?? { balance: 0, overdue: false, awaiting: false };
      cur.balance += r.balance;
      cur.overdue ||= r.overdue;
      cur.awaiting ||= r.status === "awaiting";
      balances.set(r.tenantId, cur);
    }
  }
  const unitById = new Map(ws.unitRows.map((u) => [u.id, u]));
  const propById = new Map(ws.props.map((p) => [p.id, p]));
  return c.json(
    ws.tenantRows.map((t) => {
      const tn =
        ws.tenancyRows.find((x) => x.tenantId === t.id && x.status === "active") ??
        ws.tenancyRows.find((x) => x.tenantId === t.id);
      const u = tn ? unitById.get(tn.unitId) : undefined;
      return {
        id: t.id,
        fullName: t.fullName,
        phone: t.phone,
        linked: !!t.userId,
        unitLabel: u?.label ?? "",
        propertyName: u ? (propById.get(u.propertyId)?.name ?? "") : "",
        active: tn?.status === "active",
        rent: isOwner ? tn?.rent : undefined,
        ...(isOwner ? (balances.get(t.id) ?? { balance: 0, overdue: false, awaiting: false }) : {}),
      };
    }),
  );
});

api.get("/tenants/:id", roles("owner", "staff"), async (c) => {
  const a = actorOf(c);
  const id = Number(c.req.param("id"));
  const ws = await loadWorkspace(a.ownerId);
  const t = ws.tenantRows.find((x) => x.id === id);
  if (!t || !canReadTenant(a, { ownerId: t.ownerId, tenantId: t.id }))
    return c.json({ error: "Tenant not found." }, 404);
  const tns = ws.tenancyRows.filter((x) => x.tenantId === id);
  const unitById = new Map(ws.unitRows.map((u) => [u.id, u]));
  const propById = new Map(ws.props.map((p) => [p.id, p]));
  const ledger = canReadLedger(a, { ownerId: t.ownerId, tenantId: t.id })
    ? (await ensureCharges(a.ownerId, ws), await loadLedger(ws, { tenancyIds: tns.map((x) => x.id) }))
    : null;
  const unitIds = tns.map((x) => x.unitId);
  const reqs = unitIds.length
    ? await db
        .select()
        .from(maintenanceRequests)
        .where(inArray(maintenanceRequests.unitId, unitIds))
        .orderBy(desc(maintenanceRequests.createdAt))
        .limit(20)
    : [];
  const openInvite =
    a.role === "owner"
      ? (
          await db
            .select()
            .from(invites)
            .where(and(eq(invites.tenantId, id), isNull(invites.claimedAt)))
            .orderBy(desc(invites.createdAt))
            .limit(1)
        )[0]
      : undefined;
  return c.json({
    tenant: {
      id: t.id,
      fullName: t.fullName,
      phone: t.phone,
      email: t.email,
      idNote: a.role === "owner" ? t.idNote : "",
      emergencyContact: t.emergencyContact,
      moveInDate: t.moveInDate,
      deposit: a.role === "owner" ? t.deposit : undefined,
      linked: !!t.userId,
    },
    tenancies: tns.map((x) => {
      const u = unitById.get(x.unitId)!;
      return {
        id: x.id,
        unitId: x.unitId,
        unitLabel: u.label,
        propertyName: propById.get(u.propertyId)?.name ?? "",
        rent: a.role === "owner" ? x.rent : undefined,
        dueDay: x.dueDay,
        deposit: a.role === "owner" ? x.deposit : undefined,
        startDate: x.startDate,
        endDate: x.endDate,
        moveOutDate: x.moveOutDate,
        status: x.status,
        state: leaseState(x),
      };
    }),
    ledger,
    requests: reqs.map((r) => ({
      id: r.id,
      title: r.title,
      status: r.status,
      priority: r.priority,
      createdAt: r.createdAt,
    })),
    pendingInvite:
      openInvite && openInvite.expiresAt > new Date()
        ? { id: openInvite.id, token: openInvite.token, expiresAt: openInvite.expiresAt }
        : null,
  });
});

api.post("/tenants", roles("owner"), async (c) => {
  const a = actorOf(c);
  const b = await body(c);
  const fullName = cleanStr(b.fullName, 80);
  if (!fullName) return c.json({ error: "Enter the tenant's name." }, 400);
  const row = await ownedUnit(a, Number(b.unitId));
  if (!row) return c.json({ error: "Choose a unit." }, 400);
  const rent = cleanInt(b.rent, 1);
  if (!rent) return c.json({ error: "Enter the monthly rent." }, 400);
  const startDate = cleanDate(b.startDate);
  if (!startDate) return c.json({ error: "Enter the start date." }, 400);
  const endDate = b.endDate ? cleanDate(b.endDate) : null;
  if (b.endDate && !endDate) return c.json({ error: "Enter a valid end date." }, 400);
  if (endDate && endDate < startDate) return c.json({ error: "The end date must be after the start date." }, 400);
  await ensureCharges(a.ownerId, await loadWorkspace(a.ownerId), true); // ends leases that are past their end date
  const [busy] = await db
    .select()
    .from(tenancies)
    .where(and(eq(tenancies.unitId, row.u.id), eq(tenancies.status, "active")));
  if (busy) return c.json({ error: `${row.u.label} already has an active tenant. End that tenancy first.` }, 409);
  const deposit = b.deposit === undefined ? 0 : cleanInt(b.deposit);
  if (deposit === null) return c.json({ error: "Enter a valid deposit." }, 400);
  // A failed tenancy insert must not leave a tenant record with no unit behind (D1 has no interactive
  // transactions, so the tenant is removed again if the second insert fails).
  const t = await (async () => {
    const [created] = await db
      .insert(tenants)
      .values({
        ownerId: a.id,
        fullName,
        phone: cleanStr(b.phone, 20).replace(/[^\d+]/g, ""),
        email: cleanStr(b.email, 120),
        idNote: cleanStr(b.idNote, 200),
        emergencyContact: cleanStr(b.emergencyContact, 120),
        moveInDate: startDate,
        deposit,
      })
      .returning();
    try {
      await db.insert(tenancies).values({
        unitId: row.u.id,
        tenantId: created.id,
        rent,
        dueDay: cleanInt(b.dueDay, 1, 28) ?? 5,
        deposit,
        startDate,
        endDate,
      });
    } catch (e) {
      await db.delete(tenants).where(eq(tenants.id, created.id));
      throw e;
    }
    return created;
  })();
  await ensureCharges(a.ownerId, undefined, true);
  await logActivity(a.id, "create", "tenant", t.id);
  return c.json(t);
});

api.patch("/tenants/:id", roles("owner"), async (c) => {
  const a = actorOf(c);
  const id = Number(c.req.param("id"));
  const [t] = await db
    .select()
    .from(tenants)
    .where(and(eq(tenants.id, id), eq(tenants.ownerId, a.ownerId)));
  if (!t) return c.json({ error: "Tenant not found." }, 404);
  const b = await body(c);
  const s = (k: string, max: number, cur: string) => (typeof b[k] === "string" ? cleanStr(b[k], max) : cur);
  await db
    .update(tenants)
    .set({
      fullName: cleanStr(b.fullName, 80) || t.fullName,
      phone: s("phone", 20, t.phone).replace(/[^\d+]/g, ""),
      email: s("email", 120, t.email),
      idNote: s("idNote", 200, t.idNote),
      emergencyContact: s("emergencyContact", 120, t.emergencyContact),
    })
    .where(eq(tenants.id, id));
  return c.json({ ok: true });
});

async function ownedTenancy(a: Actor, id: number) {
  const [row] = await db
    .select({ tn: tenancies })
    .from(tenancies)
    .innerJoin(units, eq(tenancies.unitId, units.id))
    .innerJoin(properties, eq(units.propertyId, properties.id))
    .where(and(eq(tenancies.id, id), eq(properties.ownerId, a.ownerId)));
  return row?.tn;
}

api.patch("/tenancies/:id", roles("owner"), async (c) => {
  const a = actorOf(c);
  const tn = await ownedTenancy(a, Number(c.req.param("id")));
  if (!tn) return c.json({ error: "Tenancy not found." }, 404);
  const b = await body(c);
  const clearing = b.endDate === null || b.endDate === "";
  const endDate = clearing ? null : b.endDate !== undefined ? cleanDate(b.endDate) : tn.endDate;
  // A malformed date (including 0 or false) must not silently clear the lease end.
  if (b.endDate !== undefined && !clearing && !endDate) return c.json({ error: "Enter a valid end date." }, 400);
  if (endDate && endDate < tn.startDate) return c.json({ error: "The end date must be after the start date." }, 400);
  if (b.dueDay !== undefined && cleanInt(b.dueDay, 1, 28) === null)
    return c.json({ error: "The due day must be between 1 and 28." }, 400);
  const rent = b.rent === undefined ? tn.rent : cleanInt(b.rent, 1);
  if (rent === null) return c.json({ error: "Enter a valid monthly rent." }, 400);
  const deposit = b.deposit === undefined ? tn.deposit : cleanInt(b.deposit);
  if (deposit === null) return c.json({ error: "Enter a valid deposit." }, 400);
  const [after] = await db
    .update(tenancies)
    .set({
      rent,
      dueDay: cleanInt(b.dueDay, 1, 28) ?? tn.dueDay,
      deposit,
      endDate,
    })
    .where(eq(tenancies.id, tn.id))
    .returning();
  // Direct edits are part of the lease history too (an append-only `revision` term).
  if (after) await recordRevision(a.ownerId, tn, after, a.id);
  return c.json({ ok: true });
});

api.post("/tenancies/:id/end", roles("owner"), async (c) => {
  const a = actorOf(c);
  const tn = await ownedTenancy(a, Number(c.req.param("id")));
  if (!tn) return c.json({ error: "Tenancy not found." }, 404);
  if (tn.status !== "active") return c.json({ error: "This tenancy has already ended." }, 409);
  const b = await body(c);
  const today = todayIST();
  const endDate = b.endDate ? cleanDate(b.endDate) : today;
  if (!endDate) return c.json({ error: "Enter a valid move-out date." }, 400);
  if (endDate < tn.startDate) return c.json({ error: "The move-out date can't be before the tenancy started." }, 400);
  // The move-out is stored on its own (`move_out_date`): the lease end date stays as it was, so "the lease ended"
  // and "the tenant left" can still be told apart.
  if (endDate > today) {
    // A future move-out keeps the tenancy running (and billed) until then; it ends automatically the day after.
    const [updated] = await db
      .update(tenancies)
      .set({ moveOutDate: endDate })
      .where(and(eq(tenancies.id, tn.id), eq(tenancies.status, "active")))
      .returning();
    if (updated) await repriceMoveOutMonth(a.ownerId, updated, tn.moveOutDate);
    await logActivity(a.id, "schedule_end", "tenancy", tn.id);
    return c.json({ ok: true, scheduled: true, endDate });
  }
  const [ended] = await db
    .update(tenancies)
    .set({ status: "ended", moveOutDate: endDate })
    .where(and(eq(tenancies.id, tn.id), eq(tenancies.status, "active")))
    .returning();
  if (!ended) return c.json({ error: "This tenancy has already ended." }, 409);
  await repriceMoveOutMonth(a.ownerId, ended, tn.moveOutDate);
  // Months after the move-out that were already generated would otherwise sit as "overdue" forever.
  // Only untouched charges go: anything with a payment or a meter bill stays for the owner to sort out.
  const later = await db
    .select({ id: charges.id, extra: charges.extra })
    .from(charges)
    .where(and(eq(charges.tenancyId, tn.id), sql`${charges.month} > ${monthOf(endDate)}`));
  const withPays = later.length
    ? new Set(
        (
          await db
            .select({ chargeId: payments.chargeId })
            .from(payments)
            .where(
              inArray(
                payments.chargeId,
                later.map((x) => x.id),
              ),
            )
        ).map((x) => x.chargeId),
      )
    : new Set<number>();
  const drop = later.filter((x) => x.extra === 0 && !withPays.has(x.id)).map((x) => x.id);
  if (drop.length) await db.delete(charges).where(inArray(charges.id, drop));
  await logActivity(a.id, "end", "tenancy", tn.id);
  return c.json({ ok: true, scheduled: false, endDate, removedCharges: drop.length });
});

/* ---------- rent ---------- */

api.get("/dashboard", roles("owner"), async (c) => {
  const a = actorOf(c);
  const ws = await loadWorkspace(a.ownerId);
  await ensureCharges(a.ownerId, ws);
  const ledger = await loadLedger(ws);
  const today = todayIST();
  const cur = monthOf(today);
  const thisMonth = ledger.filter((r) => r.month === cur);
  const active = activeTenancyByUnit(ws);
  const tenantById = new Map(ws.tenantRows.map((t) => [t.id, t]));
  const unitById = new Map(ws.unitRows.map((u) => [u.id, u]));
  const openReqs = await db
    .select({ r: maintenanceRequests, u: units })
    .from(maintenanceRequests)
    .innerJoin(units, eq(maintenanceRequests.unitId, units.id))
    .innerJoin(properties, eq(units.propertyId, properties.id))
    .where(
      and(
        eq(properties.ownerId, a.ownerId),
        or(eq(maintenanceRequests.status, "open"), eq(maintenanceRequests.status, "in_progress")),
      ),
    )
    .orderBy(desc(maintenanceRequests.createdAt));
  const pendingExpenses = ws.props.length
    ? await db
        .select({ id: expenses.id })
        .from(expenses)
        .where(
          and(
            inArray(
              expenses.propertyId,
              ws.props.map((p) => p.id),
            ),
            eq(expenses.approved, false),
          ),
        )
    : [];
  const soon = addDays(today, 60);
  return c.json({
    month: cur,
    today,
    due: thisMonth.reduce((s, r) => s + r.amount, 0),
    collected: thisMonth.reduce((s, r) => s + r.paid, 0),
    // Months paid ahead in part aren't owed yet, so they don't count as outstanding.
    outstanding: ledger.filter((r) => r.month <= cur).reduce((s, r) => s + r.balance, 0),
    advance: ledger.filter((r) => r.month > cur).reduce((s, r) => s + r.paid, 0),
    occupied: active.size,
    totalUnits: ws.unitRows.length,
    overdue: ledger.filter((r) => r.overdue).map(slimCharge),
    awaiting: ledger.filter((r) => r.status === "awaiting").map(slimCharge),
    openRequests: openReqs
      .slice(0, 4)
      .map(({ r, u }) => ({ id: r.id, title: r.title, status: r.status, priority: r.priority, unitLabel: u.label })),
    openRequestCount: openReqs.length,
    pendingExpenseCount: pendingExpenses.length,
    // Leases ending in the next 60 days, plus holdovers (past their end date, no move-out, still billed). A tenant
    // with a move-out already scheduled has been dealt with, so they aren't listed.
    leasesEnding: [...active.values()]
      .filter((t) => !t.moveOutDate && !!t.endDate && t.endDate <= soon)
      .sort((x, y) => (x.endDate ?? "").localeCompare(y.endDate ?? ""))
      .map((t) => ({
        tenancyId: t.id,
        tenantId: t.tenantId,
        tenantName: tenantById.get(t.tenantId)?.fullName ?? "",
        unitLabel: unitById.get(t.unitId)?.label ?? "",
        endDate: t.endDate as string,
        holdover: isHoldover(t, today),
      })),
    hasProperties: ws.props.length > 0,
  });
});

function slimCharge(r: Awaited<ReturnType<typeof loadLedger>>[number]) {
  return {
    id: r.id,
    month: r.month,
    amount: r.amount,
    balance: r.balance,
    pending: r.pending,
    status: r.status,
    dueDate: r.dueDate,
    tenantId: r.tenantId,
    tenantName: r.tenantName,
    tenantPhone: r.tenantPhone,
    unitLabel: r.unitLabel,
    propertyName: r.propertyName,
  };
}

api.get("/ledger", roles("owner"), async (c) => {
  const a = actorOf(c);
  const ws = await loadWorkspace(a.ownerId);
  await ensureCharges(a.ownerId, ws);
  const month = /^\d{4}-\d{2}$/.test(c.req.query("month") ?? "") ? c.req.query("month") : undefined;
  const everything = await loadLedger(ws);
  let rows = month ? everything.filter((r) => r.month === month) : everything;
  const pid = Number(c.req.query("propertyId"));
  if (pid) rows = rows.filter((r) => r.propertyId === pid);
  const months = [...new Set(everything.map((r) => r.month))].sort().reverse();
  return c.json({ rows, months, properties: ws.props.map((p) => ({ id: p.id, name: p.name })) });
});

async function chargeForActor(a: Actor, id: number) {
  const ws = await loadWorkspace(a.ownerId);
  const [row] = await loadLedger(ws, {
    tenancyIds: a.role === "tenant" ? tenancyIdsForTenant(ws, a) : undefined,
  }).then((rows) => rows.filter((r) => r.id === id));
  if (!row || !canReadLedger(a, { ownerId: a.ownerId, tenantId: row.tenantId })) return null;
  return row;
}

api.get("/charges/:id", roles("owner", "tenant"), async (c) => {
  const a = actorOf(c);
  const row = await chargeForActor(a, Number(c.req.param("id")));
  if (!row) return c.json({ error: "Charge not found." }, 404);
  const owner = await ownerProfile(a.ownerId);
  return c.json({ charge: row, payee: { name: owner?.fullName ?? "", upiId: owner?.upiId ?? "" } });
});

api.post("/charges/:id/payments", roles("owner", "tenant"), async (c) => {
  const a = actorOf(c);
  const row = await chargeForActor(a, Number(c.req.param("id")));
  if (!row) return c.json({ error: "Charge not found." }, 404);
  const b = await body(c);
  // The checks below give friendly messages. The insert re-checks the balance (and, for tenants, that no report is
  // already waiting) inside one SQL statement, so two submissions at once (a double tap, two tenant "I paid" taps,
  // or the owner recording cash while the tenant reports UPI) can't both pass.
  const live = await lockCharge(db, row.id);
  if (!live) return c.json({ error: "Charge not found." }, 404);
  if (live.balance <= 0) return c.json({ error: "This charge is already fully paid." }, 409);
  if (a.role === "tenant") {
    if (live.pending > 0)
      return c.json({ error: "You've already told the owner about a payment. It's awaiting confirmation." }, 409);
    const given = b.amount !== undefined && b.amount !== null && b.amount !== "";
    const parsed = cleanInt(b.amount, 1);
    if (given && parsed === null) return c.json({ error: "Enter a valid amount." }, 400);
    const amount = parsed ?? live.balance;
    const id = await insertPaymentIfDue(
      {
        chargeId: row.id,
        amount: Math.min(amount, live.balance),
        method: "upi",
        utr: cleanStr(b.utr, 40).replace(/\s/g, ""),
        status: "pending",
        recordedBy: a.id,
        paidOn: todayIST(),
        note: cleanStr(b.note, 200),
      },
      { noPending: true },
    );
    if (id === null) return c.json({ error: "This charge changed a moment ago. Pull to refresh and try again." }, 409);
    await syncChargeStatus(row.id);
    await logActivity(a.id, "mark_paid", "charge", row.id);
    await announce(
      c,
      await paymentNotice(a.ownerId, {
        event: "claim",
        chargeId: row.id,
        amount: Math.min(amount, live.balance),
        ref: id,
      }),
    );
    return c.json({ ok: true });
  }
  const amount = cleanInt(b.amount, 1);
  if (!amount) return c.json({ error: "Enter the amount received." }, 400);
  if (amount > live.balance)
    return c.json({ error: `That's more than the ₹${live.balance.toLocaleString("en-IN")} still due.` }, 400);
  const method = oneOf(b.method, ["cash", "bank", "upi"] as const);
  if (!method) return c.json({ error: "Choose how it was paid." }, 400);
  const paymentId = await insertPaymentIfDue({
    chargeId: row.id,
    amount,
    method,
    utr: cleanStr(b.utr, 40),
    status: "confirmed",
    recordedBy: a.id,
    paidOn: cleanDate(b.paidOn) ?? todayIST(),
    note: cleanStr(b.note, 200),
  });
  if (paymentId === null) {
    const now = await lockCharge(db, row.id);
    return c.json(
      {
        error:
          !now || now.balance <= 0
            ? "This charge is already fully paid."
            : `That's more than the ₹${now.balance.toLocaleString("en-IN")} still due.`,
      },
      409,
    );
  }
  await syncChargeStatus(row.id);
  // The receipt is idempotent (one per payment, unique index) and can be issued again from the receipts screen; a
  // receipt failure must never undo the payment.
  await afterPaymentConfirmed(a.ownerId, paymentId);
  await logActivity(a.id, "record_payment", "charge", row.id);
  return c.json({ ok: true, paymentId });
});

async function ownedPayment(a: Actor, id: number) {
  const [row] = await db
    .select({ p: payments })
    .from(payments)
    .innerJoin(charges, eq(payments.chargeId, charges.id))
    .innerJoin(tenancies, eq(charges.tenancyId, tenancies.id))
    .innerJoin(units, eq(tenancies.unitId, units.id))
    .innerJoin(properties, eq(units.propertyId, properties.id))
    .where(and(eq(payments.id, id), eq(properties.ownerId, a.ownerId)));
  return row?.p;
}

for (const action of ["confirm", "reject"] as const) {
  api.post(`/payments/:id/${action}`, roles("owner"), async (c) => {
    const a = actorOf(c);
    const p = await ownedPayment(a, Number(c.req.param("id")));
    if (!p) return c.json({ error: "Payment not found." }, 404);
    if (p.status !== "pending") return c.json({ error: "This payment was already handled." }, 409);
    if (p.batchId != null) {
      // One month of a multi-month claim: the whole claim is confirmed or rejected together.
      const batch = await ownedBatch(a.ownerId, p.batchId);
      if (!batch) return c.json({ error: "Payment not found." }, 404);
      const r = await settleBatch(batch, action);
      if (r === "handled") return c.json({ error: "This payment was already handled." }, 409);
      if (r === "no_fit")
        return c.json(
          {
            error:
              "Part of this payment no longer fits: some of these months were paid another way since. Mark it not received and record what actually arrived.",
          },
          409,
        );
      if (action === "confirm") await afterPaymentConfirmed(a.ownerId, p.id);
      await logActivity(a.id, action, "payment_batch", batch.id);
      await announce(
        c,
        await paymentNotice(a.ownerId, {
          event: action === "confirm" ? "confirmed" : "rejected",
          tenancyId: batch.tenancyId,
          amount: batch.amount,
          months: batch.months,
          ref: `b${batch.id}`,
        }),
      );
      return c.json({ ok: true, batchId: batch.id, amount: batch.amount, months: batch.months });
    }
    // Only a still-pending payment changes state (so a double tap can't confirm and receipt it twice), and a
    // confirmation must still fit the balance at that instant: both are checked inside the one UPDATE.
    if (!(await settlePendingPayment(p.id, p.chargeId, action))) {
      const live = await lockCharge(db, p.chargeId);
      const [now] = await db.select({ status: payments.status }).from(payments).where(eq(payments.id, p.id));
      if (!live || now?.status !== "pending") return c.json({ error: "This payment was already handled." }, 409);
      const due = live.balance;
      return c.json(
        {
          error:
            due === 0
              ? "This charge is already fully paid. Reject this payment, or void the other payment first."
              : `This is more than the ₹${due.toLocaleString("en-IN")} still due. Reject it and record the right amount instead.`,
        },
        409,
      );
    }
    await syncChargeStatus(p.chargeId);
    // As for recorded payments: receipts are idempotent and must never undo the payment.
    if (action === "confirm") await afterPaymentConfirmed(a.ownerId, p.id);
    await logActivity(a.id, action, "payment", p.id);
    await announce(
      c,
      await paymentNotice(a.ownerId, {
        event: action === "confirm" ? "confirmed" : "rejected",
        chargeId: p.chargeId,
        amount: p.amount,
        ref: p.id,
      }),
    );
    return c.json({ ok: true });
  });
}

/**
 * Voids a confirmed payment: it stops counting toward the charge, but the row, its receipt and the
 * reason, who and when are kept for the records. Confirmed payments are never deleted.
 */
api.post("/payments/:id/void", roles("owner"), async (c) => {
  const a = actorOf(c);
  const p = await ownedPayment(a, Number(c.req.param("id")));
  if (!p) return c.json({ error: "Payment not found." }, 404);
  if (p.status !== "confirmed") return c.json({ error: "Only confirmed payments can be voided." }, 409);
  const b = await body(c);
  const reason = cleanStr(b.reason, 200);
  if (!reason) return c.json({ error: "Say why this payment is being voided." }, 400);
  if (p.batchId != null) {
    // A multi-month payment is voided as a whole, so its one receipt and its months never disagree.
    const batch = await ownedBatch(a.ownerId, p.batchId);
    if (!batch || !(await voidBatch(batch, reason, a.id)))
      return c.json({ error: "This payment was already handled." }, 409);
    await logActivity(a.id, "void", "payment_batch", batch.id);
    return c.json({ ok: true, batchId: batch.id, months: batch.months });
  }
  const done = await db
    .update(payments)
    .set({ status: "void", voidReason: reason, voidedBy: a.id, voidedAt: new Date() })
    .where(and(eq(payments.id, p.id), eq(payments.status, "confirmed")))
    .returning({ id: payments.id });
  if (!done.length) return c.json({ error: "This payment was already handled." }, 409);
  await syncChargeStatus(p.chargeId);
  await logActivity(a.id, "void", "payment", p.id);
  return c.json({ ok: true });
});

/** Only payments marked "not received" can be removed. Confirmed ones are voided instead (see above). */
api.delete("/payments/:id", roles("owner"), async (c) => {
  const a = actorOf(c);
  const p = await ownedPayment(a, Number(c.req.param("id")));
  if (!p) return c.json({ error: "Payment not found." }, 404);
  if (p.status === "confirmed" || p.status === "void") {
    return c.json(
      { error: "Confirmed payments can't be deleted. Void it instead, so the receipt stays on record.", code: "void" },
      409,
    );
  }
  if (p.status === "pending") return c.json({ error: "Confirm or reject this payment first." }, 409);
  if (p.batchId != null) {
    const batch = await ownedBatch(a.ownerId, p.batchId);
    if (!batch || !(await deleteRejectedBatch(batch)))
      return c.json({ error: "This payment was already handled." }, 409);
    await logActivity(a.id, "delete", "payment_batch", batch.id);
    return c.json({ ok: true });
  }
  await db.delete(payments).where(and(eq(payments.id, p.id), eq(payments.status, "rejected")));
  await syncChargeStatus(p.chargeId);
  await logActivity(a.id, "delete", "payment", p.id);
  return c.json({ ok: true });
});

/* ---------- tenant app ---------- */

api.get("/tenant/home", roles("tenant"), async (c) => {
  const a = actorOf(c);
  const ws = await loadWorkspace(a.ownerId);
  await ensureCharges(a.ownerId, ws);
  const mine = ws.tenancyRows.filter((t) => a.tenantIds.includes(t.tenantId));
  const tn = mine.find((t) => t.status === "active") ?? mine[0];
  const ledger = await loadLedger(ws, { tenancyIds: mine.map((t) => t.id) });
  const owner = await ownerProfile(a.ownerId);
  const u = tn ? ws.unitRows.find((x) => x.id === tn.unitId) : undefined;
  const p = u ? ws.props.find((x) => x.id === u.propertyId) : undefined;
  const t = ws.tenantRows.find((x) => a.tenantIds.includes(x.id));
  return c.json({
    tenant: t
      ? {
          id: t.id,
          fullName: t.fullName,
          phone: t.phone,
          email: t.email,
          emergencyContact: t.emergencyContact,
          moveInDate: t.moveInDate,
        }
      : null,
    tenancy: tn
      ? {
          id: tn.id,
          rent: tn.rent,
          dueDay: tn.dueDay,
          deposit: tn.deposit,
          startDate: tn.startDate,
          endDate: tn.endDate,
          status: tn.status,
        }
      : null,
    unit: u ? { id: u.id, label: u.label, type: u.type } : null,
    property: p ? { name: p.name, address: p.address } : null,
    payee: { name: owner?.fullName ?? "", upiId: owner?.upiId ?? "", phone: owner?.phone ?? "" },
    outstanding: ledger
      .filter((r) => r.balance > 0 && r.month <= monthOf(todayIST()))
      .sort((x, y) => x.month.localeCompare(y.month)),
    /** Upcoming months that already have money on them (rent paid ahead), oldest first. */
    advance: ledger
      .filter((r) => r.month > monthOf(todayIST()) && (r.paid > 0 || r.pending > 0))
      .sort((x, y) => x.month.localeCompare(y.month)),
    ledger,
    today: todayIST(),
  });
});

/* ---------- maintenance requests ---------- */

async function requestScope(a: Actor) {
  const ws = await loadWorkspace(a.ownerId);
  await ensureCharges(a.ownerId, ws); // a lease that has ended no longer grants access to the unit's requests
  const unitTenants = new Map<number, number[]>();
  for (const t of ws.tenancyRows) {
    if (t.status !== "active") continue;
    unitTenants.set(t.unitId, [...(unitTenants.get(t.unitId) ?? []), t.tenantId]);
  }
  return { ws, unitTenants };
}

api.get("/requests", roles("owner", "staff", "tenant"), async (c) => {
  const a = actorOf(c);
  const { ws, unitTenants } = await requestScope(a);
  const unitIds = ws.unitRows.map((u) => u.id);
  if (!unitIds.length) return c.json([]);
  const rows = await db
    .select()
    .from(maintenanceRequests)
    .where(inArray(maintenanceRequests.unitId, unitIds))
    .orderBy(desc(maintenanceRequests.updatedAt));
  const unitById = new Map(ws.unitRows.map((u) => [u.id, u]));
  const propById = new Map(ws.props.map((p) => [p.id, p]));
  const staff = await db
    .select({ id: profiles.id, fullName: profiles.fullName })
    .from(profiles)
    .where(eq(profiles.ownerId, a.ownerId));
  const nameOf = new Map(staff.map((s) => [s.id, s.fullName]));
  return c.json(
    rows
      .filter((r) =>
        canReadRequest(a, { ownerId: a.ownerId, unitTenantIds: unitTenants.get(r.unitId) ?? [], raisedBy: r.raisedBy }),
      )
      .map((r) => {
        const u = unitById.get(r.unitId)!;
        return {
          id: r.id,
          title: r.title,
          status: r.status,
          priority: r.priority,
          unitLabel: u.label,
          propertyName: propById.get(u.propertyId)?.name ?? "",
          raisedByName: r.raisedByName,
          assignedName: r.assignedTo ? (nameOf.get(r.assignedTo) ?? "") : "",
          photoCount: r.photoKeys.length,
          createdAt: r.createdAt,
          updatedAt: r.updatedAt,
        };
      }),
  );
});

api.post("/requests", roles("owner", "staff", "tenant"), async (c) => {
  const a = actorOf(c);
  const b = await body(c);
  const { ws, unitTenants } = await requestScope(a);
  let unitId = Number(b.unitId);
  if (a.role === "tenant") {
    const mine = [...unitTenants.entries()].filter(([, ts]) => ts.some((t) => a.tenantIds.includes(t))).map(([u]) => u);
    if (!mine.includes(unitId)) unitId = mine[0];
  }
  // A retry from the offline outbox returns the request it already saved.
  const clientKey = offlineKey(b.clientKey);
  const replayed = async () => {
    if (!clientKey) return null;
    const [old] = await db.select().from(maintenanceRequests).where(eq(maintenanceRequests.clientKey, clientKey));
    if (!old) return null;
    const own = old.raisedBy === a.id && ws.unitRows.some((u) => u.id === old.unitId);
    return own ? c.json(old) : c.json({ error: KEY_TAKEN }, 409);
  };
  const again = await replayed();
  if (again) return again;
  if (!ws.unitRows.some((u) => u.id === unitId)) return c.json({ error: "Choose a unit." }, 400);
  const title = cleanStr(b.title, 120);
  if (!title) return c.json({ error: "Describe the problem in a few words." }, 400);
  const photoKeys = (await ownedPhotoKeys(a, Array.isArray(b.photoKeys) ? b.photoKeys : [])).slice(0, 6);
  const priority = oneOf(b.priority, ["low", "medium", "high"] as const) ?? "medium";
  let r: typeof maintenanceRequests.$inferSelect;
  try {
    [r] = await db
      .insert(maintenanceRequests)
      .values({
        unitId,
        raisedBy: a.id,
        raisedByName: a.name,
        title,
        description: cleanStr(b.description, 2000),
        priority,
        photoKeys,
        clientKey,
      })
      .returning();
  } catch (e) {
    // Two retries of the same entry at once: the other one saved it.
    if (isClientKeyConflict(e)) return (await replayed()) ?? c.json({ error: KEY_TAKEN }, 409);
    throw e;
  }
  await logActivity(a.id, "create", "request", r.id);
  const unit = ws.unitRows.find((u) => u.id === unitId);
  const urgent = priority === "high";
  await announce(
    c,
    (await workspaceManagers(a.ownerId, true))
      .filter((id) => id !== a.id)
      .map((recipientId) => ({
        ownerId: a.ownerId,
        recipientId,
        kind: urgent ? ("request_urgent" as const) : ("request_new" as const),
        title: `${urgent ? "Urgent: " : "New request: "}${title}`,
        body: `${unit?.label ?? ""} · raised by ${a.name || "someone"}`,
        url: `/requests/${r.id}`,
        entity: "request",
        entityId: r.id,
        dedupe: `request_new:${r.id}`,
      })),
  );
  return c.json(r);
});

async function readableRequest(a: Actor, id: number) {
  const { ws, unitTenants } = await requestScope(a);
  const [r] = await db.select().from(maintenanceRequests).where(eq(maintenanceRequests.id, id));
  if (!r || !ws.unitRows.some((u) => u.id === r.unitId)) return null;
  const rec = { ownerId: a.ownerId, unitTenantIds: unitTenants.get(r.unitId) ?? [], raisedBy: r.raisedBy };
  if (!canReadRequest(a, rec)) return null;
  return { r, ws, canComment: canCommentOnRequest(a, rec) };
}

api.get("/requests/:id", roles("owner", "staff", "tenant"), async (c) => {
  const a = actorOf(c);
  const found = await readableRequest(a, Number(c.req.param("id")));
  if (!found) return c.json({ error: "Request not found." }, 404);
  const { r, ws } = found;
  const comments = await db
    .select()
    .from(requestComments)
    .where(eq(requestComments.requestId, r.id))
    .orderBy(requestComments.createdAt);
  const u = ws.unitRows.find((x) => x.id === r.unitId)!;
  const people = await db
    .select({ id: profiles.id, fullName: profiles.fullName, role: profiles.role })
    .from(profiles)
    .where(and(eq(profiles.ownerId, a.ownerId), or(eq(profiles.role, "staff"), eq(profiles.role, "owner"))));
  const s = await secret();
  return c.json({
    request: {
      id: r.id,
      title: r.title,
      description: r.description,
      status: r.status,
      priority: r.priority,
      unitId: r.unitId,
      unitLabel: u.label,
      propertyName: ws.props.find((p) => p.id === u.propertyId)?.name ?? "",
      raisedByName: r.raisedByName,
      assignedTo: r.assignedTo,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
      photos: await signKeys(r.photoKeys),
    },
    comments: await Promise.all(
      comments.map(async (cm) => ({
        id: cm.id,
        authorName: cm.authorName,
        mine: cm.authorId === a.id,
        body: cm.body,
        createdAt: cm.createdAt,
        photo: cm.photoPath ? await signPath(s, cm.photoPath) : null,
      })),
    ),
    assignees: a.role === "tenant" ? [] : people.map((p) => ({ id: p.id, name: p.fullName, role: p.role })),
    canComment: found.canComment,
  });
});

api.patch("/requests/:id", roles("owner", "staff"), async (c) => {
  const a = actorOf(c);
  const found = await readableRequest(a, Number(c.req.param("id")));
  if (!found) return c.json({ error: "Request not found." }, 404);
  const b = await body(c);
  const patch: Partial<typeof maintenanceRequests.$inferInsert> = { updatedAt: new Date() };
  const status = oneOf(b.status, ["open", "in_progress", "done"] as const);
  if (status) patch.status = status;
  const priority = oneOf(b.priority, ["low", "medium", "high"] as const);
  if (priority) patch.priority = priority;
  if (b.assignedTo === null) patch.assignedTo = null;
  else if (typeof b.assignedTo === "string") {
    const [p] = await db
      .select()
      .from(profiles)
      .where(and(eq(profiles.id, b.assignedTo), eq(profiles.ownerId, a.ownerId)));
    if (!p || p.role === "tenant") return c.json({ error: "Choose a staff member." }, 400);
    patch.assignedTo = p.id;
  }
  await db.update(maintenanceRequests).set(patch).where(eq(maintenanceRequests.id, found.r.id));
  const notices: NotifyInput[] = [];
  if (status && status !== found.r.status) {
    const label = { open: "Reopened", in_progress: "Marked in progress", done: "Marked done" }[status];
    await db
      .insert(requestComments)
      .values({ requestId: found.r.id, authorId: a.id, authorName: a.name, body: `${label}.` });
    // The person who raised it hears about progress (once per status change).
    if (found.r.raisedBy && found.r.raisedBy !== a.id)
      notices.push({
        ownerId: a.ownerId,
        recipientId: found.r.raisedBy,
        kind: "request_update",
        title: `${found.r.title}: ${status === "done" ? "done" : status === "in_progress" ? "in progress" : "reopened"}`,
        body: `${label} by ${a.name || "the team"}.`,
        url: `/requests/${found.r.id}`,
        entity: "request",
        entityId: found.r.id,
        dedupe: `request_update:${found.r.id}:${status}:${Date.now()}`,
      });
  }
  if (patch.assignedTo && patch.assignedTo !== found.r.assignedTo && patch.assignedTo !== a.id)
    notices.push({
      ownerId: a.ownerId,
      recipientId: patch.assignedTo,
      kind: "request_assigned",
      title: `Assigned to you: ${found.r.title}`,
      body: `${a.name || "The owner"} asked you to look at this.`,
      url: `/requests/${found.r.id}`,
      entity: "request",
      entityId: found.r.id,
      dedupe: `request_assigned:${found.r.id}:${patch.assignedTo}:${Date.now()}`,
    });
  await logActivity(a.id, "update", "request", found.r.id);
  if (notices.length) await announce(c, notices);
  return c.json({ ok: true });
});

api.post("/requests/:id/comments", roles("owner", "staff", "tenant"), async (c) => {
  const a = actorOf(c);
  const found = await readableRequest(a, Number(c.req.param("id")));
  if (!found) return c.json({ error: "Request not found." }, 404);
  if (!found.canComment) return c.json({ error: "Only the person who raised this request can comment on it." }, 403);
  const b = await body(c);
  const text = cleanStr(b.body, 2000);
  const photo = (await validPhotoKey(a, b.photoKey)) ? (b.photoKey as string) : null;
  if (!text && !photo) return c.json({ error: "Write a comment or add a photo." }, 400);
  await db
    .insert(requestComments)
    .values({ requestId: found.r.id, authorId: a.id, authorName: a.name, body: text, photoPath: photo });
  await db.update(maintenanceRequests).set({ updatedAt: new Date() }).where(eq(maintenanceRequests.id, found.r.id));
  return c.json({ ok: true });
});

/* ---------- expenses ---------- */

api.get("/expenses", roles("owner", "staff"), async (c) => {
  const a = actorOf(c);
  const ws = await loadWorkspace(a.ownerId);
  if (!ws.props.length) return c.json({ rows: [], properties: [] });
  const where =
    a.role === "owner"
      ? inArray(
          expenses.propertyId,
          ws.props.map((p) => p.id),
        )
      : and(
          inArray(
            expenses.propertyId,
            ws.props.map((p) => p.id),
          ),
          eq(expenses.submittedBy, a.id),
        );
  const rows = await db.select().from(expenses).where(where).orderBy(desc(expenses.date), desc(expenses.id));
  const people = await db
    .select({ id: profiles.id, fullName: profiles.fullName })
    .from(profiles)
    .where(eq(profiles.ownerId, a.ownerId));
  const nameOf = new Map(people.map((p) => [p.id, p.fullName]));
  const propById = new Map(ws.props.map((p) => [p.id, p.name]));
  return c.json({
    rows: rows.map((e) => ({
      id: e.id,
      propertyId: e.propertyId,
      propertyName: propById.get(e.propertyId) ?? "",
      category: e.category,
      amount: e.amount,
      date: e.date,
      note: e.note,
      approved: e.approved,
      submittedByName: e.submittedBy ? (nameOf.get(e.submittedBy) ?? "") : "",
    })),
    properties: ws.props.map((p) => ({ id: p.id, name: p.name })),
  });
});

api.post("/expenses", roles("owner", "staff"), async (c) => {
  const a = actorOf(c);
  const b = await body(c);
  const p = await ownedProperty(a, Number(b.propertyId));
  if (!p) return c.json({ error: "Choose a property." }, 400);
  const amount = cleanInt(b.amount, 1);
  if (!amount) return c.json({ error: "Enter the amount." }, 400);
  const category = cleanStr(b.category, 40);
  if (!category) return c.json({ error: "Choose a category." }, 400);
  // A retry from the offline outbox returns the expense it already saved.
  const clientKey = offlineKey(b.clientKey);
  const replayed = async () => {
    if (!clientKey) return null;
    const [old] = await db.select().from(expenses).where(eq(expenses.clientKey, clientKey));
    if (!old) return null;
    return old.submittedBy === a.id && old.propertyId === p.id ? c.json(old) : c.json({ error: KEY_TAKEN }, 409);
  };
  const again = await replayed();
  if (again) return again;
  let e: typeof expenses.$inferSelect;
  try {
    [e] = await db
      .insert(expenses)
      .values({
        propertyId: p.id,
        category,
        amount,
        date: cleanDate(b.date) ?? todayIST(),
        note: cleanStr(b.note, 300),
        submittedBy: a.id,
        approved: a.role === "owner",
        clientKey,
      })
      .returning();
  } catch (err) {
    if (isClientKeyConflict(err)) return (await replayed()) ?? c.json({ error: KEY_TAKEN }, 409);
    throw err;
  }
  await logActivity(a.id, "create", "expense", e.id);
  if (!e.approved)
    await announce(c, [
      {
        ownerId: a.ownerId,
        recipientId: a.ownerId,
        kind: "expense_pending",
        title: `Expense to approve: ₹${amount.toLocaleString("en-IN")}`,
        body: `${category} at ${p.name} · added by ${a.name || "staff"}`,
        url: "/more/expenses",
        entity: "expense",
        entityId: e.id,
        dedupe: `expense_pending:${e.id}`,
      },
    ]);
  return c.json(e);
});

async function ownedExpense(a: Actor, id: number) {
  const [row] = await db
    .select({ e: expenses })
    .from(expenses)
    .innerJoin(properties, eq(expenses.propertyId, properties.id))
    .where(and(eq(expenses.id, id), eq(properties.ownerId, a.ownerId)));
  return row?.e;
}

api.post("/expenses/:id/approve", roles("owner"), async (c) => {
  const a = actorOf(c);
  const e = await ownedExpense(a, Number(c.req.param("id")));
  if (!e) return c.json({ error: "Expense not found." }, 404);
  await db.update(expenses).set({ approved: true }).where(eq(expenses.id, e.id));
  return c.json({ ok: true });
});

api.delete("/expenses/:id", roles("owner", "staff"), async (c) => {
  const a = actorOf(c);
  const e = await ownedExpense(a, Number(c.req.param("id")));
  if (!e) return c.json({ error: "Expense not found." }, 404);
  if (a.role === "staff" && (e.submittedBy !== a.id || e.approved))
    return c.json({ error: "Only the owner can remove this." }, 403);
  await db.delete(expenses).where(eq(expenses.id, e.id));
  return c.json({ ok: true });
});

/* ---------- invites & people ---------- */

api.get("/invites", roles("owner"), async (c) => {
  const a = actorOf(c);
  const rows = await db
    .select()
    .from(invites)
    .where(eq(invites.ownerId, a.ownerId))
    .orderBy(desc(invites.createdAt))
    .limit(50);
  const people = await db
    .select({
      id: profiles.id,
      role: profiles.role,
      fullName: profiles.fullName,
      email: profiles.email,
      lastSignInAt: users.lastSignInAt,
    })
    .from(profiles)
    .leftJoin(users, eq(users.id, profiles.id))
    .where(eq(profiles.ownerId, a.ownerId));
  // Live sessions per person: their most recent activity (seen_at slides at most hourly) and how many devices.
  const activity = await db
    .select({ userId: sessions.userId, seenAt: max(sessions.seenAt), devices: count() })
    .from(sessions)
    .innerJoin(profiles, eq(profiles.id, sessions.userId))
    .where(and(eq(profiles.ownerId, a.ownerId), gt(sessions.expiresAt, new Date())))
    .groupBy(sessions.userId);
  const live = new Map(activity.map((r) => [r.userId, r]));
  const latest = (...ds: (Date | null | undefined)[]) =>
    ds.reduce<Date | null>((m, d) => (d && (!m || d > m) ? d : m), null);
  return c.json({
    invites: rows.map((i) => ({
      id: i.id,
      role: i.role,
      name: i.name,
      token: i.token,
      expiresAt: i.expiresAt,
      createdAt: i.createdAt,
      state:
        i.claimedBy || i.claimedAt
          ? "claimed"
          : i.expiresAt < new Date()
            ? "expired"
            : i.attempts >= PIN_LIMIT
              ? "locked"
              : "valid",
    })),
    people: people
      .filter((p) => p.id !== a.id)
      .map((p) => {
        const l = live.get(p.id);
        return {
          id: p.id,
          role: p.role,
          fullName: p.fullName,
          email: p.email,
          /** Latest of their last sign-in and their last activity on a still signed-in device. */
          lastActiveAt: latest(p.lastSignInAt, l?.seenAt),
          devices: l?.devices ?? 0,
        };
      }),
  });
});

api.post("/invites", roles("owner"), async (c) => {
  const a = actorOf(c);
  try {
    if (!(await rateLimit(`invites:${a.ownerId}`, 20, 60 * 60_000)))
      return c.json({ error: "Too many invites. Try again later." }, 429);
  } catch (e) {
    console.error("invite creation rate limit unavailable", e);
    return c.json({ error: "Invites are temporarily unavailable." }, 503);
  }
  const b = await body(c);
  const role = oneOf(b.role, ["staff", "tenant"] as const);
  if (!role) return c.json({ error: "Choose who you're inviting." }, 400);
  let tenantId: number | null = null;
  let unitId: number | null = null;
  let name = cleanStr(b.name, 80);
  if (role === "tenant") {
    const [t] = await db
      .select()
      .from(tenants)
      .where(and(eq(tenants.id, Number(b.tenantId)), eq(tenants.ownerId, a.ownerId)));
    if (!t) return c.json({ error: "Choose a tenant." }, 400);
    if (t.userId) return c.json({ error: `${t.fullName} has already joined.` }, 409);
    tenantId = t.id;
    name = t.fullName;
    const [tn] = await db
      .select()
      .from(tenancies)
      .where(and(eq(tenancies.tenantId, t.id), eq(tenancies.status, "active")));
    unitId = tn?.unitId ?? null;
  } else if (!name) return c.json({ error: "Enter the staff member's name." }, 400);
  const pin = randomPin();
  const token = randomToken();
  const [inv] = await db
    .insert(invites)
    .values({
      ownerId: a.ownerId,
      role,
      unitId,
      tenantId,
      name,
      token,
      pinHash: await hashPin(pin),
      expiresAt: new Date(Date.now() + 7 * 86400000),
    })
    .returning();
  await logActivity(a.id, "create", "invite", inv.id);
  // The PIN is returned once and never stored in plain text.
  return c.json({ id: inv.id, token, pin, role, name, expiresAt: inv.expiresAt });
});

api.delete("/invites/:id", roles("owner"), async (c) => {
  const a = actorOf(c);
  await db
    .delete(invites)
    .where(and(eq(invites.id, Number(c.req.param("id"))), eq(invites.ownerId, a.ownerId), isNull(invites.claimedAt)));
  return c.json({ ok: true });
});

registerToolRoutes(api);
registerPaymentRoutes(api);

api.notFound((c) => c.json({ error: "Not found" }, 404));
api.onError((err, c) => {
  console.error(err);
  return c.json({ error: "Something went wrong on our side. Please try again." }, 500);
});

export default api;
