import assert from "node:assert/strict";
import { test } from "node:test";
import { parseRentAmount } from "../../src/lib/format.ts";

test("rent amounts accept Indian grouping and optional blanks without hiding invalid input", () => {
  assert.equal(parseRentAmount(" 1,25,000.50 "), 125001);
  assert.equal(parseRentAmount(""), 0);
  assert.equal(parseRentAmount("", 1), null);
  assert.equal(parseRentAmount("0", 1), null);
  for (const value of ["12oops", "-", ",", "1e5", "-0.1", "100000001"]) {
    assert.equal(parseRentAmount(value), null, value);
  }
});
