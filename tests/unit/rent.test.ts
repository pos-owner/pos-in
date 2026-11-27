/** Rent logic: charge status, due dates and invite PIN hashing. */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  addMonths,
  chargeDueDate,
  detectImageMime,
  computeStatus,
  defaultLeaseEnd,
  dueDateFor,
  hashPin,
  verifyPin,
} from "../../worker/server/core/util.ts";

test("photo MIME types come from magic bytes", () => {
  assert.equal(detectImageMime(new Uint8Array([0xff, 0xd8, 0xff, 0xe0])), "image/jpeg");
  assert.equal(detectImageMime(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), "image/png");
  assert.equal(
    detectImageMime(new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50])),
    "image/webp",
  );
  assert.equal(detectImageMime(new Uint8Array([0, 1, 2, 3])), null);
});

const charge = { amount: 15000, dueDate: "2026-11-05" };

test("charge status follows payments and the due date", () => {
  assert.equal(computeStatus(charge, [], "2026-10-20").status, "upcoming");
  assert.equal(computeStatus(charge, [], "2026-11-01").status, "due");
  assert.equal(computeStatus(charge, [], "2026-11-06").status, "overdue");
  assert.equal(computeStatus(charge, [{ amount: 5000, status: "confirmed" }], "2026-11-06").status, "partial");
  assert.equal(computeStatus(charge, [{ amount: 15000, status: "pending" }], "2026-11-06").status, "awaiting");
  assert.equal(
    computeStatus(
      charge,
      [
        { amount: 10000, status: "confirmed" },
        { amount: 5000, status: "confirmed" },
      ],
      "2026-11-30",
    ).status,
    "paid",
  );
  assert.equal(computeStatus(charge, [{ amount: 15000, status: "rejected" }], "2026-11-06").status, "overdue");
});

test("partial payments leave the right balance", () => {
  const s = computeStatus(charge, [{ amount: 4000, status: "confirmed" }], "2026-11-02");
  assert.equal(s.paid, 4000);
  assert.equal(s.balance, 11000);
});

test("due day clamps to the end of short months", () => {
  assert.equal(dueDateFor("2026-02", 31), "2026-02-28");
  assert.equal(dueDateFor("2026-11", 5), "2026-11-05");
  assert.equal(addMonths("2026-12", 1), "2027-01");
  assert.equal(addMonths("2026-01", -1), "2025-12");
});

test("invite PINs are stored as hashes and verified", async () => {
  const stored = await hashPin("482913");
  assert.ok(!stored.includes("482913"));
  assert.equal(await verifyPin("482913", stored), true);
  assert.equal(await verifyPin("000000", stored), false);
});

test("the move-in month is never due before the tenancy starts", () => {
  assert.equal(chargeDueDate("2026-11", 5, "2026-11-20"), "2026-11-20");
  assert.equal(chargeDueDate("2026-11", 25, "2026-11-20"), "2026-11-25");
  assert.equal(chargeDueDate("2026-12", 5, "2026-11-20"), "2026-12-05");
  assert.equal(chargeDueDate("2026-11", 5, "2026-11-01"), "2026-11-05");
});

test("the default 11-month lease end clamps month-end start dates instead of rolling into the next month", () => {
  assert.equal(defaultLeaseEnd("2026-01-01"), "2026-11-30");
  assert.equal(defaultLeaseEnd("2026-03-31"), "2027-02-27"); // 31 Mar + 11 months lands in February
  assert.equal(defaultLeaseEnd("2026-07-31"), "2027-06-29"); // June has 30 days
  assert.equal(defaultLeaseEnd("2026-01-31"), "2026-12-30");
});
