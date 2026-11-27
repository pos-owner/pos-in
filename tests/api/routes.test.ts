/**
 * Route tests for the server core: workspace isolation, invites, payment confirmation and tenancy dates.
 * Runs the real API against an in-memory database (see tests/helpers/app.ts).
 */
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { startApp, type Client, type TestApp } from "../helpers/app.ts";
import { addDays, addMonths, monthOf, todayIST } from "../../worker/server/core/util.ts";

let app: TestApp;
let owner: Client;
let tenant: Client;
let unitIds: number[] = [];
let tenantId = 0;
let tenancyId = 0;
const today = todayIST();
const cur = monthOf(today);

async function tenancyOf(tid: number) {
  const r = await owner.get(`/api/tenants/${tid}`);
  assert.equal(r.status, 200);
  return r.body.tenancies[0] as { id: number; status: string; endDate: string | null; moveOutDate: string | null };
}

before(async () => {
  app = await startApp();
  owner = app.signIn({ id: "owner-1", email: "owner@example.in", name: "Asha" });
  assert.equal((await owner.post("/api/onboard", { fullName: "Asha" })).status, 200);
  const p = await owner.post("/api/properties", { name: "Lakshmi Nilaya" });
  for (const label of ["G-1", "F-1", "T-1"]) {
    const u = await owner.post("/api/units", { propertyId: p.body.id, label, baseRent: 10000 });
    unitIds.push(u.body.id);
  }
  const t = await owner.post("/api/tenants", {
    fullName: "Ravi",
    unitId: unitIds[0],
    rent: 10000,
    dueDay: 5,
    startDate: `${addMonths(cur, -2)}-01`,
  });
  assert.equal(t.status, 200);
  tenantId = t.body.id;
  tenancyId = (await tenancyOf(tenantId)).id;
});

after(async () => {
  await app?.close();
});

test("onboarding twice is refused instead of creating a second workspace", async () => {
  const r = await owner.post("/api/onboard", { fullName: "Asha", seed: true });
  assert.equal(r.status, 409);
});

test("an older unused invite can't move a tenant record to someone else", async () => {
  const first = await owner.post("/api/invites", { role: "tenant", tenantId });
  const second = await owner.post("/api/invites", { role: "tenant", tenantId });
  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  tenant = app.signIn({ id: "tenant-1", email: "ravi@example.in", name: "Ravi" });
  assert.equal((await tenant.post(`/api/invites/${first.body.token}/claim`, { pin: first.body.pin })).status, 200);
  const intruder = app.signIn({ id: "intruder-1", email: "x@example.in", name: "X" });
  const r = await intruder.post(`/api/invites/${second.body.token}/claim`, { pin: second.body.pin });
  assert.equal(r.status, 409);
  const home = await tenant.get("/api/tenant/home");
  assert.equal(home.status, 200);
  assert.equal(home.body.tenant.id, tenantId);
});

test("a confirmation can't count the same rent twice", async () => {
  const home = await tenant.get("/api/tenant/home");
  const charge = home.body.ledger.find((r: { month: string }) => r.month === cur);
  assert.ok(charge);
  assert.equal((await tenant.post(`/api/charges/${charge.id}/payments`, { utr: "123456789012" })).status, 200);
  // Meanwhile the owner records the same rent in cash.
  assert.equal(
    (await owner.post(`/api/charges/${charge.id}/payments`, { amount: charge.balance, method: "cash" })).status,
    200,
  );
  const detail = await owner.get(`/api/charges/${charge.id}`);
  const pending = detail.body.charge.payments.find((p: { status: string }) => p.status === "pending");
  assert.ok(pending);
  assert.equal((await owner.post(`/api/payments/${pending.id}/confirm`)).status, 409);
  assert.equal((await owner.post(`/api/payments/${pending.id}/reject`)).status, 200);
  assert.equal((await owner.post(`/api/payments/${pending.id}/reject`)).status, 409);
});

test("another workspace can't read this workspace's charges", async () => {
  const other = app.signIn({ id: "owner-2", email: "other@example.in", name: "Other" });
  assert.equal((await other.post("/api/onboard", { fullName: "Other" })).status, 200);
  const ledger = await owner.get("/api/ledger");
  const any = ledger.body.rows[0];
  assert.ok(any);
  assert.equal((await other.get(`/api/charges/${any.id}`)).status, 404);
});

test("invalid unit and tenancy amounts cannot silently save defaults or partial edits", async () => {
  const [unit] = await app.sql<{ property_id: number }>("SELECT property_id FROM units WHERE id = ?", unitIds[0]);
  const base = { propertyId: unit.property_id, label: "Invalid amount" };
  for (const baseRent of ["12oops", -1, 100_000_001]) {
    assert.equal((await owner.post("/api/units", { ...base, baseRent })).status, 400);
    assert.equal((await owner.patch(`/api/units/${unitIds[0]}`, { baseRent, label: "Changed" })).status, 400);
  }
  assert.deepEqual(await app.sql("SELECT label, base_rent FROM units WHERE id = ?", unitIds[0]), [
    { label: "G-1", base_rent: 10000 },
  ]);
  assert.equal((await owner.post("/api/units", { ...base, label: "Optional rent" })).body.baseRent, 0);
  assert.equal(
    (
      await owner.post("/api/tenants", {
        fullName: "Invalid deposit",
        unitId: unitIds[1],
        startDate: today,
        rent: 9000,
        deposit: "typo",
      })
    ).status,
    400,
  );
  assert.equal((await owner.patch(`/api/tenancies/${tenancyId}`, { rent: "typo", deposit: 4000 })).status, 400);
  assert.equal((await owner.patch(`/api/tenancies/${tenancyId}`, { rent: 9000, deposit: -100 })).status, 400);
  assert.deepEqual(await app.sql("SELECT rent, deposit FROM tenancies WHERE id = ?", tenancyId), [
    { rent: 10000, deposit: 0 },
  ]);
});

