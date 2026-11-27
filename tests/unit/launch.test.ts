/** Launch cache: what the next app launch may paint from, and when it must be ignored. */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  clearLaunch,
  hasAuthParams,
  MAX_AGE_MS,
  MAX_CHARS,
  readData,
  readMe,
  writeData,
  writeMe,
  type Store,
} from "../../src/lib/launch.ts";

function memoryStore(): Store & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
    removeItem: (k) => void map.delete(k),
  };
}

const me = { user: { id: "u1", email: "a@example.com", name: "A" }, profile: { role: "owner" } };
const NOW = Date.UTC(2026, 10, 24);

test("a remembered account comes back, and only while it is fresh", () => {
  const s = memoryStore();
  assert.equal(readMe(s, NOW), null);
  writeMe(s, me, NOW);
  assert.deepEqual(readMe(s, NOW + 1000), me);
  assert.deepEqual(readMe(s, NOW + MAX_AGE_MS), me);
  assert.equal(readMe(s, NOW + MAX_AGE_MS + 1), null);
});

test("damaged or mismatched records are ignored instead of throwing", () => {
  const s = memoryStore();
  s.setItem("pos.launch.me.v1", "{not json");
  assert.equal(readMe(s, NOW), null);
  s.setItem("pos.launch.me.v1", JSON.stringify({ at: NOW, uid: "someone-else", value: me }));
  assert.equal(readMe(s, NOW), null);
  s.setItem("pos.launch.me.v1", JSON.stringify({ at: "yesterday", uid: "u1", value: me }));
  assert.equal(readMe(s, NOW), null);
});

test("remembered screens are only handed to the person they belong to", () => {
  const s = memoryStore();
  writeData(s, "u1", { "/api/dashboard": { due: 100 } }, NOW);
  assert.deepEqual(readData(s, "u1", NOW), { "/api/dashboard": { due: 100 } });
  assert.deepEqual(readData(s, "u2", NOW), {});
  assert.deepEqual(readData(s, "u1", NOW + MAX_AGE_MS + 1), {});
});

test("only the known endpoints are stored", () => {
  const s = memoryStore();
  writeData(s, "u1", { "/api/dashboard": { ok: 1 }, "/api/tenants/7": { secret: 1 }, "/api/photos/x": "signed" }, NOW);
  assert.deepEqual(Object.keys(readData(s, "u1", NOW)), ["/api/dashboard"]);
  // Even a hand-edited record cannot smuggle other keys in.
  s.setItem(
    "pos.launch.data.v1",
    JSON.stringify({ at: NOW, uid: "u1", value: { "/api/anything": 1, "/api/ledger": 2 } }),
  );
  assert.deepEqual(readData(s, "u1", NOW), { "/api/ledger": 2 });
});

test("an oversized snapshot is skipped and the old one is dropped", () => {
  const s = memoryStore();
  assert.equal(writeData(s, "u1", { "/api/dashboard": { n: 1 } }, NOW), true);
  assert.equal(writeData(s, "u1", { "/api/ledger": "x".repeat(MAX_CHARS) }, NOW), false);
  assert.deepEqual(readData(s, "u1", NOW), {});
});

test("the meter and expense screens are dropped first when the snapshot would be too big", () => {
  const s = memoryStore();
  const big = "x".repeat(MAX_CHARS);
  assert.equal(writeData(s, "u1", { "/api/dashboard": { n: 1 }, "/api/meters": big }, NOW), true);
  assert.deepEqual(readData(s, "u1", NOW), { "/api/dashboard": { n: 1 } });
  assert.equal(writeData(s, "u1", { "/api/dashboard": { n: 2 }, "/api/expenses": { rows: [] } }, NOW), true);
  assert.deepEqual(readData(s, "u1", NOW), { "/api/dashboard": { n: 2 }, "/api/expenses": { rows: [] } });
});

test("signing out forgets the account and the screens", () => {
  const s = memoryStore();
  writeMe(s, me, NOW);
  writeData(s, "u1", { "/api/dashboard": { due: 1 } }, NOW);
  clearLaunch(s);
  assert.equal(readMe(s, NOW), null);
  assert.deepEqual(readData(s, "u1", NOW), {});
  assert.equal(s.map.size, 0);
});

test("auth links take the normal sign-in path", () => {
  assert.equal(hasAuthParams("", ""), false);
  assert.equal(hasAuthParams("", "?new=1"), false);
  assert.equal(hasAuthParams("#/", "?view=overdue"), false);
  assert.equal(hasAuthParams("#access_token=abc&type=recovery", ""), true);
  assert.equal(hasAuthParams("", "?code=abc123"), true);
  assert.equal(hasAuthParams("#error=access_denied&error_description=expired", ""), true);
  assert.equal(hasAuthParams("", "?type=signup"), true);
});
