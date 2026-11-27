import { useEffect, useState } from "react";
import { api, ApiError, invalidate, useApi } from "../../lib/api";
import { haptic } from "../../lib/perf";
import { features } from "../../lib/features";
import { useAuth } from "../../lib/auth";
import { batchNote, dateLabel, daysFromToday, monthLabel, rupees, todayISO } from "../../lib/format";
import { reminderText, telLink, whatsappLink } from "../../lib/links";
import type { ChargeFeesResponse, ChargeResponse, LedgerRow, Payment } from "../../lib/types";
import {
  ErrorState,
  Field,
  FormError,
  Section,
  Segmented,
  Sheet,
  Skeleton,
  Spinner,
  StatusPill,
  useToast,
} from "../../components/kit";
import { I, Icon, type IconName } from "../../components/icons";
import { METHOD } from "../tenant/History";
import { shareReceipt, usePaymentDecisions } from "./confirm";
import { MultiPaySheet } from "../shared/MultiPaySheet";
import "../../styles/ops.css";
import "../../styles/owner.css";
import { useT } from "../../lib/i18n";

/** Everything that shows rent numbers. Call after any payment change. */
export function refreshRent() {
  invalidate(
    "/api/charges",
    "/api/ledger",
    "/api/dashboard",
    "/api/tenants",
    "/api/receipts",
    "/api/reports",
    "/api/automations",
    "/api/reminders",
    "/api/tenancies",
  );
}

export function chargeSub(c: Pick<LedgerRow, "status" | "dueDate" | "paid" | "balance" | "pending" | "overdue">) {
  const d = daysFromToday(c.dueDate);
  if (c.status === "paid") return "Paid in full";
  if (c.status === "awaiting") return `${rupees(c.pending)} to confirm`;
  if (c.overdue) return `${-d} ${-d === 1 ? "day" : "days"} late${c.paid ? ` · ${rupees(c.paid)} paid` : ""}`;
  if (c.paid > 0) return `${rupees(c.paid)} paid · ${rupees(c.balance)} left`;
  if (d === 0) return "Due today";
  return d > 0 ? `Due ${dateLabel(c.dueDate)} · in ${d}d` : `Due ${dateLabel(c.dueDate)}`;
}

type Method = "cash" | "bank" | "upi";

/**
 * Owner view of one month's charge: confirm "I have paid", record cash/bank/partial, remind on WhatsApp.
 * `record` opens it straight on the "Record payment" form (the Home "Cash received" shortcut).
 */
export function ChargeSheet({
  chargeId,
  onClose,
  record = false,
}: {
  chargeId: number | null;
  onClose: () => void;
  record?: boolean;
}) {
  const t = useT();
  // Keep showing the last charge while the sheet animates closed.
  const [shown, setShown] = useState<number | null>(chargeId);
  useEffect(() => {
    if (chargeId) setShown(chargeId);
  }, [chargeId]);
  const { data, error, loading, reload } = useApi<ChargeResponse>(shown ? `/api/charges/${shown}` : null);
  const c = data?.charge;
  return (
    <Sheet
      open={!!chargeId}
      onClose={onClose}
      title={c ? t("{value} rent", { value: monthLabel(c.month, true) }) : t("Rent")}
    >
      {loading ? (
        <Section>
          <Skeleton rows={3} avatar={false} />
        </Section>
      ) : error || !c ? (
        <ErrorState error={error ?? { message: "Couldn't load this charge." }} retry={reload} />
      ) : (
        <ChargeBody key={c.id} c={c} startRecording={record && c.balance > 0 && c.pending === 0} />
      )}
    </Sheet>
  );
}

