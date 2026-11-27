/** Languages: the t() helper and the Hindi dictionary. */
import { test } from "node:test";
import assert from "node:assert/strict";
import hi from "../../src/i18n/hi.json" with { type: "json" };
import { getLocale, intlLocale, setLocale, tr } from "../../src/lib/i18n.ts";

const placeholders = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

test("English is the default and text without a translation falls back to it", () => {
  assert.equal(getLocale(), "en");
  assert.equal(tr("Waiting to sync"), "Waiting to sync");
  assert.equal(tr("Not in the dictionary", undefined, "hi"), "Not in the dictionary");
});

test("placeholders are filled in, and unknown ones are left as they are", () => {
  assert.equal(tr("{n} entries on this phone", { n: 3 }), "3 entries on this phone");
  assert.equal(tr("{n} entries on this phone", { n: 3 }, "hi"), "इस फ़ोन पर 3 एंट्री");
  assert.equal(tr("Hello {name}", {}), "Hello {name}");
});

test("switching language changes tr() and the Intl locale; unknown values are ignored", () => {
  setLocale("hi");
  assert.equal(getLocale(), "hi");
  assert.equal(tr("Send now"), "अभी भेजें");
  assert.equal(intlLocale(), "hi-IN");
  setLocale("fr");
  assert.equal(getLocale(), "hi");
  setLocale("en");
  assert.equal(tr("Send now"), "Send now");
  assert.equal(intlLocale(), "en-IN");
});

test("every Hindi string is filled in and keeps the English placeholders", () => {
  for (const [en, value] of Object.entries(hi as Record<string, string>)) {
    assert.ok(value.trim(), `empty translation for "${en}"`);
    assert.deepEqual(placeholders(value), placeholders(en), `placeholders differ for "${en}"`);
  }
});
