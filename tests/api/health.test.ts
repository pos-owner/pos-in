/**
 * /api/health is a deep check: it answers 200 only while D1 answers, so an uptime monitor catches a broken database.
 */
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { startApp, type TestApp } from "../helpers/app.ts";
import { setBindings } from "../../worker/server/core/bindings.ts";

let app: TestApp;
before(async () => {
  app = await startApp();
});
after(async () => {
  await app.close();
});

test("health is 200 and says the database answered", async () => {
  const r = await app.call(null, "GET", "/api/health");
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { ok: true, db: true });
});

test("health is 503 when D1 is unreachable, and recovers when it is back", async () => {
  const bindings = { DB: app.d1, CRON_SECRET: "test-cron-secret", SIGNING_SECRET: "test-signing-secret" };
  const broken = {
    prepare() {
      throw new Error("D1 is down");
    },
  };
  setBindings({ ...bindings, DB: broken as never });
  try {
    const r = await app.call(null, "GET", "/api/health");
    assert.equal(r.status, 503);
    assert.deepEqual(r.body, { ok: false, db: false });
  } finally {
    setBindings(bindings as never);
  }
  assert.equal((await app.call(null, "GET", "/api/health")).status, 200);
});