function ChargeBody({ c, startRecording }: { c: LedgerRow; startRecording: boolean }) {
  const t = useT();
  const { me } = useAuth();
  const toast = useToast();
  const decide = usePaymentDecisions();
  const [recording, setRecording] = useState(startRecording);
  const [amount, setAmount] = useState(String(c.balance));
  const [method, setMethod] = useState<Method>("cash");
  const [paidOn, setPaidOn] = useState(todayISO());
  const [utr, setUtr] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState<string>("");
  const [err, setErr] = useState("");
  const [confirmDelete, setConfirmDelete] = useState<number | null>(null);
  const [voidReason, setVoidReason] = useState("");
  const [multi, setMulti] = useState(false);

  const pending = c.payments.filter((p) => p.status === "pending");
  const others = c.payments.filter((p) => p.status !== "pending");
  const owner = me?.profile?.fullName || "Owner";
  const pct = c.amount ? Math.min(1, c.paid / c.amount) : 0;

  async function run(tag: string, fn: () => Promise<unknown>, done: string, after?: (result: unknown) => void) {
    setBusy(tag);
    setErr("");
    try {
      const result = await fn();
      refreshRent();
      if (after) after(result);
      else toast(done);
      return true;
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : "That didn't work. Please try again.");
      return false;
    } finally {
      setBusy("");
    }
  }

  async function record() {
    const n = Math.round(Number(amount.replace(/[,\s]/g, "")));
    if (!n || n < 1) return setErr("Enter the amount received.");
    if (n > c.balance) return setErr(`That's more than the ${rupees(c.balance)} still due.`);
    const ok = await run(
      "record",
      () =>
        api(`/api/charges/${c.id}/payments`, {
          body: { amount: n, method, paidOn, utr: utr.trim(), note: note.trim() },
        }),
      n < c.balance ? `${rupees(n)} recorded · ${rupees(c.balance - n)} left` : "Marked as paid",
      (result) => {
        haptic("success");
        const id = (result as { paymentId?: number })?.paymentId;
        toast(
          n < c.balance ? `${rupees(n)} recorded · ${rupees(c.balance - n)} left` : "Marked as paid",
          "checkCircle",
          features.receipts && id
            ? {
                label: "Share receipt",
                run: () =>
                  void shareReceipt(id).catch((e) =>
                    toast(e instanceof ApiError ? e.message : "Couldn't prepare the receipt.", "alert"),
                  ),
              }
            : undefined,
        );
      },
    );
    if (ok) setRecording(false);
  }

  return (
    <>
      <div className="center-text" style={{ padding: "4px 20px 18px" }}>
        <div className="t-headline">{c.tenantName}</div>
        <div className="t-sub c2">
          {c.unitLabel} · {c.propertyName}
        </div>
        <div className="amount-lg mt12">{rupees(c.balance > 0 ? c.balance : c.amount)}</div>
        <div className="hstack" style={{ justifyContent: "center", marginTop: 6 }}>
          <StatusPill status={c.status} />
          <span className="t-sub c2">
            {c.balance > 0
              ? t("of {amount} · due {date}", { amount: rupees(c.amount), date: dateLabel(c.dueDate) })
              : t("Due {date}", { date: dateLabel(c.dueDate, true) })}
          </span>
        </div>
        {c.paid > 0 && c.balance > 0 && (
          <div className="meter mt16" style={{ maxWidth: 260, margin: "16px auto 0" }}>
            <span style={{ "--p": pct } as React.CSSProperties} />
          </div>
        )}
      </div>

      {pending.map((p) => (
        <Section key={p.id} title="Tenant says they paid">
          <div className="card tight await-inline">
            <div className="between">
              <div>
                <div className="amount-sm">{rupees(p.amount)}</div>
                <div className="t-sub c2">
                  {METHOD[p.method]?.label ?? p.method} · {dateLabel(p.paidOn, true)}
                </div>
              </div>
              <StatusPill status="awaiting" />
            </div>
            <div className="utr-box mt12">
              {p.utr ? (
                <>
                  {t("UTR")} <b className="num">{p.utr}</b>
                </>
              ) : (
                t("No UTR given. Check your bank or UPI app for this amount.")
              )}
            </div>
            <div className="btn-row mt12">
              <button className="btn gray md" disabled={!!decide.busy} onClick={() => decide.reject(p)}>
                {decide.busy === `rej${p.id}` ? <Spinner /> : t("Not received")}
              </button>
              <button className="btn green md" disabled={!!decide.busy} onClick={() => decide.confirm(p, c.tenantName)}>
                {decide.busy === `ok${p.id}` ? (
                  <Spinner />
                ) : (
                  <>
                    <I.check /> {t("Confirm")}
                  </>
                )}
              </button>
            </div>
            {p.batch && p.batch.months > 1 && (
              <div className="t-foot c2 mt8">
                {t("{value}. Confirming or rejecting acts on all {n} months together, and one receipt covers them.", {
                  value: batchNote(p.batch),
                  n: p.batch.months,
                })}
              </div>
            )}
            {!p.batch && p.amount < c.balance && (
              <div className="t-foot c2 mt8">
                {t(
                  "Confirming leaves {amount} due as a partial payment. Received a different amount? Tap Not received, then record what actually arrived.",
                  { amount: rupees(c.balance - p.amount) },
                )}
              </div>
            )}
          </div>
        </Section>
      ))}

      {c.balance > 0 && !recording && (
        <Section>
          <div className="stack-8">
            <button
              className="btn"
              onClick={() => {
                setRecording(true);
                setAmount(String(c.balance - c.pending > 0 ? c.balance - c.pending : c.balance));
              }}
            >
              <I.plus /> {t("Record payment")}
            </button>
            <button className="btn tinted md" onClick={() => setMulti(true)}>
              <I.calendar /> {t("Several months or ahead")}
            </button>
            {c.tenantPhone && (
              <div className="btn-row">
                <a
                  className="btn whatsapp md"
                  href={whatsappLink(c.tenantPhone, reminderText(c, owner))}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  <I.chat /> {c.overdue ? t("Send reminder") : t("WhatsApp")}
                </a>
                <a className="btn gray md" href={telLink(c.tenantPhone)}>
                  <I.phone /> {t("Call")}
                </a>
              </div>
            )}
          </div>
        </Section>
      )}

      {recording && (
        <Section
          title="Record payment"
          footer="Use this for cash, bank transfers, or UPI you've already seen in your bank app. A smaller amount is saved as a partial payment."
        >
          <div className="list">
            <Field label="Amount" value={amount} onChange={setAmount} inputMode="numeric" prefix="₹" big autoFocus />
          </div>
          <div className="chips mt8" style={{ margin: "8px 0 0", padding: "2px 0 4px" }}>
            <button
              type="button"
              className="chip"
              aria-pressed={amount === String(c.balance)}
              onClick={() => setAmount(String(c.balance))}
            >
              {t("Full {amount}", { amount: rupees(c.balance) })}
            </button>
            {c.balance >= 2 && (
              <button
                type="button"
                className="chip"
                aria-pressed={amount === String(Math.round(c.balance / 2))}
                onClick={() => setAmount(String(Math.round(c.balance / 2)))}
              >
                {t("Half {amount}", { amount: rupees(Math.round(c.balance / 2)) })}
              </button>
            )}
          </div>
          <div className="mt12">
            <Segmented
              label="Paid by"
              value={method}
              onChange={setMethod}
              options={[
                { value: "cash", label: "Cash" },
                { value: "bank", label: "Bank" },
                { value: "upi", label: "UPI" },
              ]}
            />
          </div>
          <div className="list mt12">
            <Field label="Received on" type="date" value={paidOn} onChange={setPaidOn} />
            {method !== "cash" && (
              <Field
                label={method === "upi" ? t("UTR") : t("Reference")}
                value={utr}
                onChange={setUtr}
                placeholder="Optional"
                maxLength={40}
              />
            )}
            <Field label="Note" value={note} onChange={setNote} placeholder="Optional" maxLength={200} />
          </div>
          <FormError text={err} />
          <div className="btn-row mt12">
            <button
              className="btn gray"
              onClick={() => {
                setRecording(false);
                setErr("");
              }}
              disabled={busy === "record"}
            >
              {t("Cancel")}
            </button>
            <button className="btn" onClick={record} disabled={busy === "record"}>
              {busy === "record" ? <Spinner /> : t("Save")}
            </button>
          </div>
        </Section>
      )}

      {!recording && <FormError text={err} />}

      <MultiPaySheet
        tenancyId={multi ? c.tenancyId : null}
        role="owner"
        unitLabel={c.unitLabel}
        tenantName={c.tenantName}
        onClose={() => setMulti(false)}
        onRecorded={refreshRent}
      />

      <Breakdown c={c} />

      <Section title="Payments">
        {others.length ? (
          <div className="list">
            {others.map((p) => (
              <PayLine
                key={p.id}
                p={p}
                confirming={confirmDelete === p.id}
                busy={busy === `del${p.id}`}
                onDelete={() => {
                  // Confirmed payments are voided with a reason (the receipt is kept); rejected ones can be removed.
                  if (confirmDelete !== p.id) {
                    setVoidReason("");
                    setErr("");
                    return setConfirmDelete(p.id);
                  }
                  if (p.status === "confirmed") return setConfirmDelete(null);
                  run(`del${p.id}`, () => api(`/api/payments/${p.id}`, { method: "DELETE" }), "Payment removed").then(
                    () => setConfirmDelete(null),
                  );
                }}
              />
            ))}
          </div>
        ) : (
          <div className="card tight t-sub c2 center-text">{t("No payments recorded yet.")}</div>
        )}
        {confirmDelete && others.find((p) => p.id === confirmDelete)?.status === "confirmed" ? (
          <div className="void-form mt12">
            <div className="list">
              <Field
                label="Reason"
                value={voidReason}
                onChange={setVoidReason}
                placeholder="e.g. Cheque bounced, entered twice"
                maxLength={200}
                autoFocus
              />
            </div>
            <div className="confirm-text">
              {t(
                "Voiding stops this payment counting toward the rent. It stays in the history and its receipt is kept, marked void.",
              )}
            </div>
            <div className="btn-row mt8">
              <button className="btn gray md" onClick={() => setConfirmDelete(null)} disabled={!!busy}>
                {t("Cancel")}
              </button>
              <button
                className="btn danger md"
                disabled={!!busy || !voidReason.trim()}
                onClick={() =>
                  run(
                    `void${confirmDelete}`,
                    () => api(`/api/payments/${confirmDelete}/void`, { body: { reason: voidReason.trim() } }),
                    "Payment voided",
                  ).then((ok) => {
                    if (ok) setConfirmDelete(null);
                  })
                }
              >
                {busy === `void${confirmDelete}` ? <Spinner /> : t("Void payment")}
              </button>
            </div>
          </div>
        ) : confirmDelete ? (
          <div className="confirm-text">
            {t("Tap the bin again to remove this payment. The balance updates right away.")}
          </div>
        ) : null}
      </Section>
    </>
  );
}

