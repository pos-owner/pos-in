/**
 * Account routes: password change, the signed-in device list, sign out everywhere, and owner-issued reset links.
 * Real accounts are created through /api/auth/signup here (not the test sign-in shortcut) so passwords are checked.
 */
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { startApp, type TestApp } from "../helpers/app.ts";
import { setupWorkspace } from "../helpers/workspace.ts";

const PHONE =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1";
const LAPTOP =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

let app: TestApp;

before(async () => {
  app = await startApp();
});

after(async () => {
  await app?.close();
});

async function signUp(email: string, password = "first-password", ua = PHONE) {
  const r = await app.call(null, "POST", "/api/auth/signup", { email, password, name: "Asha" }, { "user-agent": ua });
  assert.equal(r.status, 200);
  return app.sessionToken(r);
}
const signIn = (email: string, password: string, ua = LAPTOP) =>
  app.call(null, "POST", "/api/auth/signin", { email, password }, { "user-agent": ua });
const me = (token: string) => app.call(token, "GET", "/api/me");

test("changing the password needs the current one, signs out other devices and keeps this one", async () => {
  const phone = await signUp("pw@example.in");
  const laptop = app.sessionToken(await signIn("pw@example.in", "first-password"));

  const change = (current: string, password: string) =>
    app.call(phone, "POST", "/api/account/password", { current, password });
  assert.equal((await change("nope-nope", "x".repeat(9))).status, 400, "the current password must be right");
  assert.equal((await change("first-password", "short")).status, 400, "the new password must be long enough");
  assert.equal((await me(laptop)).status, 200, "a refused change signs nobody out");

  const ok = await change("first-password", "second-password");
  assert.equal(ok.status, 200);
  const fresh = app.sessionToken(ok);
  assert.equal((await me(laptop)).status, 401);
  assert.equal((await me(phone)).status, 401, "the old token on this device is replaced, not kept");
  assert.equal((await me(fresh)).status, 200);

  assert.equal((await signIn("pw@example.in", "first-password")).status, 400);
  assert.equal((await signIn("pw@example.in", "second-password")).status, 200);
});

test("a session started before the last password change is refused", async () => {
  const token = await signUp("cutoff@example.in");
  assert.equal((await me(token)).status, 200);
  // As if the password changed later without the session rows being cleared.
  await app.run("update users set password_changed_at = ? where email = ?", Date.now() + 60_000, "cutoff@example.in");
  assert.equal((await me(token)).status, 401);
});

test("the device list puts this device first and signs out other devices, but not this one", async () => {
  const phone = await signUp("devices@example.in");
  const laptop = app.sessionToken(await signIn("devices@example.in", "first-password"));

  const list = await app.call(phone, "GET", "/api/account/sessions");
  assert.equal(list.status, 200);
  assert.equal(list.body.length, 2);
  const [here, there] = list.body;
  assert.equal(here.current, true);
  assert.equal(here.userAgent, PHONE);
  assert.equal(there.current, false);
  assert.equal(there.userAgent, LAPTOP);
  assert.equal(here.location, "", "no Cloudflare geolocation outside a Worker, so no place name");
  for (const d of list.body) {
    assert.match(d.id, /^[0-9a-f]{16}$/);
    assert.equal("tokenHash" in d, false, "the full stored hash is not sent");
  }

  assert.equal((await app.call(phone, "DELETE", `/api/account/sessions/${here.id}`)).status, 400);
  assert.equal((await app.call(phone, "DELETE", "/api/account/sessions/not-an-id")).status, 404);

  // Someone else can't sign out this account's devices, even knowing the id.
  const stranger = await signUp("stranger@example.in");
  assert.equal((await app.call(stranger, "DELETE", `/api/account/sessions/${there.id}`)).status, 404);
  assert.equal((await me(laptop)).status, 200);

  assert.equal((await app.call(phone, "DELETE", `/api/account/sessions/${there.id}`)).status, 200);
  assert.equal((await me(laptop)).status, 401);
  assert.equal((await me(phone)).status, 200);
  assert.equal((await app.call(phone, "DELETE", `/api/account/sessions/${there.id}`)).status, 404);
  assert.equal((await app.call(phone, "GET", "/api/account/sessions")).body.length, 1);
});

