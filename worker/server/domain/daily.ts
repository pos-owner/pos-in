/**
 * The daily rent cycle, run for every owner workspace by the Cron Trigger in wrangler.jsonc (00:30 UTC = 06:00 IST).
 * worker/index.ts sends one Queue message per workspace, and each message runs `runDailyForOwner`.
 */
import { eq, lt } from "drizzle-orm";
import { db, passwordResets, profiles, sessions } from "../../db/index.ts";
import { ensureCharges, loadLedger, loadWorkspace } from "./data.ts";
import { flow, logRun, recentlyReminded } from "./automations.ts";
import { inReminderWindow, reminderReason } from "./billing.ts";
import { runLeaseAlerts } from "./leases.ts";
import { applyLateFees } from "./fees.ts";
import { generateRecurringExpenses } from "./recurring.ts";
import { sendPendingPushes } from "./notifications.ts";
import { pruneRateLimits } from "../core/rateLimit.ts";
import { todayIST } from "../core/util.ts";

/** Reminder queue: unpaid charges inside the reminder window that haven't been reminded recently. */
export async function reminderQueue(ownerId: string) {
  const f = await flow(ownerId, "rent_reminders");
  if (!f.enabled) return { enabled: false, items: [] as ReturnType<typeof slimReminder>[] };
  const ws = await loadWorkspace(ownerId);
  await ensureCharges(ownerId, ws);
  const today = todayIST();
  const before = Number(f.config.daysBefore ?? 2);
  const ledger = (await loadLedger(ws)).filter((r) => inReminderWindow(r, today, before));
  const done = await recentlyReminded(
    ownerId,
    ledger.map((r) => r.id),
    Number(f.config.repeatEvery ?? 3),
  );
  return {
    enabled: true,
    items: ledger
      .filter((r) => !done.has(r.id))
      .sort((x, y) => x.dueDate.localeCompare(y.dueDate))
      .map((r) => slimReminder(r, today)),
  };
}
function slimReminder(r: Awaited<ReturnType<typeof loadLedger>>[number], today: string) {
  return {
    id: r.id,
    month: r.month,
    balance: r.balance,
    dueDate: r.dueDate,
    tenantId: r.tenantId,
    tenantName: r.tenantName,
    tenantPhone: r.tenantPhone,
    unitLabel: r.unitLabel,
    overdue: r.overdue,
    reason: reminderReason(r.dueDate, today),
  };
}

/**
 * The daily rent cycle for every workspace: creates the month's charges (safe to repeat), ends leases past their end
 * date, logs the reminder queue and prunes expired rate-limit counters and sessions. Run by the Cron Trigger in
 * wrangler.jsonc (06:00 IST); `runDailyForOwner` is also what each Queue message runs when the queue is bound.
 */
export async function runDailyForOwner(ownerId: string) {
  const ws = await loadWorkspace(ownerId);
  const before = ws.tenancyRows.filter((t) => t.status === "active").length;
  const n = await ensureCharges(ownerId, ws, true);
  const ended = before - ws.tenancyRows.filter((t) => t.status === "active").length;
  if (n) await logRun(ownerId, "charges", "month", n);
  if (ended) await logRun(ownerId, "end_tenancy", "tenancy", ended);
  const q = await reminderQueue(ownerId);
  if (q.enabled && q.items.length) await logRun(ownerId, "reminders", "queue", q.items.length);
  // Each step is independent: one failing must not stop the others (the queue retries the whole workspace).
  const step = async (name: string, run: () => Promise<number>) => {
    try {
      return await run();
    } catch (e) {
      console.error(`daily step ${name} failed`, e);
      return 0;
    }
  };
  const fees = await step("late_fees", () => applyLateFees(ownerId, ws));
  if (fees) await logRun(ownerId, "late_fee", "charge", fees);
  const recurring = await step("recurring", () => generateRecurringExpenses(ownerId));
  if (recurring) await logRun(ownerId, "recurring_expense", "expense", recurring);
  const alerts = await step("lease_alerts", () => runLeaseAlerts(ownerId, ws));
  if (alerts) await logRun(ownerId, "lease_alert", "tenancy", alerts);
  const pushed = await step("push", () => sendPendingPushes(ownerId));
  return { created: n, ended, fees, recurring, alerts, pushed };
}

export async function ownerIds(): Promise<string[]> {
  const rows = await db.select({ id: profiles.id }).from(profiles).where(eq(profiles.role, "owner"));
  return rows.map((r) => r.id);
}

export async function pruneExpired() {
  let pruned = 0;
  try {
    pruned = await pruneRateLimits(new Date(Date.now() - 2 * 24 * 60 * 60_000));
    await db.delete(sessions).where(lt(sessions.expiresAt, new Date()));
    await db.delete(passwordResets).where(lt(passwordResets.expiresAt, new Date(Date.now() - 86_400_000)));
  } catch (e) {
    console.error("pruning failed", e);
  }
  return pruned;
}

export async function runDailyCycle() {
  const owners = await ownerIds();
  let created = 0;
  let endedTotal = 0;
  let failedOwners = 0;
  for (const id of owners) {
    try {
      const r = await runDailyForOwner(id);
      created += r.created;
      endedTotal += r.ended;
    } catch (e) {
      failedOwners++;
      console.error("daily cycle failed for a workspace", e);
    }
  }
  const pruned = await pruneExpired();
  return { ok: true, workspaces: owners.length, failedOwners, created, ended: endedTotal, pruned };
}