function PayLine({
  p,
  onDelete,
  confirming,
  busy,
}: {
  p: Payment;
  onDelete: () => void;
  confirming: boolean;
  busy: boolean;
}) {
  const t = useT();
  const m = METHOD[p.method] ?? { label: p.method, icon: "wallet" as IconName, bg: "var(--label-2)" };
  const voided = p.status === "void";
  const struck = voided || p.status === "rejected";
  return (
    <div className="row">
      <span className="pay-method" style={{ background: m.bg }}>
        <Icon name={m.icon} />
      </span>
      <span className="grow">
        <span className="title" style={{ display: "block" }}>
          {m.label} · {dateLabel(p.paidOn, true)}
        </span>
        <span className="sub" style={{ display: "block" }}>
          {voided
            ? t("Voided{value}", { value: p.voidReason ? ` · ${p.voidReason}` : "" })
            : [batchNote(p.batch), p.utr && `Ref ${p.utr}`, p.note].filter(Boolean).join(" · ") ||
              (p.status === "rejected" ? t("Marked not received") : t("No reference"))}
        </span>
      </span>
      <span className="end">
        <span
          className={`num w6 ${struck ? "c3" : ""}`}
          style={struck ? { textDecoration: "line-through" } : undefined}
        >
          {rupees(p.amount)}
        </span>
        {features.receipts && (p.status === "confirmed" || voided) && <ReceiptButton paymentId={p.id} />}
        {!voided && (
          <button
            className="circle-btn plain tap44"
            aria-label={p.status === "confirmed" ? t("Void payment") : t("Remove payment")}
            onClick={onDelete}
            disabled={busy}
            style={{ color: confirming ? "var(--red-text)" : "var(--label-3)" }}
          >
            {busy ? <Spinner size={16} /> : <I.trash style={{ width: 18, height: 18 }} />}
          </button>
        )}
      </span>
    </div>
  );
}

