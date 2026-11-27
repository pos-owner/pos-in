/**
 * Payments that race: confirmations, owner-recorded payments and tenant "I paid" taps fired at the same charge
 * with Promise.all.
 *
 * D1 has no interactive transactions, so the guarantee comes from single guarded statements (`insertPaymentIfDue`,
 * `settlePendingPayment` in domain/data.ts) that check the balance and write in one step. Miniflare runs the same
 * SQLite engine as D1 and serialises statements the same way, so these tests exercise that guarantee directly.
 */
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { startApp, type Client, type TestApp } from "../helpers/app.ts";
import { chargeFor, setupWorkspace } from "../helpers/workspace.ts";
import { addMonths } from "../../worker/server/core/util.ts";

let app: TestApp;
let owner: Client;
let tenant: Client;
let tenancyId = 0;
let cur = "";

before(async () => {
  app = await startApp();
  ({ owner, tenant, tenancyId, cur } = await setupWorkspace(app));
});

after(async () => {
  await app?.close();
});

async function confirmedTotal(chargeId: number) {
  const [r] = await app.sql<{ s: number }>(
    "select coalesce(sum(amount), 0) as s from payments where charge_id = ? and status = 'confirmed'",
    chargeId,
  );
  return r.s;
}

async function pendingPayment(chargeId: number, amount: number) {
  const [r] = await app.sql<{ id: number }>(
    "insert into payments (charge_id, amount, method, status, paid_on, created_at) values (?, ?, 'upi', 'pending', date('now'), ?) returning id",
    chargeId,
    amount,
    Date.now(),
  );
  return r.id;
}

const statuses = (rs: { status: number }[]) => rs.map((r) => r.status).sort();

test("two pending payments for the full balance confirmed at once: exactly one succeeds", async () => {
  const charge = await chargeFor(owner, tenancyId, addMonths(cur, -2));
  const a = await pendingPayment(charge.id, charge.balance);
  const b = await pendingPayment(charge.id, charge.balance);
  const rs = await Promise.all([owner.post(`/api/payments/${a}/confirm`), owner.post(`/api/payments/${b}/confirm`)]);
  assert.deepEqual(statuses(rs), [200, 409]);
  assert.equal(await confirmedTotal(charge.id), charge.amount);
  const after = await chargeFor(owner, tenancyId, charge.month);
  assert.equal(after.status, "paid");
});

test("the same payment confirmed twice at once is confirmed (and receipted) once", async () => {
  const charge = await chargeFor(owner, tenancyId, addMonths(cur, -1));
  const id = await pendingPayment(charge.id, 4000);
  const rs = await Promise.all([owner.post(`/api/payments/${id}/confirm`), owner.post(`/api/payments/${id}/confirm`)]);
  assert.deepEqual(statuses(rs), [200, 409]);
  assert.equal(await confirmedTotal(charge.id), 4000);
  const docs = await app.sql("select id from documents where payment_id = ?", id);
  assert.equal(docs.length, 1);
});

test("two owner-recorded payments for the full balance at once: exactly one succeeds", async () => {
  const charge = await chargeFor(owner, tenancyId, addMonths(cur, -1));
  assert.equal(charge.balance, 6000);
  const pay = () => owner.post(`/api/charges/${charge.id}/payments`, { amount: charge.balance, method: "cash" });
  const rs = await Promise.all([pay(), pay()]);
  assert.deepEqual(statuses(rs), [200, 409]);
  assert.equal(await confirmedTotal(charge.id), charge.amount);
  assert.ok((await confirmedTotal(charge.id)) <= charge.amount);
});

test("two tenant 'I paid' taps at once leave one pending payment", async () => {
  const charge = await chargeFor(owner, tenancyId, cur);
  const tap = () => tenant.post(`/api/charges/${charge.id}/payments`, { utr: "123456789012" });
  const rs = await Promise.all([tap(), tap()]);
  assert.deepEqual(statuses(rs), [200, 409]);
  const pend = await app.sql("select id from payments where charge_id = ? and status = 'pending'", charge.id);
  assert.equal(pend.length, 1);
});

test("a confirmation racing an owner cash payment never counts the rent twice", async () => {
  const charge = await chargeFor(owner, tenancyId, cur);
  const [pending] = (await owner.get(`/api/charges/${charge.id}`)).body.charge.payments.filter(
    (p: { status: string }) => p.status === "pending",
  );
  assert.ok(pending);
  const rs = await Promise.all([
    owner.post(`/api/payments/${pending.id}/confirm`),
    owner.post(`/api/charges/${charge.id}/payments`, { amount: charge.balance, method: "cash" }),
  ]);
  assert.equal(rs.filter((r) => r.status === 200).length, 1);
  assert.ok((await confirmedTotal(charge.id)) <= charge.amount);
});
