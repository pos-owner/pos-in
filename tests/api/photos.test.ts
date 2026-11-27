import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { startApp, type Client, type TestApp } from "../helpers/app.ts";
import { MAX_PHOTO_BYTES } from "../../worker/server/core/storage.ts";

let app: TestApp;
let owner: Client;
let other: Client;

/** A fake JPEG: real magic bytes, then every byte value (so base64 round-trips are exercised), then padding. */
function fakeJpeg(size: number): Uint8Array {
  const b = new Uint8Array(size);
  b.set([0xff, 0xd8, 0xff, 0xe0]);
  for (let i = 4; i < size; i++) b[i] = i % 256;
  return b;
}

before(async () => {
  app = await startApp();
  owner = app.signIn({ id: "owner-photos", email: "owner-photos@example.in", name: "Asha" });
  other = app.signIn({ id: "owner-photos-2", email: "other-photos@example.in", name: "Dev" });
  assert.equal((await owner.post("/api/onboard", { fullName: "Asha" })).status, 200);
  assert.equal((await other.post("/api/onboard", { fullName: "Dev" })).status, 200);
});

after(async () => {
  await app?.close();
});

test("a photo is stored in D1 and served back byte for byte through its signed link", async () => {
  const bytes = fakeJpeg(300_000);
  const up = await owner.upload("/api/photos", bytes, "image/jpeg");
  assert.equal(up.status, 200);
  assert.match(up.body.key, /^p_.+\.jpg$/);

  const [row] = await app.sql<{ size: number }>("select size from photo_data where key = ?", up.body.key);
  assert.equal(row.size, bytes.length);

  const res = await app.api.request(up.body.url, { headers: { "x-pos-client": "1" } });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "image/jpeg");
  assert.deepEqual(new Uint8Array(await res.arrayBuffer()), bytes);
});

test("a photo link with a bad signature is refused", async () => {
  const up = await owner.upload("/api/photos", fakeJpeg(2_000), "image/jpeg");
  const res = await app.api.request(up.body.url.replace(/sig=.*/, "sig=nope"), { headers: { "x-pos-client": "1" } });
  assert.equal(res.status, 403);
});

test("a photo at the size cap is accepted and one over it is refused", async () => {
  const ok = await owner.upload("/api/photos", fakeJpeg(MAX_PHOTO_BYTES), "image/jpeg");
  assert.equal(ok.status, 200);
  const big = await owner.upload("/api/photos", fakeJpeg(MAX_PHOTO_BYTES + 1), "image/jpeg");
  assert.equal(big.status, 413);
  const [count] = await app.sql<{ n: number }>("select count(*) as n from photo_data where size > ?", MAX_PHOTO_BYTES);
  assert.equal(count.n, 0);
});

test("someone else's photo key cannot be attached to your request", async () => {
  const up = await owner.upload("/api/photos", fakeJpeg(5_000), "image/jpeg");
  const [{ ownerId }] = await app.sql<{ ownerId: string }>(
    "select owner_id as ownerId from photo_uploads where key = ?",
    up.body.key,
  );
  assert.equal(ownerId, "owner-photos");
  const [mine] = await app.sql<{ n: number }>(
    "select count(*) as n from photo_uploads where owner_id = ?",
    "owner-photos-2",
  );
  assert.equal(mine.n, 0);
});
