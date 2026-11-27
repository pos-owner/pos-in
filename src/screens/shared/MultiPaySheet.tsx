import { useEffect, useMemo, useState } from "react";
import { api, ApiError, useApi } from "../../lib/api";
import { features } from "../../lib/features";
import { dateLabel, daysFromToday, firstName, monthLabel, rupees, todayISO } from "../../lib/format";
import { upiLink, whatsappLink } from "../../lib/links";
import { haptic } from "../../lib/perf";
import type { PayPlanMonth, PayPlanResponse, RecordPaymentResult } from "../../lib/types";
import {
  ErrorState,
  Field,
  FormError,
  QR,
  Section,
  Segmented,
  Sheet,
  Skeleton,
  Spinner,
  useToast,
} from "../../components/kit";
import { I } from "../../components/icons";
import { SentState } from "../tenant/PaySheet";
import "../../styles/tenant.css";
import "../../styles/owner.css";
import "../../styles/ops.css";
import { useT } from "../../lib/i18n";

/*
 * One transfer for several months: clear old dues and, when the owner allows it, pay ahead.
 *
 * The browser only previews the split (oldest month first, the same rule as worker/server/domain/allocation.ts). The
 * server works the plan out again when the payment is saved and the database re-checks every month, so a stale
 * preview can never overpay a month.
 */

type Mode = "months" | "amount";
type Method = "cash" | "bank" | "upi";
type Step = "plan" | "confirm" | "sent";

interface PreviewLine {
  month: string;
  applied: number;
  balance: number;
  balanceAfter: number;
  advance: boolean;
}

/** Oldest month first; the last month reached may be paid in part. Mirrors `allocate` on the server. */
function previewSplit(
  months: PayPlanMonth[],
  req: { through: string } | { amount: number },
): { lines: PreviewLine[]; total: number } {
  const sorted = months.filter((m) => m.balance > 0).sort((a, b) => a.month.localeCompare(b.month));
  let remaining =
    "through" in req
      ? sorted.filter((m) => m.month <= req.through).reduce((s, m) => s + m.balance, 0)
      : Math.max(0, Math.floor(req.amount));
  const lines: PreviewLine[] = [];
  for (const m of sorted) {
    if (remaining <= 0) break;
    const applied = Math.min(m.balance, remaining);
    remaining -= applied;
    lines.push({ month: m.month, applied, balance: m.balance, balanceAfter: m.balance - applied, advance: m.advance });
  }
  return { lines, total: lines.reduce((s, l) => s + l.applied, 0) };
}

/** "Nov 2026" or "Nov 2026 – Feb 2027". */
function spanLabel(from: string, to: string) {
  return from === to ? monthLabel(from) : `${monthLabel(from)} – ${monthLabel(to)}`;
}

