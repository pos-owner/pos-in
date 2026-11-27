import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { startApp, type Client, type TestApp } from "../helpers/app.ts";

let app: TestApp;
let owner: Client;

before(async () => {
  app = await startApp();
  owner = app.signIn({ id: "owner-rate-limit", email: "owner@example.in", name: "Asha" });
  assert.equal((await owner.post("/api/onboard", { fullName: "Asha" })).status, 200);
});

after(async () => {
  await app?.close();
});

test("invite PIN limits persist per valid invite without storing invalid tokens", async () => {
  assert.equal((await app.call(null, "POST", "/api/invites/not-a-real-token/check", { pin: "123456" })).status, 404);
  const [none] = await app.sql<{ count: number }>(
    "select count(*) as count from rate_limits where key like 'invite-pin:%'",
  );
  assert.equal(none.count, 0);

  const invite = await owner.post("/api/invites", { role: "staff", name: "Ravi" });
  assert.equal(invite.status, 200);
  const path = `/api/invites/${invite.body.token}/check`;
  assert.equal((await app.call(null, "POST", path, { pin: invite.body.pin })).status, 200);
  assert.equal((await app.call(null, "POST", path, { pin: invite.body.pin })).status, 200);

  const [counter] = await app.sql<{ key: string; count: number }>(
    "select key, count from rate_limits where key like 'invite-pin:%'",
  );
  assert.deepEqual(counter, { key: `invite-pin:${invite.body.id}`, count: 2 });
});

test("photo uploads reject declared types that do not match their bytes", async () => {
  const response = await owner.upload("/api/photos", new Uint8Array([0xff, 0xd8, 0xff]), "image/png");
  assert.equal(response.status, 415);
});
