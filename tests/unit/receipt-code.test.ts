import assert from "node:assert/strict";
import { test } from "node:test";
import { extractCode, RECEIPT_CODE } from "../../src/lib/receiptCode.ts";

test("verification accepts a printed code or pasted link and rejects malformed encoding", () => {
  const code = "1a-AbcD12_zz-xy";
  assert.match(code, RECEIPT_CODE);
  assert.equal(extractCode(`  ${code}  `), code);
  assert.equal(extractCode("https://pos.example.test/verify/1a-AbcD12%5Fzz-xy?src=qr#receipt"), code);
  assert.doesNotMatch(extractCode("https://pos.example.test/verify/%ZZ"), RECEIPT_CODE);
  assert.doesNotMatch(extractCode("R-202610-0030"), RECEIPT_CODE);
});