const newKey = () =>
  typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `k-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

/**
 * Tenant: pick the months (or an amount), pay the total by UPI, then tell the owner (pending until confirmed).
 * Owner: record money already received for several months at once (confirmed straight away, one receipt).
 */
export function MultiPaySheet({
  tenancyId,
  role,
  onClose,
  unitLabel = "",
  tenantName = "",
  onRecorded,
}: {
  tenancyId: number | null;
  role: "owner" | "tenant";
  onClose: () => void;
  unitLabel?: string;
  tenantName?: string;
  /** Called after a payment is saved, so the caller can refresh whatever it shows. */
  onRecorded?: () => void;
}) {
  const t = useT();
  // Keep showing the last tenancy while the sheet animates closed; each opening starts a fresh form.
  const [shown, setShown] = useState<number | null>(tenancyId);
  const [opening, setOpening] = useState(0);
  useEffect(() => {
    if (tenancyId) {
      setShown(tenancyId);
      setOpening((n) => n + 1);
    }
  }, [tenancyId]);
  const plan = useApi<PayPlanResponse>(shown ? `/api/tenancies/${shown}/pay-plan` : null);
  const isTenant = role === "tenant";

  return (
    <Sheet open={!!tenancyId} onClose={onClose} title={isTenant ? t("Pay several months") : t("Record several months")}>
      {plan.loading ? (
        <Section>
          <Skeleton rows={4} avatar={false} />
        </Section>
      ) : plan.error || !plan.data ? (
        <ErrorState error={plan.error ?? { message: "Couldn't load the months." }} retry={plan.reload} />
      ) : (
        <PlanBody
          key={`${shown}-${opening}`}
          data={plan.data}
          role={role}
          unitLabel={unitLabel}
          tenantName={tenantName}
          onClose={onClose}
          onRecorded={() => {
            void plan.reload();
            onRecorded?.();
          }}
        />
      )}
    </Sheet>
  );
}

function PlanBody({
  data,
  role,
  unitLabel,
  tenantName,
  onClose,
  onRecorded,
}: {
  data: PayPlanResponse;
  role: "owner" | "tenant";
  unitLabel: string;
  tenantName: string;
  onClose: () => void;
  onRecorded: () => void;
}) {
  const t = useT();
  const toast = useToast();
  const isTenant = role === "tenant";
  const months = useMemo(() => [...data.months].sort((a, b) => a.month.localeCompare(b.month)), [data.months]);
  const dueMonths = months.filter((m) => !m.advance);
  const aheadMonths = months.filter((m) => m.advance);

  // Start on "everything due" when something is due, else on the first month ahead.
  const [through, setThrough] = useState<string>(
    () => (dueMonths.length ? dueMonths[dueMonths.length - 1].month : months[0]?.month) ?? "",
  );
  const [mode, setMode] = useState<Mode>("months");
  const [amount, setAmount] = useState("");
  const [method, setMethod] = useState<Method>("cash");
  const [paidOn, setPaidOn] = useState(todayISO());
  const [utr, setUtr] = useState("");
  const [note, setNote] = useState("");
  const [step, setStep] = useState<Step>("plan");
  const [showQr, setShowQr] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [clientKey] = useState(newKey);
  const [sent, setSent] = useState<{ amount: number; utr: string } | null>(null);

  const typed = Math.round(Number(amount.replace(/[,\s₹]/g, "")) || 0);
  const preview = useMemo(
    () => (mode === "months" ? previewSplit(months, { through }) : previewSplit(months, { amount: typed })),
    [mode, months, through, typed],
  );
  const lines = preview.lines;
  const total = preview.total;
  const first = lines[0]?.month;
  const last = lines[lines.length - 1];
  const fullyPaidThrough = last ? (last.balanceAfter === 0 ? last.month : lines[lines.length - 2]?.month) : undefined;
  const aheadCount = lines.filter((l) => l.advance).length;
  const over = mode === "amount" && typed > data.max;

  const payee = data.payee;
  const ownerFirst = payee?.name ? firstName(payee.name) : "the owner";
  const upiNote = first && last ? `Rent ${spanLabel(first, last.month)} ${unitLabel}`.trim() : "Rent";
  const link =
    isTenant && payee?.upiId && total > 0
      ? upiLink({ upiId: payee.upiId, name: payee.name || "Owner", amount: total, note: upiNote })
      : "";

  if (!months.length) {
    return (
      <Section>
        <div className="card center-text" style={{ padding: "26px 18px" }}>
          <div className="paid-check">
            <I.check />
          </div>
          <div className="t-title3 mt12">{t("Nothing to pay right now")}</div>
          <div className="t-sub c2" style={{ marginTop: 6 }}>
            {data.awaiting
              ? t("A payment is already waiting for confirmation.")
              : isTenant
                ? t("Every month is paid{value}.", {
                    value: data.maxMonthsAhead ? t(" as far ahead as your lease allows") : "",
                  })
                : t("Every month is paid as far ahead as the lease and your Advance rent setting allow.")}
          </div>
        </div>
      </Section>
    );
  }

  function validate() {
    if (mode === "amount") {
      if (!typed || typed < 1) return "Enter the amount.";
      if (over) return `That's more than can be paid now. The most is ${rupees(data.max)}.`;
    }
    if (!lines.length || total < 1) return "Choose at least one month.";
    return "";
  }

  async function submit() {
    const problem = validate();
    if (problem) return setErr(problem);
    const clean = utr.replace(/\s/g, "");
    if (isTenant && clean && !/^[A-Za-z0-9]{6,22}$/.test(clean))
      return setErr("The UTR is usually a 12-digit number. Check it, or leave it blank.");
    setErr("");
    setBusy(true);
    try {
      const body: Record<string, unknown> = {
        clientKey,
        utr: clean,
        ...(mode === "months" ? { throughMonth: through } : { amount: typed }),
      };
      if (isTenant) body.note = payee?.upiId ? "" : "Paid to owner directly";
      else Object.assign(body, { method, paidOn, note: note.trim() });
      const r = await api<RecordPaymentResult>(`/api/tenancies/${data.tenancyId}/payments`, { body });
      haptic("success");
      onRecorded();
      if (isTenant) {
        setSent({ amount: r.amount, utr: clean });
        setStep("sent");
      } else {
        toast(
          `${rupees(r.amount)} recorded for ${r.months} ${r.months === 1 ? "month" : "months"}`,
          "checkCircle",
          features.receipts
            ? {
                label: "Share receipt",
                run: () =>
                  void import("../owner/confirm")
                    .then((m) => m.shareReceipt(r.paymentId))
                    .catch((e) => toast(e instanceof ApiError ? e.message : "Couldn't prepare the receipt.", "alert")),
              }
            : undefined,
        );
        onClose();
      }
    } catch (e) {
      haptic("warn");
      setErr(e instanceof ApiError ? e.message : "Couldn't save that. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  if (step === "sent" && sent) {
    return (
      <SentState
        amount={sent.amount}
        owner={ownerFirst}
        onDone={onClose}
        waLink={
          payee?.phone && first && last
            ? whatsappLink(
                payee.phone,
                `Hi ${ownerFirst}, I've paid ${rupees(sent.amount)} rent for ${unitLabel || "my unit"} covering ${spanLabel(first, last.month)}${sent.utr ? `, UTR ${sent.utr}` : ""}. I've marked it in pOS. Thank you! – ${tenantName || "your tenant"}`,
              )
            : ""
        }
      />
    );
  }

  return (
    <>
      <div className="center-text" style={{ padding: "4px 20px 12px" }}>
        <div className="t-sub c2">
          {first && last ? spanLabel(first, last.month) : t("Choose months")}
          {lines.length > 0 && ` · ${lines.length} ${lines.length === 1 ? "month" : "months"}`}
        </div>
        <div className="amount-lg mt8 money">{rupees(total)}</div>
        <div className="hstack" style={{ justifyContent: "center", marginTop: 8, flexWrap: "wrap", gap: 6 }}>
          {fullyPaidThrough && (
            <span className="pill green">
              <I.checkCircle /> {t("Paid through")} {monthLabel(fullyPaidThrough)}
            </span>
          )}
          {aheadCount > 0 && (
            <span className="pill purple">
              {t("{aheadCount} {value} ahead", { aheadCount, value: aheadCount === 1 ? t("month") : t("months") })}
            </span>
          )}
        </div>
      </div>

      {step === "plan" && (
        <>
          {isTenant && data.awaiting > 0 && (
            <Section>
              <div className="banner purple">
                <I.clock />
                <div className="grow">
                  <b>{t("Waiting for {ownerFirst}", { ownerFirst })}</b>
                  <span>
                    {t("{value} listed here until {ownerFirst} confirms {value2}.", {
                      value:
                        data.awaiting === 1
                          ? t("One month you already reported isn't")
                          : `${data.awaiting} months you already reported aren't`,
                      ownerFirst,
                      value2: data.awaiting === 1 ? t("it") : t("them"),
                    })}
                  </span>
                </div>
              </div>
            </Section>
          )}
          <Section>
            <Segmented
              label="Pay by"
              value={mode}
              onChange={(v) => {
                setMode(v);
                setErr("");
                if (v === "amount" && !amount) setAmount(String(total || months[0].balance));
              }}
              options={[
                { value: "months", label: "Months" },
                { value: "amount", label: "Amount" },
              ]}
            />
          </Section>

          {mode === "months" ? (
            <Section
              title="Pay up to"
              footer={
                aheadMonths.length
                  ? t("Tap the last month to pay. Every month before it is included. Rent can be paid up to {value}.", {
                      value: monthLabel(aheadMonths[aheadMonths.length - 1].month, true),
                    })
                  : t("Tap the last month to pay. Every month before it is included.")
              }
            >
              <div className="list month-pick" role="radiogroup" aria-label={t("Pay up to month")}>
                {months.map((m) => {
                  const on = m.month <= through;
                  const isEnd = m.month === through;
                  const late = !m.advance && daysFromToday(m.dueDate) < 0;
                  return (
                    <button
                      key={m.month}
                      type="button"
                      role="radio"
                      aria-checked={isEnd}
                      className={`row month-row ${on ? "on" : ""} ${isEnd ? "end-pick" : ""}`}
                      onClick={() => {
                        haptic();
                        setThrough(m.month);
                        setErr("");
                      }}
                    >
                      <span className="mp-tick" aria-hidden="true">
                        {on && <I.check />}
                      </span>
                      <span className="grow">
                        <span className="title" style={{ display: "block" }}>
                          {monthLabel(m.month, true)}
                        </span>
                        <span className="sub" style={{ display: "block" }}>
                          {m.advance
                            ? t("Ahead · due {date}", { date: dateLabel(m.dueDate) })
                            : late
                              ? t("Overdue since {date}", { date: dateLabel(m.dueDate) })
                              : t("Due {date}", { date: dateLabel(m.dueDate) })}
                          {m.paid > 0 && t(" · {amount} paid", { amount: rupees(m.paid) })}
                        </span>
                      </span>
                      <span className="end">
                        <span className={`num w6 ${late ? "c-red" : ""}`}>{rupees(m.balance)}</span>
                        {m.advance ? (
                          <span className="pill purple">{t("Ahead")}</span>
                        ) : late ? (
                          <span className="pill red">{t("Late")}</span>
                        ) : (
                          <span className="pill orange">{t("Due")}</span>
                        )}
                      </span>
                    </button>
                  );
                })}
              </div>
            </Section>
          ) : (
            <Section
              title="Amount"
              footer={t("It goes to the oldest month first. Up to {amount} can be paid now.", {
                amount: rupees(data.max),
              })}
            >
              <div className="list">
                <Field label="Amount" value={amount} onChange={setAmount} inputMode="numeric" prefix="₹" big />
              </div>
              <div className="chips mt8" style={{ margin: "8px 0 0", padding: "2px 0 4px" }}>
                {dueMonths.length > 0 && (
                  <QuickAmount
                    label="All dues"
                    value={dueMonths.reduce((s, m) => s + m.balance, 0)}
                    current={amount}
                    set={setAmount}
                  />
                )}
                {[3, 6, 12]
                  .filter((n) => n <= aheadMonths.length)
                  .map((n) => (
                    <QuickAmount
                      key={n}
                      label={t("+{n} ahead", { n })}
                      value={
                        dueMonths.reduce((s, m) => s + m.balance, 0) +
                        aheadMonths.slice(0, n).reduce((s, m) => s + m.balance, 0)
                      }
                      current={amount}
                      set={setAmount}
                    />
                  ))}
              </div>
              {over && (
                <FormError text={t("The most that can be paid now is {amount}.", { amount: rupees(data.max) })} />
              )}
            </Section>
          )}

          {lines.length > 0 && (
            <Section title="How it's split">
              <div className="list breakdown">
                {lines.map((l) => (
                  <div className="row" key={l.month}>
                    <span className="grow">
                      {monthLabel(l.month, true)}
                      {l.balanceAfter > 0 && (
                        <span className="bd-due c2">
                          {t("Part payment · {amount} left on this month", { amount: rupees(l.balanceAfter) })}
                        </span>
                      )}
                    </span>
                    <span className="num">{rupees(l.applied)}</span>
                  </div>
                ))}
                <div className="row total">
                  <span className="grow">{t("Total")}</span>
                  <span className="num money">{rupees(total)}</span>
                </div>
              </div>
            </Section>
          )}

          {!isTenant && (
            <Section title="Received" footer="Saved as confirmed. One receipt covers every month in this payment.">
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
            </Section>
          )}

          <Section>
            <FormError text={err} />
            {isTenant ? (
              <div className="stack-8">
                {link ? (
                  <>
                    <a
                      className="btn pay-btn"
                      href={validate() ? undefined : link}
                      onClick={(e) => {
                        const problem = validate();
                        if (problem) {
                          e.preventDefault();
                          return setErr(problem);
                        }
                        haptic();
                      }}
                    >
                      <I.rupee /> {t("Pay")} {rupees(total)} {t("with UPI")}
                    </a>
                    <button type="button" className="qr-toggle" onClick={() => setShowQr((v) => !v)}>
                      <I.qr /> {showQr ? t("Hide QR code") : t("Scan from another phone")}
                    </button>
                    {showQr && total > 0 && (
                      <QR
                        text={link}
                        label={t("UPI QR code to pay {amount} to {value}", {
                          amount: rupees(total),
                          value: payee?.name ?? "the owner",
                        })}
                      />
                    )}
                  </>
                ) : (
                  <div className="banner blue">
                    <I.wallet />
                    <div className="grow">
                      <b>{t("Pay {value} directly", { value: payee?.name || "your owner" })}</b>
                      <span>{t("Pay by cash, bank transfer or UPI as usual, then let them know here.")}</span>
                    </div>
                  </div>
                )}
                <button
                  className="btn tinted"
                  onClick={() => {
                    const problem = validate();
                    if (problem) return setErr(problem);
                    setErr("");
                    setStep("confirm");
                  }}
                >
                  <I.checkCircle /> {t("I have paid")}
                </button>
              </div>
            ) : (
              <div className="btn-row">
                <button className="btn gray" onClick={onClose} disabled={busy}>
                  {t("Cancel")}
                </button>
                <button className="btn" onClick={submit} disabled={busy || !lines.length}>
                  {busy ? <Spinner /> : t("Save {amount}", { amount: rupees(total) })}
                </button>
              </div>
            )}
          </Section>
        </>
      )}

      {step === "confirm" && (
        <>
          <Section footer="You'll find the 12-digit UTR in your payment app's receipt. It helps the owner match your payment faster.">
            <div className="list">
              <div className="row">
                <span className="grow title">{t("Amount")}</span>
                <span className="value num money" style={{ color: "var(--label)" }}>
                  {rupees(total)}
                </span>
              </div>
              <Field
                label="UTR (optional)"
                value={utr}
                onChange={setUtr}
                inputMode="numeric"
                placeholder="e.g. 533120984467"
                maxLength={22}
                stack
                autoFocus
              />
            </div>
            <FormError text={err} />
          </Section>
          <Section>
            <div className="btn-row">
              <button className="btn gray" onClick={() => setStep("plan")} disabled={busy}>
                {t("Back")}
              </button>
              <button className="btn" onClick={submit} disabled={busy}>
                {busy ? <Spinner /> : t("Send to {ownerFirst}", { ownerFirst })}
              </button>
            </div>
            <div className="t-foot c2 center-text mt12">
              {t("Every month in this payment shows “awaiting confirmation” until {ownerFirst} confirms it.", {
                ownerFirst,
              })}
            </div>
          </Section>
        </>
      )}
    </>
  );
}

function QuickAmount({
  label,
  value,
  current,
  set,
}: {
  label: string;
  value: number;
  current: string;
  set: (v: string) => void;
}) {
  return (
    <button type="button" className="chip" aria-pressed={current === String(value)} onClick={() => set(String(value))}>
      {label} {rupees(value)}
    </button>
  );
}
