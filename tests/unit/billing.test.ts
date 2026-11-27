/** Receipts and meter billing: usage, bill amounts, receipt numbers, amounts in words and the reminder window. */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  billFor,
  inReminderWindow,
  meterUsage,
  receiptNumber,
  reminderReason,
  rupeesInWords,
} from "../../worker/server/domain/billing.ts";

test("meter usage is the difference from the last reading", () => {
  assert.equal(meterUsage(4217.6, 4031.2), 186.4);
  assert.equal(meterUsage(120, 120), 0);
});

test("a first reading or a replaced meter bills nothing", () => {
  assert.equal(meterUsage(4031.2, null), 0);
  assert.equal(meterUsage(12, 4031.2, true), 0);
});

test("a reading lower than the last one is rejected unless the meter was reset", () => {
  assert.equal(meterUsage(3999, 4031.2), null);
});

test("bills are whole rupees at the rate per unit (in paise)", () => {
  assert.equal(billFor(186.4, 800), 1491); // 186.4 × ₹8 = ₹1,491.20
  assert.equal(billFor(10, 750), 75); // 10 × ₹7.50
  assert.equal(billFor(0, 800), 0);
  assert.equal(billFor(-5, 800), 0);
  assert.equal(billFor(50, 0), 0);
});

test("receipt numbers carry the payment month and a padded id", () => {
  assert.equal(receiptNumber(4, "2026-11-03"), "R-202611-0004");
  assert.equal(receiptNumber(12345, "2027-01-31"), "R-202701-12345");
});

test("amounts are written in Indian words on receipts", () => {
  assert.equal(rupeesInWords(0), "Rupees Zero Only");
  assert.equal(rupeesInWords(26500), "Rupees Twenty-Six Thousand Five Hundred Only");
  assert.equal(rupeesInWords(115000), "Rupees One Lakh Fifteen Thousand Only");
  assert.equal(
    rupeesInWords(12345678),
    "Rupees One Crore Twenty-Three Lakh Forty-Five Thousand Six Hundred Seventy-Eight Only",
  );
  assert.equal(rupeesInWords(1491.2), "Rupees One Thousand Four Hundred Ninety-One Only");
});

test("reminders cover unpaid charges near or past the due date", () => {
  const due = { balance: 15000, status: "due", dueDate: "2026-11-05" };
  assert.equal(inReminderWindow(due, "2026-11-01", 2), false); // 4 days away
  assert.equal(inReminderWindow(due, "2026-11-03", 2), true); // 2 days away
  assert.equal(inReminderWindow({ ...due, status: "overdue" }, "2026-11-20", 2), true);
  assert.equal(inReminderWindow({ ...due, balance: 0, status: "paid" }, "2026-11-20", 2), false);
  assert.equal(inReminderWindow({ ...due, status: "awaiting" }, "2026-11-20", 2), false); // tenant already said they paid
});

test("reminder reasons read naturally", () => {
  assert.equal(reminderReason("2026-11-05", "2026-11-03"), "Due in 2 days");
  assert.equal(reminderReason("2026-11-05", "2026-11-04"), "Due tomorrow");
  assert.equal(reminderReason("2026-11-05", "2026-11-05"), "Due today");
  assert.equal(reminderReason("2026-11-05", "2026-11-06"), "1 day late");
  assert.equal(reminderReason("2026-11-05", "2026-11-12"), "7 days late");
});
