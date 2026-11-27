/**
 * Meter bills on the rent: applying and removing a bill is one statement (the link change on `meter_readings`, with
 * triggers moving the amount on the charge), repeats and races change the charge once, and a bill can't be removed
 * when that would leave the rent overpaid. Runs on Miniflare's D1, the same SQLite engine as production.
 */
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { startApp, type Client, type TestApp } from "../helpers/app.ts";
import { chargeFor, setupWorkspace } from "../helpers/workspace.ts";

let app: TestApp;
let owner: Client;
let unitId = 0;
let tenancyId = 0;
let cur = "";

before(async () => {
  app = await startApp();
  const ws = await setupWorkspace(app);
  ({ owner, tenancyId, cur } = ws);
  unitId = ws.unitIds[0];
  // First reading: usage 0, no bill. Every later one uses 100 kWh at the default ₹8, a ₹800 bill.
  const first = await owner.post("/api/meters", { unitId, kind: "electricity", reading: 1000, addToRent: false });
  assert.equal(first.status, 200);
});

after(async () => {
  await app?.close();
});

/** Saves a ₹800 reading (100 kWh above the latest one still on record) without adding it to the rent. */
async function newReading() {
  const [last] = await app.sql<{ m: number }>("select max(reading) as m from meter_readings where unit_id = ?", unitId);
  const meter = last.m + 100;
  const r = await owner.post("/api/meters", { unitId, kind: "electricity", reading: meter, addToRent: false });
  assert.equal(r.status, 200);
  assert.equal(r.body.amount, 800);
  assert.equal(r.body.applied, false);
  return r.body.id as number;
}

const charge = () => chargeFor(owner, tenancyId, cur);
const statuses = (rs: { status: number }[]) => rs.map((r) => r.status).sort();

async function linkedCharge(readingId: number) {
  const [r] = await app.sql<{ charge_id: number | null }>(
    "select charge_id from meter_readings where id = ?",
    readingId,
  );
  return r ? r.charge_id : undefined;
}

test("applying the same bill twice adds it once", async () => {
  const before = await charge();
  const id = await newReading();
  assert.equal((await owner.post(`/api/meters/${id}/apply`)).status, 200);
  assert.equal((await owner.post(`/api/meters/${id}/apply`)).status, 409);
  const after = await charge();
  assert.equal(after.amount, before.amount + 800);
  assert.equal(after.extra, before.extra + 800);
  assert.equal(await linkedCharge(id), after.id);
});

test("two applies at once add the bill once", async () => {
  const before = await charge();
  const id = await newReading();
  const rs = await Promise.all([owner.post(`/api/meters/${id}/apply`), owner.post(`/api/meters/${id}/apply`)]);
  assert.deepEqual(statuses(rs), [200, 409]);
  const after = await charge();
  assert.equal(after.amount, before.amount + 800);
  assert.equal(after.extra, before.extra + 800);
});

test("deleting a billed reading twice at once takes the bill off once", async () => {
  const id = await newReading();
  assert.equal((await owner.post(`/api/meters/${id}/apply`)).status, 200);
  const before = await charge();
  const rs = await Promise.all([owner.del(`/api/meters/${id}`), owner.del(`/api/meters/${id}`)]);
  assert.deepEqual(statuses(rs), [200, 404]);
  const after = await charge();
  assert.equal(after.amount, before.amount - 800);
  assert.equal(after.extra, before.extra - 800);
  assert.equal(await linkedCharge(id), undefined, "the reading is gone");
});

/** Makes every change to a charge's amount fail, after the reading's link has been written in the same statement. */
const FAIL_TRIGGER =
  "create trigger pos_test_fail before update of amount on charges begin select raise(abort, 'boom'); end";

test("a failure half-way through leaves no partial state", async () => {
  const id = await newReading();
  await app.run(FAIL_TRIGGER);
  try {
    const before = await charge();
    assert.equal((await owner.post(`/api/meters/${id}/apply`)).status, 500);
    assert.equal(await linkedCharge(id), null, "the link was rolled back");
    assert.equal((await charge()).amount, before.amount);
  } finally {
    await app.run("drop trigger pos_test_fail");
  }
  assert.equal((await owner.post(`/api/meters/${id}/apply`)).status, 200);
  const billed = await charge();
  await app.run(FAIL_TRIGGER);
  try {
    assert.equal((await owner.del(`/api/meters/${id}`)).status, 500);
    assert.equal(await linkedCharge(id), billed.id, "the reading and its link are still there");
    assert.equal((await charge()).amount, billed.amount);
  } finally {
    await app.run("drop trigger pos_test_fail");
  }
  assert.equal((await owner.del(`/api/meters/${id}`)).status, 200);
});

test("a bill can be removed after a partial payment that still fits", async () => {
  const id = await newReading();
  assert.equal((await owner.post(`/api/meters/${id}/apply`)).status, 200);
  const billed = await charge();
  const pay = await owner.post(`/api/charges/${billed.id}/payments`, { amount: 5000, method: "cash" });
  assert.equal(pay.status, 200);
  assert.equal((await owner.del(`/api/meters/${id}`)).status, 200);
  const after = await charge();
  assert.equal(after.amount, billed.amount - 800);
  assert.equal(after.paid, 5000);
});

test("a bill can't be removed when the rent would end up overpaid", async () => {
  const id = await newReading();
  assert.equal((await owner.post(`/api/meters/${id}/apply`)).status, 200);
  const billed = await charge();
  const pay = await owner.post(`/api/charges/${billed.id}/payments`, { amount: billed.balance, method: "bank" });
  assert.equal(pay.status, 200);
  const r = await owner.del(`/api/meters/${id}`);
  assert.equal(r.status, 409);
  assert.match(r.body.error, /Void the payment first/);
  const after = await charge();
  assert.equal(after.amount, billed.amount, "nothing changed");
  assert.equal(after.extra, billed.extra);
  assert.equal(after.status, "paid");
  assert.equal(await linkedCharge(id), billed.id, "the reading is still on the rent");
});