test("a nonexistent date is rejected while a leap day is accepted", async () => {
  const path = `/api/tenancies/${tenancyId}`;
  assert.equal((await owner.patch(path, { endDate: "2099-02-29" })).status, 400);
  assert.equal((await owner.patch(path, { endDate: "2104-02-29" })).status, 200);
  assert.equal((await tenancyOf(tenantId)).endDate, "2104-02-29");
  assert.equal((await owner.patch(path, { endDate: null })).status, 200);
});

test("a malformed end date is rejected instead of clearing the lease end", async () => {
  assert.equal((await owner.patch(`/api/tenancies/${tenancyId}`, { endDate: "soon" })).status, 400);
  assert.equal((await owner.patch(`/api/tenancies/${tenancyId}`, { endDate: "2000-01-01" })).status, 400);
});

test("a future move-out keeps the tenancy running until then", async () => {
  const end = addDays(today, 10);
  const r = await owner.post(`/api/tenancies/${tenancyId}/end`, { endDate: end });
  assert.equal(r.status, 200);
  assert.equal(r.body.scheduled, true);
  const tn = await tenancyOf(tenantId);
  assert.equal(tn.status, "active");
  // The move-out has its own column; the lease end date is left alone (a lease end alone is a holdover).
  assert.equal(tn.moveOutDate, end);
  assert.equal(tn.endDate, null);
});

test("a past move-out removes untouched charges for the months after it", async () => {
  const t = await owner.post("/api/tenants", {
    fullName: "Meera",
    unitId: unitIds[1],
    rent: 8000,
    dueDay: 5,
    startDate: `${addMonths(cur, -3)}-01`,
  });
  const tn = await tenancyOf(t.body.id);
  const r = await owner.post(`/api/tenancies/${tn.id}/end`, { endDate: `${addMonths(cur, -2)}-15` });
  assert.equal(r.status, 200);
  assert.equal(r.body.removedCharges, 2);
  const detail = await owner.get(`/api/tenants/${t.body.id}`);
  const months = detail.body.ledger.map((x: { month: string }) => x.month).sort();
  assert.deepEqual(months, [addMonths(cur, -3), addMonths(cur, -2)]);
  assert.equal((await owner.post(`/api/tenancies/${tn.id}/end`, {})).status, 409);
});

test("rent for the move-in month isn't due before the tenancy starts", async () => {
  const t = await owner.post("/api/tenants", {
    fullName: "Tenzin",
    unitId: unitIds[2],
    rent: 9000,
    dueDay: 1,
    startDate: today,
  });
  const detail = await owner.get(`/api/tenants/${t.body.id}`);
  const charge = detail.body.ledger.find((x: { month: string }) => x.month === cur);
  assert.ok(charge);
  assert.equal(charge.dueDate, today);
  assert.equal(charge.overdue, false);
});

test("an unknown automation name is a 404, including names that exist on every JS object", async () => {
  for (const name of ["nope", "constructor", "toString", "__proto__"]) {
    assert.equal((await owner.patch(`/api/automations/${name}`, { enabled: false })).status, 404, name);
  }
  assert.equal((await owner.patch("/api/automations/rent_reminders", { enabled: true })).status, 200);
});

test("0 or false is not an end date, and only null or an empty string clears it", async () => {
  const end = addDays(today, 200);
  assert.equal((await owner.patch(`/api/tenancies/${tenancyId}`, { endDate: end })).status, 200);
  assert.equal((await owner.patch(`/api/tenancies/${tenancyId}`, { endDate: 0 })).status, 400);
  assert.equal((await owner.patch(`/api/tenancies/${tenancyId}`, { endDate: false })).status, 400);
  assert.equal((await tenancyOf(tenantId)).endDate, end, "the lease end date is still there");
  assert.equal((await owner.patch(`/api/tenancies/${tenancyId}`, { endDate: null })).status, 200);
  assert.equal((await tenancyOf(tenantId)).endDate, null);
});

test("a tenant's unusable payment amount is refused instead of paying the whole balance", async () => {
  const home = await tenant.get("/api/tenant/home");
  const charge = home.body.outstanding.find((r: { pending: number }) => r.pending === 0);
  assert.ok(charge);
  for (const amount of [0, -5, "abc"]) {
    assert.equal((await tenant.post(`/api/charges/${charge.id}/payments`, { amount })).status, 400, String(amount));
  }
  // No amount at all still means "the whole balance".
  assert.equal((await tenant.post(`/api/charges/${charge.id}/payments`, {})).status, 200);
});

test("an occupied unit is refused before any tenant record is written", async () => {
  const before = (await owner.get("/api/tenants")).body.length;
  // The unit already has an active tenant, so nothing may be created.
  const r = await owner.post("/api/tenants", { fullName: "Ghost", unitId: unitIds[0], rent: 5000, startDate: today });
  assert.equal(r.status, 409);
  assert.equal((await owner.get("/api/tenants")).body.length, before);
});
