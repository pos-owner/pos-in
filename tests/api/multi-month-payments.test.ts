/**
 * Multi-month and advance rent payments through the real API (routes → domain/payments.ts → D1 triggers).
 * Each test builds its own workspace (tag), so tests don't share balances.
 */
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { startApp, type Client, type TestApp } from "../helpers/app.ts";
import { chargeFor, setupWorkspace } from "../helpers/workspace.ts";
import { addMonths } from "../../worker/server/core/util.ts";

let app: TestApp;
let n = 0;

before(async () => {
  app = await startApp();
});
after(async () => {
  await app?.close();
});

/** A fresh workspace: rent ₹10,000 from two months ago, so three months (cur-2, cur-1, cur) are due. */
const workspace = () => setupWorkspace(app, `mm${++n}`);

async function confirmedTotals(tenancyId: number) {
  return app.sql<{ month: string; amount: number; paid: number }>(
    `select c.month, c.amount, coalesce((select sum(p.amount) from payments p where p.charge_id = c.id and p.status = 'confirmed'), 0) as paid
     from charges c where c.tenancy_id = ? order by c.month`,
    tenancyId,
  );
}

test("the owner records one payment for three months: one batch, one receipt with a month-wise breakdown", async () => {
  const w = await workspace();
  const r = await w.owner.post(`/api/tenancies/${w.tenancyId}/payments`, {
    amount: 30000,
    method: "bank",
    utr: "NEFT123",
    clientKey: "rec-three-months",
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.months, 3);
  assert.equal(r.body.amount, 30000);
  assert.equal(r.body.paymentIds.length, 3);
  for (const m of [addMonths(w.cur, -2), addMonths(w.cur, -1), w.cur]) {
    const c = await chargeFor(w.owner, w.tenancyId, m);
    assert.equal(c.status, "paid", m);
  }
  // Exactly one receipt, reachable from every month of the batch.
  const docs = await app.sql("select id from documents where batch_id = ?", r.body.batchId);
  assert.equal(docs.length, 1);
  const numbers = new Set<string>();
  for (const id of r.body.paymentIds) {
    const issued = await w.owner.post(`/api/payments/${id}/receipt`);
    assert.equal(issued.status, 200);
    numbers.add(issued.body.number);
    const model = await w.owner.get(`/api/payments/${id}/receipt.json`);
    assert.equal(model.status, 200);
    assert.equal(model.body.amount, 30000);
    assert.equal(model.body.lines.length, 3);
    assert.equal(model.body.month, addMonths(w.cur, -2));
    assert.equal(model.body.monthTo, w.cur);
    assert.equal(model.body.balance, 0);
  }
  assert.equal(numbers.size, 1);
  // The tenant sees the same single receipt with the batch total.
  const mine = await w.tenant.get("/api/receipts");
  assert.equal(mine.body.length, 1);
  assert.equal(mine.body[0].amount, 30000);
  assert.equal(mine.body[0].months, 3);
  // The ledger tells each month it is part of a bigger payment.
  const c = await chargeFor(w.owner, w.tenancyId, w.cur);
  const full = await w.owner.get(`/api/charges/${c.id}`);
  assert.equal(full.body.charge.payments[0].batch.amount, 30000);
  assert.equal(full.body.charge.payments[0].batch.months, 3);
});

test("a partial payment fills the oldest months and leaves the rest on the next one", async () => {
  const w = await workspace();
  const r = await w.owner.post(`/api/tenancies/${w.tenancyId}/payments`, { amount: 15000, method: "cash" });
  assert.equal(r.status, 200);
  const rows = await confirmedTotals(w.tenancyId);
  assert.deepEqual(
    rows.map((x) => x.paid),
    [10000, 5000, 0],
  );
  assert.equal((await chargeFor(w.owner, w.tenancyId, addMonths(w.cur, -1))).status, "partial");
});

test("advance rent creates the upcoming months, and they don't count as outstanding", async () => {
  const w = await workspace();
  const plan = await w.owner.get(`/api/tenancies/${w.tenancyId}/pay-plan?through=${addMonths(w.cur, 2)}`);
  assert.equal(plan.status, 200);
  assert.equal(plan.body.plan.total, 50000);
  assert.equal(plan.body.plan.lines.filter((l: { advance: boolean }) => l.advance).length, 2);
  // Previewing writes nothing.
  assert.equal((await confirmedTotals(w.tenancyId)).length, 3);

  const r = await w.owner.post(`/api/tenancies/${w.tenancyId}/payments`, {
    throughMonth: addMonths(w.cur, 2),
    method: "upi",
  });
  assert.equal(r.status, 200);
  const rows = await confirmedTotals(w.tenancyId);
  assert.equal(rows.length, 5);
  assert.ok(rows.every((x) => x.paid === x.amount));
  const dash = await w.owner.get("/api/dashboard");
  assert.equal(dash.body.outstanding, 0);
  assert.equal(dash.body.advance, 20000);
  const home = await w.tenant.get("/api/tenant/home");
  assert.equal(home.body.outstanding.length, 0);
  assert.deepEqual(
    home.body.advance.map((x: { month: string }) => x.month),
    [addMonths(w.cur, 1), addMonths(w.cur, 2)],
  );
  // The daily job leaves the months paid ahead alone.
  assert.equal(
    (await app.call(null, "POST", "/api/cron/daily", undefined, { "x-cron-secret": "test-cron-secret" })).status,
    200,
  );
  assert.equal((await confirmedTotals(w.tenancyId)).length, 5);
});

test("overpayment is refused with the most that can be paid; nothing is written", async () => {
  const w = await workspace();
  await w.owner.patch("/api/automations/advance_rent", { enabled: true, config: { maxMonthsAhead: 2 } });
  const r = await w.owner.post(`/api/tenancies/${w.tenancyId}/payments`, { amount: 50001, method: "cash" });
  assert.equal(r.status, 400);
  assert.equal(r.body.code, "over_max");
  assert.equal(r.body.max, 50000);
  assert.equal((await confirmedTotals(w.tenancyId)).length, 3);
  const none = await app.sql("select id from payment_batches where tenancy_id = ?", w.tenancyId);
  assert.equal(none.length, 0);
});

test("advance rent stops at the lease end", async () => {
  const w = await workspace();
  assert.equal(
    (await w.owner.patch(`/api/tenancies/${w.tenancyId}`, { endDate: `${addMonths(w.cur, 1)}-15` })).status,
    200,
  );
  const plan = await w.owner.get(`/api/tenancies/${w.tenancyId}/pay-plan`);
  assert.deepEqual(
    plan.body.months.map((m: { month: string }) => m.month),
    [addMonths(w.cur, -2), addMonths(w.cur, -1), w.cur, addMonths(w.cur, 1)],
  );
  const r = await w.owner.post(`/api/tenancies/${w.tenancyId}/payments`, {
    throughMonth: addMonths(w.cur, 2),
    method: "cash",
  });
  assert.equal(r.status, 400);
  assert.equal(r.body.code, "beyond_limit");
});

test("the same submission sent twice (or twice at once) is saved once", async () => {
  const w = await workspace();
  const send = () =>
    w.owner.post(`/api/tenancies/${w.tenancyId}/payments`, { amount: 20000, method: "cash", clientKey: "tap-123456" });
  const [a, b] = await Promise.all([send(), send()]);
  assert.equal(a.status, 200);
  assert.equal(b.status, 200);
  assert.equal(a.body.batchId, b.body.batchId);
  assert.equal([a.body.duplicate, b.body.duplicate].filter(Boolean).length, 1);
  const later = await send();
  assert.equal(later.status, 200);
  assert.equal(later.body.duplicate, true);
  assert.equal(later.body.batchId, a.body.batchId);
  const rows = await confirmedTotals(w.tenancyId);
  assert.equal(
    rows.reduce((s, x) => s + x.paid, 0),
    20000,
  );
  const batches = await app.sql("select id from payment_batches where tenancy_id = ?", w.tenancyId);
  assert.equal(batches.length, 1);
});

test("two different payments for everything that's due, at once: one lands, nothing is overpaid", async () => {
  const w = await workspace();
  // "Everything up to this month", not a rupee amount: the owner may always pay ahead, so a fixed amount planned
  // after the first payment landed would correctly go to the coming months instead and also succeed.
  const pay = (k: string) =>
    w.owner.post(`/api/tenancies/${w.tenancyId}/payments`, { throughMonth: w.cur, method: "cash", clientKey: k });
  const rs = await Promise.all([pay("race-a-0001"), pay("race-b-0001"), pay("race-c-0001")]);
  assert.equal(rs.filter((r) => r.status === 200).length, 1, JSON.stringify(rs.map((r) => r.body)));
  for (const r of rs.filter((x) => x.status !== 200)) assert.ok([400, 409].includes(r.status));
  const rows = await confirmedTotals(w.tenancyId);
  assert.ok(rows.every((x) => x.paid <= x.amount));
  assert.equal(
    rows.reduce((s, x) => s + x.paid, 0),
    30000,
  );
  // Every batch that exists is complete: no half-written payment.
  const orphan = await app.sql(
    "select b.id from payment_batches b where b.tenancy_id = ? and b.amount <> (select sum(amount) from payments where batch_id = b.id)",
    w.tenancyId,
  );
  assert.equal(orphan.length, 0);
});

test("a multi-month payment racing a single-month cash entry never overpays a month", async () => {
  const w = await workspace();
  const c = await chargeFor(w.owner, w.tenancyId, addMonths(w.cur, -2));
  const rs = await Promise.all([
    w.owner.post(`/api/tenancies/${w.tenancyId}/payments`, { throughMonth: w.cur, method: "bank" }),
    w.owner.post(`/api/charges/${c.id}/payments`, { amount: 10000, method: "cash" }),
  ]);
  assert.ok(rs.some((r) => r.status === 200));
  const rows = await confirmedTotals(w.tenancyId);
  assert.ok(
    rows.every((x) => x.paid <= x.amount),
    JSON.stringify(rows),
  );
});

test("a tenant reports a multi-month payment; the owner confirms it once from any of its months", async () => {
  const w = await workspace();
  const r = await w.tenant.post(`/api/tenancies/${w.tenancyId}/payments`, {
    throughMonth: w.cur,
    utr: "533120984467",
    clientKey: "tenant-claim-1",
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.status, "pending");
  assert.equal((await chargeFor(w.owner, w.tenancyId, w.cur)).status, "awaiting");
  // Reporting again is refused while the claim waits.
  const twice = await w.tenant.post(`/api/tenancies/${w.tenancyId}/payments`, { throughMonth: w.cur });
  assert.equal(twice.status, 409);
  // The single-month "I paid" is refused too.
  const c = await chargeFor(w.owner, w.tenancyId, w.cur);
  assert.equal((await w.tenant.post(`/api/charges/${c.id}/payments`, {})).status, 409);

  const [first, second] = await Promise.all([
    w.owner.post(`/api/payments/${r.body.paymentIds[2]}/confirm`),
    w.owner.post(`/api/payments/${r.body.paymentIds[0]}/confirm`),
  ]);
  assert.deepEqual([first.status, second.status].sort(), [200, 409]);
  const rows = await confirmedTotals(w.tenancyId);
  assert.ok(rows.every((x) => x.paid === x.amount));
  const docs = await app.sql("select id from documents where batch_id = ?", r.body.batchId);
  assert.equal(docs.length, 1);
});

test("confirming a claim that no longer fits confirms none of its months", async () => {
  const w = await workspace();
  const r = await w.tenant.post(`/api/tenancies/${w.tenancyId}/payments`, { amount: 30000 });
  assert.equal(r.status, 200);
  // Meanwhile the owner records cash for the middle month.
  const mid = await chargeFor(w.owner, w.tenancyId, addMonths(w.cur, -1));
  assert.equal((await w.owner.post(`/api/charges/${mid.id}/payments`, { amount: 10000, method: "cash" })).status, 200);
  const res = await w.owner.post(`/api/payments/${r.body.paymentIds[0]}/confirm`);
  assert.equal(res.status, 409);
  const statuses = await app.sql<{ status: string }>("select status from payments where batch_id = ?", r.body.batchId);
  assert.ok(statuses.every((s) => s.status === "pending"));
  // "Not received" rejects the whole claim, then it can be removed.
  assert.equal((await w.owner.post(`/api/payments/${r.body.paymentIds[1]}/reject`)).status, 200);
  const rejected = await app.sql<{ status: string }>("select status from payments where batch_id = ?", r.body.batchId);
  assert.ok(rejected.every((s) => s.status === "rejected"));
  assert.equal((await w.owner.del(`/api/payments/${r.body.paymentIds[0]}`)).status, 200);
  assert.equal((await app.sql("select id from payment_batches where id = ?", r.body.batchId)).length, 0);
  assert.equal((await app.sql("select id from payments where batch_id = ?", r.body.batchId)).length, 0);
});

test("voiding a multi-month payment voids every month and keeps the receipt, marked void", async () => {
  const w = await workspace();
  const r = await w.owner.post(`/api/tenancies/${w.tenancyId}/payments`, { amount: 25000, method: "cash" });
  assert.equal(r.status, 200);
  const paymentId = r.body.paymentIds[0];
  const original = await w.owner.get(`/api/payments/${paymentId}/receipt.json`);
  assert.equal(original.status, 200);
  const path = `/api${new URL(original.body.verifyUrl).pathname}`;
  const valid = await app.call(null, "GET", path);
  assert.equal(valid.status, 200);
  assert.match(valid.headers.get("cache-control") ?? "", /no-store/);
  assert.equal(valid.body.voided, false);
  assert.equal(valid.body.voidedOn, null);
  assert.equal(valid.body.amount, 25000);
  assert.equal(valid.body.method, "cash");
  assert.equal(valid.body.months, 3);
  assert.equal(valid.body.issuedOn, original.body.issuedOn);
  assert.ok(Number.isFinite(Date.parse(valid.body.checkedAt)));
  assert.equal((await w.owner.post(`/api/payments/${r.body.paymentIds[1]}/void`, { reason: "" })).status, 400);
  const v = await w.owner.post(`/api/payments/${r.body.paymentIds[1]}/void`, { reason: "Entered twice" });
  assert.equal(v.status, 200);
  const rows = await confirmedTotals(w.tenancyId);
  assert.ok(rows.every((x) => x.paid === 0));
  const voided = await app.sql<{ status: string; void_reason: string }>(
    "select status, void_reason from payments where batch_id = ?",
    r.body.batchId,
  );
  assert.ok(voided.every((x) => x.status === "void" && x.void_reason === "Entered twice"));
  const model = await w.owner.get(`/api/payments/${r.body.paymentIds[0]}/receipt.json`);
  assert.equal(model.status, 200);
  assert.equal(model.body.voided, true);
  const checkedAgain = await app.call(null, "GET", path);
  assert.equal(checkedAgain.status, 200);
  assert.equal(checkedAgain.body.voided, true);
  assert.ok(checkedAgain.body.voidedOn);
  // Void rows can't be deleted or voided again.
  assert.equal((await w.owner.del(`/api/payments/${r.body.paymentIds[0]}`)).status, 409);
  assert.equal((await w.owner.post(`/api/payments/${r.body.paymentIds[0]}/void`, { reason: "x" })).status, 409);
});

test("tenants can't pay ahead when the owner switches advance rent off; the owner still can", async () => {
  const w = await workspace();
  assert.equal((await w.owner.patch("/api/automations/advance_rent", { enabled: false })).status, 200);
  const plan = await w.tenant.get(`/api/tenancies/${w.tenancyId}/pay-plan`);
  assert.equal(plan.body.maxMonthsAhead, 0);
  assert.ok(plan.body.months.every((m: { advance: boolean }) => !m.advance));
  const t = await w.tenant.post(`/api/tenancies/${w.tenancyId}/payments`, { throughMonth: addMonths(w.cur, 1) });
  assert.equal(t.status, 400);
  const o = await w.owner.post(`/api/tenancies/${w.tenancyId}/payments`, {
    throughMonth: addMonths(w.cur, 1),
    method: "cash",
  });
  assert.equal(o.status, 200);
});

test("bad input is refused: no amount, a future date, an unknown method", async () => {
  const w = await workspace();
  const url = `/api/tenancies/${w.tenancyId}/payments`;
  assert.equal((await w.owner.post(url, { method: "cash" })).status, 400);
  assert.equal((await w.owner.post(url, { amount: "abc", method: "cash" })).status, 400);
  assert.equal((await w.owner.post(url, { amount: 100, method: "cheque" })).status, 400);
  assert.equal((await w.owner.post(url, { amount: 100, method: "cash", paidOn: "2999-01-01" })).status, 400);
  assert.equal((await w.owner.post(url, { throughMonth: "2026-13x", method: "cash" })).status, 400);
});

test("only the owner and the tenant on the tenancy can see or pay; other workspaces get nothing", async () => {
  const w = await workspace();
  const other = await workspace();
  const url = `/api/tenancies/${w.tenancyId}/payments`;
  // Another landlord, and their tenant.
  assert.equal((await other.owner.get(`/api/tenancies/${w.tenancyId}/pay-plan`)).status, 404);
  assert.equal((await other.owner.post(url, { amount: 100, method: "cash" })).status, 404);
  assert.equal((await other.tenant.post(url, { amount: 100 })).status, 404);
  // A second tenant in the same workspace.
  const t2 = await w.owner.post("/api/tenants", {
    fullName: "Meera",
    unitId: w.unitIds[1],
    rent: 8000,
    dueDay: 5,
    startDate: `${w.cur}-01`,
  });
  const inv = await w.owner.post("/api/invites", { role: "tenant", tenantId: t2.body.id });
  const meera: Client = app.signIn({ id: `meera-${n}`, email: `meera${n}@example.in`, name: "Meera" });
  assert.equal((await meera.post(`/api/invites/${inv.body.token}/claim`, { pin: inv.body.pin })).status, 200);
  assert.equal((await meera.get(`/api/tenancies/${w.tenancyId}/pay-plan`)).status, 404);
  assert.equal((await meera.post(url, { amount: 100 })).status, 404);
  // Staff never handle rent.
  const inv2 = await w.owner.post("/api/invites", { role: "staff", name: "Raju" });
  const staff = app.signIn({ id: `staff-${n}`, email: `staff${n}@example.in`, name: "Raju" });
  assert.equal((await staff.post(`/api/invites/${inv2.body.token}/claim`, { pin: inv2.body.pin })).status, 200);
  assert.equal((await staff.get(`/api/tenancies/${w.tenancyId}/pay-plan`)).status, 403);
  assert.equal((await staff.post(url, { amount: 100, method: "cash" })).status, 403);
  // Another workspace can't act on this workspace's batch through the per-payment routes.
  const r = await w.owner.post(url, { amount: 20000, method: "cash" });
  assert.equal((await other.owner.post(`/api/payments/${r.body.paymentIds[0]}/void`, { reason: "x" })).status, 404);
  assert.equal((await other.owner.get(`/api/payments/${r.body.paymentIds[0]}/receipt.json`)).status, 404);
  assert.equal((await other.tenant.get(`/api/payments/${r.body.paymentIds[0]}/receipt.json`)).status, 404);
  // A client key used in one workspace doesn't collide with another's.
  const k = { amount: 1000, method: "cash", clientKey: "shared-key-1" };
  assert.equal((await w.owner.post(url, k)).status, 200);
  const mine = await other.owner.post(`/api/tenancies/${other.tenancyId}/payments`, k);
  assert.equal(mine.status, 200);
  assert.equal(mine.body.duplicate, false);
});

test("the database itself refuses an overpaid month and a month from another tenancy", async () => {
  const w = await workspace();
  const c = await chargeFor(w.owner, w.tenancyId, w.cur);
  await assert.rejects(
    app.run(
      "insert into payments (charge_id, amount, method, status, paid_on, created_at) values (?, ?, 'cash', 'confirmed', '2026-01-01', 0)",
      c.id,
      c.amount + 1,
    ),
    /pos:payment_exceeds_due/,
  );
  const pend = await app.sql<{ id: number }>(
    "insert into payments (charge_id, amount, method, status, paid_on, created_at) values (?, ?, 'cash', 'pending', '2026-01-01', 0) returning id",
    c.id,
    c.amount,
  );
  await app.run(
    "insert into payments (charge_id, amount, method, status, paid_on, created_at) values (?, 1, 'cash', 'confirmed', '2026-01-01', 0)",
    c.id,
  );
  await assert.rejects(
    app.run("update payments set status = 'confirmed' where id = ?", pend[0].id),
    /pos:payment_exceeds_due/,
  );
  const other = await workspace();
  const [b] = await app.sql<{ id: number }>(
    "insert into payment_batches (owner_id, tenancy_id, client_key, amount, months, method, paid_on, created_at) values (?, ?, 'k-x', 1, 1, 'cash', '2026-01-01', 0) returning id",
    `owner-mm${n}`,
    other.tenancyId,
  );
  await assert.rejects(
    app.run(
      "insert into payments (charge_id, amount, method, status, paid_on, created_at, batch_id) values (?, 1, 'cash', 'confirmed', '2026-01-01', 0, ?)",
      c.id,
      b.id,
    ),
    /pos:payment_wrong_tenancy/,
  );
});

test("removing a unit with multi-month payments on it still works (no dangling batch)", async () => {
  const w = await workspace();
  assert.equal(
    (await w.owner.post(`/api/tenancies/${w.tenancyId}/payments`, { amount: 20000, method: "cash" })).status,
    200,
  );
  await app.run("delete from units where id = ?", w.unitIds[0]);
  assert.equal((await app.sql("select id from payment_batches where tenancy_id = ?", w.tenancyId)).length, 0);
});