test("sign out everywhere ends every session, this one included", async () => {
  const phone = await signUp("everywhere@example.in");
  const laptop = app.sessionToken(await signIn("everywhere@example.in", "first-password"));
  assert.equal((await app.call(phone, "POST", "/api/account/signout-all")).status, 200);
  assert.equal((await me(phone)).status, 401);
  assert.equal((await me(laptop)).status, 401);
});

test("an owner's reset link works once, only for people in their own workspace", async () => {
  const ws = await setupWorkspace(app, "r");
  const other = await setupWorkspace(app, "o");

  assert.equal((await ws.tenant.post("/api/members/owner-r/reset-link")).status, 403, "only owners make links");
  assert.equal((await ws.owner.post("/api/members/owner-r/reset-link")).status, 404, "not for the owner themselves");
  assert.equal((await other.owner.post("/api/members/tenant-r/reset-link")).status, 404, "not across workspaces");
  assert.equal((await ws.owner.post("/api/members/nobody/reset-link")).status, 404);

  const first = await ws.owner.post("/api/members/tenant-r/reset-link");
  assert.equal(first.status, 200);
  assert.equal(first.body.name, "Ravi");
  const tokenOf = (url: string) => new URL(url).searchParams.get("reset") ?? "";
  const t1 = tokenOf(first.body.url);
  assert.ok(t1);
  assert.equal((await app.call(null, "GET", `/api/auth/reset/${encodeURIComponent(t1)}`)).status, 200);

  // A newer link replaces the older one.
  const second = await ws.owner.post("/api/members/tenant-r/reset-link");
  const t2 = tokenOf(second.body.url);
  assert.equal((await app.call(null, "GET", `/api/auth/reset/${encodeURIComponent(t1)}`)).status, 410);
  const check = await app.call(null, "GET", `/api/auth/reset/${encodeURIComponent(t2)}`);
  assert.equal(check.status, 200);
  assert.equal(check.body.email, "ravir@example.in");

  const reset = await app.call(null, "POST", "/api/auth/reset", { token: t2, password: "tenant-new-password" });
  assert.equal(reset.status, 200);
  assert.equal((await ws.tenant.get("/api/me")).status, 401, "the tenant's other sessions end");
  assert.equal((await me(app.sessionToken(reset))).status, 200, "the device that reset is signed in");
  assert.equal(
    (await app.call(null, "POST", "/api/auth/reset", { token: t2, password: "another-password" })).status,
    410,
    "a link works once",
  );
  assert.equal((await signIn("ravir@example.in", "tenant-new-password")).status, 200);
});

test("the owner sees when each person was last active and whether a device is still signed in", async () => {
  const ws = await setupWorkspace(app, "act");
  await setupWorkspace(app, "elsewhere");
  const person = async () => {
    const r = await ws.owner.get("/api/invites");
    assert.equal(r.status, 200);
    assert.equal(
      r.body.people.some((p: { id: string }) => p.id === "tenant-elsewhere"),
      false,
      "only this workspace's people are listed",
    );
    return r.body.people.find((p: { id: string }) => p.id === "tenant-act");
  };

  const before = await person();
  assert.equal(before.devices, 1);
  assert.ok(before.lastActiveAt, "activity on a signed-in device counts");

  // A real sign-in (here through an owner reset link) records the time on the account.
  const link = await ws.owner.post("/api/members/tenant-act/reset-link");
  const token = new URL(link.body.url).searchParams.get("reset") ?? "";
  const reset = await app.call(null, "POST", "/api/auth/reset", { token, password: "tenant-act-password" });
  assert.equal(reset.status, 200);
  const [row] = await app.sql<{ last_sign_in_at: number | null }>(
    "select last_sign_in_at from users where id = ?",
    "tenant-act",
  );
  assert.ok(row.last_sign_in_at && Date.now() - row.last_sign_in_at < 60_000);

  const signedIn = await person();
  assert.equal(signedIn.devices, 1, "the reset ended the old session and started one");
  assert.equal(Date.parse(signedIn.lastActiveAt), row.last_sign_in_at);

  assert.equal((await app.call(app.sessionToken(reset), "POST", "/api/account/signout-all")).status, 200);
  const signedOut = await person();
  assert.equal(signedOut.devices, 0);
  assert.equal(Date.parse(signedOut.lastActiveAt), row.last_sign_in_at, "the last sign-in is kept after signing out");
});
