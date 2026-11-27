/**
 * A ready-made workspace for API tests: one owner, one property with two units, and a tenant who has joined
 * through an invite and rents the first unit from two months ago (so there are a few charges to work with).
 * Not named *.test.ts, so it only runs through the tests that import it.
 */
import assert from "node:assert/strict";
import { addMonths, monthOf, todayIST } from "../../worker/server/core/util.ts";
import type { Client, TestApp } from "./app.ts";

export async function setupWorkspace(app: TestApp, tag = "1") {
  const owner = app.signIn({ id: `owner-${tag}`, email: `owner${tag}@example.in`, name: "Asha" });
  assert.equal((await owner.post("/api/onboard", { fullName: "Asha" })).status, 200);
  const p = await owner.post("/api/properties", { name: "Lakshmi Nilaya" });
  const unitIds: number[] = [];
  for (const label of ["G-1", "F-1"]) {
    const u = await owner.post("/api/units", { propertyId: p.body.id, label, baseRent: 10000 });
    unitIds.push(u.body.id);
  }
  const cur = monthOf(todayIST());
  const t = await owner.post("/api/tenants", {
    fullName: "Ravi",
    unitId: unitIds[0],
    rent: 10000,
    dueDay: 5,
    startDate: `${addMonths(cur, -2)}-01`,
  });
  assert.equal(t.status, 200);
  const tenantId = t.body.id as number;
  const detail = await owner.get(`/api/tenants/${tenantId}`);
  const tenancyId = detail.body.tenancies[0].id as number;
  const inv = await owner.post("/api/invites", { role: "tenant", tenantId });
  assert.equal(inv.status, 200);
  const tenant: Client = app.signIn({ id: `tenant-${tag}`, email: `ravi${tag}@example.in`, name: "Ravi" });
  assert.equal((await tenant.post(`/api/invites/${inv.body.token}/claim`, { pin: inv.body.pin })).status, 200);
  return { owner, tenant, propertyId: p.body.id as number, unitIds, tenantId, tenancyId, cur };
}

/** The tenancy's charge for `month`, straight from the ledger. */
export async function chargeFor(owner: Client, tenancyId: number, month: string) {
  const ledger = await owner.get("/api/ledger");
  const row = ledger.body.rows.find(
    (r: { tenancyId: number; month: string }) => r.tenancyId === tenancyId && r.month === month,
  );
  assert.ok(row, `no charge for ${month}`);
  return row as {
    id: number;
    month: string;
    amount: number;
    extra: number;
    balance: number;
    paid: number;
    status: string;
  };
}