/** Issues the receipt if needed (idempotent), then opens the share sheet so it can go to the tenant on WhatsApp. */
function ReceiptButton({ paymentId }: { paymentId: number }) {
  const t = useT();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  return (
    <button
      className="circle-btn plain tap44"
      aria-label={t("Share rent receipt")}
      disabled={busy}
      style={{ color: "var(--accent-press)" }}
      onClick={async () => {
        setBusy(true);
        try {
          const res = await shareReceipt(paymentId);
          if (res === "downloaded") toast("Receipt downloaded", "receipt");
        } catch (e) {
          toast(e instanceof ApiError ? e.message : "Couldn't prepare the receipt.", "alert");
        } finally {
          setBusy(false);
        }
      }}
    >
      {busy ? <Spinner size={16} /> : <I.receipt style={{ width: 18, height: 18 }} />}
    </button>
  );
}

/**
 * What the month is made of when it isn't plain rent: a pro-rated rent part, meter bills and late fees. Late fees
 * can be waived with a reason (the server refuses once a payment already covers the fee).
 */
function Breakdown({ c }: { c: LedgerRow }) {
  const t = useT();
  const { me } = useAuth();
  const isOwner = me?.profile?.role === "owner";
  const fees = c.fees ?? 0;
  const extra = c.extra ?? 0;
  const prorated = c.rentPart != null && !!c.proratedDays;
  const { data } = useApi<ChargeFeesResponse>(fees > 0 || c.overdue ? `/api/charges/${c.id}/fees` : null);
  const toast = useToast();
  const [waiving, setWaiving] = useState<number | null>(null);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const list = data?.fees ?? [];
  if (!fees && !extra && !prorated && !list.length) return null;
  const rent = c.rentPart ?? c.amount - extra - fees;

  async function waive(id: number) {
    if (!reason.trim()) return;
    setBusy(true);
    try {
      await api(`/api/fees/${id}/waive`, { body: { reason: reason.trim() } });
      refreshRent();
      invalidate(`/api/charges/${c.id}`);
      toast("Late fee waived");
      setWaiving(null);
      setReason("");
    } catch (e) {
      toast(e instanceof ApiError ? e.message : "Couldn't waive the fee.", "alert");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Section title="This month">
      <div className="list">
        <div className="row">
          <span className="grow">
            <span className="title" style={{ display: "block" }}>
              {t("Rent")}
            </span>
            {prorated && (
              <span className="sub" style={{ display: "block" }}>
                {t("Pro-rated ·")} {c.proratedDays} {c.proratedDays === 1 ? t("day") : t("days")}
              </span>
            )}
          </span>
          <span className="end">
            <span className="value num">{rupees(rent)}</span>
          </span>
        </div>
        {extra > 0 && (
          <div className="row">
            <span className="grow">
              <span className="title">{t("Meter bills")}</span>
            </span>
            <span className="end">
              <span className="value num">{rupees(extra)}</span>
            </span>
          </div>
        )}
        {list.map((f) => (
          <div className="row" key={f.id}>
            <span className="grow">
              <span
                className="title"
                style={{ display: "block", textDecoration: f.waivedAt ? "line-through" : undefined }}
              >
                {t("Late fee{value}", { value: f.note ? ` · ${f.note}` : "" })}
              </span>
              <span className="sub" style={{ display: "block" }}>
                {f.waivedAt
                  ? t("Waived{value}", { value: f.waiveReason ? ` · ${f.waiveReason}` : "" })
                  : t("Added {date}", { date: dateLabel(f.createdAt.slice(0, 10), true) })}
              </span>
            </span>
            <span className="end">
              <span className="value num">{rupees(f.amount)}</span>
              {isOwner && !f.waivedAt && (
                <button
                  className="btn plain sm"
                  onClick={() => {
                    setWaiving(waiving === f.id ? null : f.id);
                    setReason("");
                  }}
                >
                  {t("Waive")}
                </button>
              )}
            </span>
          </div>
        ))}
      </div>
      {waiving !== null && (
        <div className="void-form mt12">
          <div className="list">
            <Field
              label="Reason"
              value={reason}
              onChange={setReason}
              placeholder="e.g. Bank holiday, first time"
              maxLength={200}
              autoFocus
            />
          </div>
          <div className="btn-row mt8">
            <button className="btn gray md" onClick={() => setWaiving(null)} disabled={busy}>
              {t("Cancel")}
            </button>
            <button className="btn md" disabled={busy || !reason.trim()} onClick={() => waive(waiving)}>
              {busy ? <Spinner /> : t("Waive fee")}
            </button>
          </div>
        </div>
      )}
    </Section>
  );
}
