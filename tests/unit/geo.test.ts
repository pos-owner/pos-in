/** Place names for the Settings device list, and the activity line in the owner's people list. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { locationLabel } from "../../worker/server/core/geo.ts";
import { activityLabel } from "../../src/lib/format.ts";

test("a sign-in is named by city and country, falling back to region, then country", () => {
  assert.equal(locationLabel({ city: "Pune", region: "Maharashtra", country: "IN" }), "Pune, India");
  assert.equal(locationLabel({ region: "Maharashtra", country: "IN" }), "Maharashtra, India");
  assert.equal(locationLabel({ country: "in" }), "India");
  assert.equal(locationLabel({ city: "  Navi   Mumbai ", country: "IN" }), "Navi Mumbai, India");
  assert.equal(locationLabel({ city: "Singapore", country: "SG" }), "Singapore", "no 'Singapore, Singapore'");
});

test("unknown, Tor and missing geolocation give no place name", () => {
  assert.equal(locationLabel(undefined), "");
  assert.equal(locationLabel({}), "");
  assert.equal(locationLabel({ country: "XX" }), "");
  assert.equal(locationLabel({ country: "T1" }), "");
  assert.equal(locationLabel({ city: 42, country: null }), "");
});

test("the people list says how recently someone was active and whether they're still signed in", () => {
  const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
  assert.equal(activityLabel(ago(5_000), 1), "Active just now");
  assert.equal(activityLabel(ago(3 * 3_600_000 + 60_000), 2), "Active 3h ago");
  assert.equal(activityLabel(ago(2 * 86_400_000 + 60_000), 0), "Active 2d ago · signed out");
  assert.match(activityLabel(ago(40 * 86_400_000), 1), /^Last active \d{1,2} [A-Z][a-z]{2} \d{4}$/);
  assert.equal(activityLabel(null, 0), "Not signed in");
});
