import { test } from "node:test";
import assert from "node:assert/strict";
import { allocate, monthSpan, upcomingMonths, type OpenMonth } from "../../worker/server/domain/allocation.ts";

const month = (m: string, balance: number, paid = 0, chargeId: number | null = 1): OpenMonth => ({
  chargeId,
  month: m,
  dueDate: `${m}-05`,
  amount: balance + paid,
  extra: 0,
  paid,
  balance,
});

const open = [month("2026-11", 10000), month("2026-09", 4000, 6000), month("2026-10", 10000)];

test("a payment goes to the oldest month first, and the last month it reaches can be partial", () => {
  const r = allocate(open, { amount: 19000 }, "2026-11");
  assert.ok(r.ok);
  assert.deepEqual(
    r.lines.map((l) => [l.month, l.applied, l.balanceAfter]),
    [
      ["2026-09", 4000, 0],
      ["2026-10", 10000, 0],
      ["2026-11", 5000, 5000],
    ],
  );
  assert.equal(r.total, 19000);
  assert.equal(r.max, 24000);
});

test("throughMonth clears every month up to and including it", () => {
  const r = allocate(open, { throughMonth: "2026-10" }, "2026-11");
  assert.ok(r.ok);
  assert.deepEqual(
    r.lines.map((l) => l.month),
    ["2026-09", "2026-10"],
  );
  assert.equal(r.total, 14000);
});

test("more than every open month can take is refused, with the most that can be paid", () => {
  const r = allocate(open, { amount: 24001 }, "2026-11");
  assert.equal(r.ok, false);
  assert.ok(!r.ok && r.code === "over_max" && r.max === 24000 && r.maxMonth === "2026-11");
  const exact = allocate(open, { amount: 24000 }, "2026-11");
  assert.ok(exact.ok && exact.lines.every((l) => l.balanceAfter === 0));
});

test("bad amounts, months past the limit and nothing due are refused", () => {
  for (const amount of [0, -5, 1.5, Number.NaN]) {
    const r = allocate(open, { amount }, "2026-11");
    assert.ok(!r.ok && r.code === "bad_amount", String(amount));
  }
  const beyond = allocate(open, { throughMonth: "2027-01" }, "2026-11");
  assert.ok(!beyond.ok && beyond.code === "beyond_limit");
  const none = allocate([month("2026-11", 0, 10000)], { amount: 100 }, "2026-11");
  assert.ok(!none.ok && none.code === "nothing_due");
  const early = allocate(open, { throughMonth: "2026-08" }, "2026-11");
  assert.ok(!early.ok && early.code === "nothing_due");
});

test("months after the current one are marked as advance", () => {
  const r = allocate([...open, month("2026-12", 10000, 0, null)], { amount: 30000 }, "2026-11");
  assert.ok(r.ok);
  assert.deepEqual(
    r.lines.map((l) => [l.month, l.advance]),
    [
      ["2026-09", false],
      ["2026-10", false],
      ["2026-11", false],
      ["2026-12", true],
    ],
  );
  assert.equal(r.lines[3].balanceAfter, 4000);
});

const tenancy = { startDate: "2026-01-10", endDate: null, status: "active", rent: 12000, dueDay: 5 };

test("upcoming months run from next month up to the advance limit, skipping months already billed", () => {
  const up = upcomingMonths(tenancy, ["2026-11", "2026-12"], "2026-11", 3);
  assert.deepEqual(
    up.map((u) => [u.month, u.balance, u.dueDate, u.chargeId]),
    [
      ["2027-01", 12000, "2027-01-05", null],
      ["2027-02", 12000, "2027-02-05", null],
    ],
  );
});

test("rent can't be paid past the lease end, ahead on an ended tenancy, or ahead when the limit is 0", () => {
  const ending = { ...tenancy, endDate: "2026-12-31" };
  assert.deepEqual(
    upcomingMonths(ending, [], "2026-11", 12).map((u) => u.month),
    ["2026-12"],
  );
  assert.deepEqual(upcomingMonths({ ...tenancy, status: "ended" }, [], "2026-11", 12), []);
  assert.deepEqual(upcomingMonths(tenancy, [], "2026-11", 0), []);
});

test("a tenancy that starts later is paid ahead from its first month, due no earlier than the move-in", () => {
  const later = { ...tenancy, startDate: "2027-01-20" };
  const up = upcomingMonths(later, [], "2026-11", 3);
  assert.deepEqual(
    up.map((u) => [u.month, u.dueDate]),
    [
      ["2027-01", "2027-01-20"],
      ["2027-02", "2027-02-05"],
    ],
  );
});

test("monthSpan gives the first and last month covered", () => {
  assert.deepEqual(monthSpan(["2026-12", "2026-10", "2026-11"]), { from: "2026-10", to: "2026-12" });
  assert.equal(monthSpan([]), null);
});
