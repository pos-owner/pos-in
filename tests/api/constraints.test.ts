/**
 * Database CHECK constraints: the demo data satisfies them, every rule refuses a bad value and every value the app
 * writes is accepted.
 */
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { startApp, type TestApp } from "../helpers/app.ts";

let app: TestApp;
const OWNER = "owner-seeded";

before(async () => {
  app = await startApp();
  const owner = app.signIn({ id: OWNER, email: "seed@example.in", name: "Asha" });
  // The demo workspace writes every kind of row the app knows; it must load under the constraints.
  const r = await owner.post("/api/onboard", { fullName: "Asha", seed: true });
  assert.equal(r.status, 200);
  assert.equal(r.body.seeded, true, "demo data failed to load");
});

after(async () => {
  await app?.close();
});

/** Runs one statement and returns the CHECK constraint that refused it (SQLite names it in the message). */
async function refusedBy(sql: string): Promise<string> {
  try {
    await app.run(sql);
  } catch (e) {
    const message = (e as Error).message;
    const m = /CHECK constraint failed: ([a-z_]+)/.exec(message);
    assert.ok(m, message);
    return m[1];
  }
  assert.fail(`accepted: ${sql}`);
}

test("the demo workspace satisfies every constraint", async () => {
  const [r] = await app.sql<{ n: number }>("select count(*) as n from payments");
  assert.ok(r.n > 0);
});

test("unknown roles and statuses are refused", async () => {
  const cases: [string, string][] = [
    [`update profiles set role = 'admin' where id = '${OWNER}'`, "profiles_role_check"],
    ["update tenancies set status = 'paused' where id = (select min(id) from tenancies)", "tenancies_status_check"],
    ["update payments set status = 'refunded' where id = (select min(id) from payments)", "payments_status_check"],
    ["update payments set method = 'cheque' where id = (select min(id) from payments)", "payments_method_check"],
    [
      "update maintenance_requests set status = 'closed' where id = (select min(id) from maintenance_requests)",
      "maintenance_requests_status_check",
    ],
    [
      "update meter_readings set status = 'rejected' where id = (select min(id) from meter_readings)",
      "meter_readings_status_check",
    ],
  ];
  for (const [sql, name] of cases) assert.equal(await refusedBy(sql), name, sql);
});

test("impossible amounts and days are refused", async () => {
  const cases: [string, string][] = [
    ["update payments set amount = 0 where id = (select min(id) from payments)", "payments_amount_check"],
    ["update payments set amount = -100 where id = (select min(id) from payments)", "payments_amount_check"],
    ["update charges set amount = -1 where id = (select min(id) from charges)", "charges_amount_check"],
    ["update tenancies set rent = 0 where id = (select min(id) from tenancies)", "tenancies_rent_check"],
    ["update tenancies set due_day = 0 where id = (select min(id) from tenancies)", "tenancies_due_day_check"],
    ["update tenancies set due_day = 29 where id = (select min(id) from tenancies)", "tenancies_due_day_check"],
    ["update units set base_rent = -1 where id = (select min(id) from units)", "units_base_rent_check"],
    [
      "update meter_readings set usage = -0.5 where id = (select min(id) from meter_readings)",
      "meter_readings_usage_check",
    ],
    [
      "update meter_readings set amount = -1 where id = (select min(id) from meter_readings)",
      "meter_readings_amount_check",
    ],
  ];
  for (const [sql, name] of cases) assert.equal(await refusedBy(sql), name, sql);
});

test("values the app uses are accepted", async () => {
  for (const stmt of [
    "update tenancies set due_day = 28 where id = (select min(id) from tenancies)",
    "update tenancies set due_day = 1 where id = (select min(id) from tenancies)",
    "update units set base_rent = 0 where id = (select min(id) from units)",
    "update meter_readings set usage = null where id = (select min(id) from meter_readings)",
    "update charges set amount = 0 where id = (select max(id) from charges where id not in (select charge_id from payments))",
  ])
    await app.run(stmt);
});
