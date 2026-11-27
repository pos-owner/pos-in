/** Push subscription endpoints are URLs the Worker later POSTs to, so only real push services are accepted. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { isPushEndpoint } from "../../worker/server/core/webpush.ts";

test("accepts the endpoints real browsers produce", () => {
  for (const url of [
    "https://fcm.googleapis.com/fcm/send/abc:APA91b",
    "https://fcm.googleapis.com/wp/abc",
    "https://updates.push.services.mozilla.com/wpush/v2/gAAAA",
    "https://wns2-pn1p.notify.windows.com/w/?token=abc",
    "https://web.push.apple.com/QGxyz",
  ])
    assert.equal(isPushEndpoint(url), true, url);
});

test("rejects anything that is not https on a known push service", () => {
  for (const url of [
    "http://fcm.googleapis.com/fcm/send/abc", // not https
    "https://example.com/push",
    "https://evil.com/fcm.googleapis.com",
    "https://fcm.googleapis.com.evil.com/x", // suffix trick
    "https://notfcm.googleapis.com.example/x",
    "https://evilnotify.windows.com/x", // not a subdomain boundary
    "https://user:pass@fcm.googleapis.com/x", // credentials
    "https://fcm.googleapis.com:8443/x", // odd port
    "https://127.0.0.1/x",
    "https://localhost/x",
    "https://[::1]/x",
    "javascript:alert(1)",
    "not a url",
    "",
  ])
    assert.equal(isPushEndpoint(url), false, url);
});
