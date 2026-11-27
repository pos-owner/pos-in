import { useEffect, useState } from "react";
import { api, ApiError, invalidate } from "../../lib/api";
import { dateLabel, daysFromToday, monthLabel, rupees } from "../../lib/format";
import { upiLink, whatsappLink } from "../../lib/links";
import { haptic } from "../../lib/perf";
import type { LedgerRow, TenantHome } from "../../lib/types";
import { copyText, Field, FormError, QR, Section, Sheet, Spinner, StatusPill, useToast } from "../../components/kit";
import { I } from "../../components/icons";
import "../../styles/tenant.css";
import { useT } from "../../lib/i18n";

/** Remembers that the UPI app was opened, so a return to pOS (even after the phone reloads it) can ask how it went. */
const UPI_KEY = "pos.upiOpened";
const UPI_WINDOW_MS = 30 * 60_000;
export function readUpiReturn(): number | null {
  try {
    const v = JSON.parse(sessionStorage.getItem(UPI_KEY) ?? "null") as { id: number; at: number } | null;
    return v && Date.now() - v.at < UPI_WINDOW_MS ? v.id : null;
  } catch {
    return null;
  }
}
function rememberUpi(id: number | null) {
  try {
    if (id) sessionStorage.setItem(UPI_KEY, JSON.stringify({ id, at: Date.now() }));
    else sessionStorage.removeItem(UPI_KEY);
  } catch {
    /* storage blocked: the in-page prompt still works */
  }
}

type Step = "pay" | "confirm" | "sent";

/**
 * UPI deep link + QR, then "I have paid" with an optional UTR. The owner always confirms.
 * `returned` opens the sheet on the "Did the payment go through?" prompt (the tenant came back from the UPI app).
 */
export function PaySheet({
  charge,
  payee,
  onClose,
  returned = false,
  tenantName = "",
}: {
  charge: LedgerRow | null;
  payee: TenantHome["payee"];
  onClose: () => void;
  returned?: boolean;
  tenantName?: string;
}) {
  const t = useT();
  const toast = useToast();
  const [step, setStep] = useState<Step>("pay");
  const [utr, setUtr] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [opened, setOpened] = useState(false);
  const [back, setBack] = useState(false);
  const [other, setOther] = useState(false);
  const [showQr, setShowQr] = useState(false);
  const [sent, setSent] = useState<{ amount: number; utr: string } | null>(null);

  useEffect(() => {
    if (charge) {
      setStep("pay");
      setUtr("");
      setErr("");
      setOpened(returned);
      setBack(returned);
      setOther(false);
      setShowQr(false);
      setSent(null);
    }
  }, [charge?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // Coming back from GPay/PhonePe: gently ask whether it went through instead of leaving the tenant to guess.
  useEffect(() => {
    if (!charge || !opened) return;
    const onVis = () => {
      if (document.visibilityState === "visible") setBack(true);
    };
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, [charge, opened]);

  const c = charge;
  const ownerFirst = payee.name ? payee.name.split(" ")[0] : "the owner";
  const note = c ? `Rent ${monthLabel(c.month)} ${c.unitLabel}` : "";
  const link =
    c && payee.upiId ? upiLink({ upiId: payee.upiId, name: payee.name || "Owner", amount: c.balance, note }) : "";
  const awaiting = !!c && c.pending > 0 && step !== "sent";

  async function markPaid() {
    if (!c) return;
    const clean = utr.replace(/\s/g, "");
    if (clean && !/^[A-Za-z0-9]{6,22}$/.test(clean))
      return setErr("The UTR is usually a 12-digit number. Check it, or leave it blank.");
    setErr("");
    setBusy(true);
    try {
      await api(`/api/charges/${c.id}/payments`, {
        body: {
          utr: clean,
          amount: c.balance,
          note: other ? "Paid by cash or bank transfer" : payee.upiId ? "" : "Paid to owner directly",
        },
      });
      haptic("success");
      rememberUpi(null);
      invalidate("/api/tenant");
      setSent({ amount: c.balance, utr: clean });
      setStep("sent");
    } catch (e) {
      haptic("warn");
      setErr(e instanceof ApiError ? e.message : "Couldn't send that. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  async function copyUpi() {
    if (await copyText(payee.upiId)) toast("UPI ID copied", "copy");
  }

  const close = () => {
    if (step === "sent") rememberUpi(null);
    onClose();
  };

  const messageOwner = (amount: number, ref: string) =>
    payee.phone
      ? whatsappLink(
          payee.phone,
          `Hi ${ownerFirst}, I've paid ${rupees(amount)} rent for ${c?.unitLabel ?? "my unit"} (${c ? monthLabel(c.month, true) : ""})${ref ? `, UTR ${ref}` : ""}. I've marked it in pOS. Thank you! – ${tenantName || "your tenant"}`,
        )
      : "";

  return (
    <Sheet
      open={!!charge}
      onClose={close}
      title={step === "pay" ? t("Pay rent") : step === "confirm" ? t("I have paid") : t("Sent")}
    >
      {c && step === "sent" && sent ? (
        <SentState
          amount={sent.amount}
          owner={ownerFirst}
          waLink={messageOwner(sent.amount, sent.utr)}
          onDone={close}
        />
      ) : (
        c && (
          <>
            <div className="center-text" style={{ padding: "4px 20px 14px" }}>
              <div className="t-sub c2">
                {monthLabel(c.month, true)} · {c.unitLabel}
              </div>
              <div className="hero" style={{ padding: "6px 0 4px" }}>
                <div className="amount">{rupees(c.balance)}</div>
              </div>
              <StatusPill status={c.status} />
            </div>

            <Section>
              <Breakdown c={c} />
            </Section>

            {awaiting ? (
              <Section>
                <div className="banner purple">
                  <I.clock />
                  <div className="grow">
                    <b>{t("Waiting for confirmation")}</b>
                    <span>
                      {t("You told {value} you paid {amount}. They'll confirm it soon.", {
                        value: payee.name || "the owner",
                        amount: rupees(c.pending),
                      })}
                    </span>
                  </div>
                </div>
              </Section>
            ) : step === "pay" ? (
              <>
                {back && payee.upiId && (
                  <Section>
                    <div className="card return-card">
                      <div className="t-headline">{t("Did the payment go through?")}</div>
                      <div className="t-sub c2 mt8" style={{ marginTop: 4 }}>
                        {t("If your UPI app showed “Success”, let {ownerFirst} know so they can confirm it.", {
                          ownerFirst,
                        })}
                      </div>
                      <div className="btn-row mt12">
                        <button className="btn gray md" onClick={() => setBack(false)}>
                          {t("Not yet")}
                        </button>
                        <button className="btn green md" onClick={() => setStep("confirm")}>
                          <I.check /> {t("Yes, it's paid")}
                        </button>
                      </div>
                    </div>
                  </Section>
                )}
                {payee.upiId ? (
                  <>
                    <Section>
                      <div className="upi-hero">
                        <a
                          className="btn pay-btn"
                          href={link}
                          onClick={() => {
                            haptic();
                            setOpened(true);
                            rememberUpi(c.id);
                          }}
                          aria-label={t("Pay {amount} with a UPI app", { amount: rupees(c.balance) })}
                        >
                          <I.rupee /> {t("Pay")} {rupees(c.balance)} {t("with UPI")}
                        </a>
                        <div className="t-foot c2 center-text mt8">
                          {t("Opens GPay, PhonePe, Paytm, BHIM or your bank app with the amount filled in")}
                        </div>
                        <button type="button" className="qr-toggle" onClick={() => setShowQr((v) => !v)}>
                          <I.qr /> {showQr ? t("Hide QR code") : t("Scan from another phone")}
                        </button>
                        {showQr && (
                          <>
                            <QR
                              text={link}
                              label={t("UPI QR code to pay {amount} to {name}", {
                                amount: rupees(c.balance),
                                name: payee.name,
                              })}
                            />
                            <div className="list mt16">
                              <div className="row">
                                <span className="grow">
                                  <span className="sub" style={{ display: "block" }}>
                                    {t("Pay to")}
                                  </span>
                                  <span className="title" style={{ display: "block" }}>
                                    {payee.name || t("Owner")}
                                  </span>
                                </span>
                              </div>
                              <button className="row" onClick={copyUpi}>
                                <span className="grow">
                                  <span className="sub" style={{ display: "block" }}>
                                    {t("UPI ID")}
                                  </span>
                                  <span className="title num" style={{ display: "block" }}>
                                    {payee.upiId}
                                  </span>
                                </span>
                                <span className="end c-accent">
                                  <I.copy style={{ width: 20, height: 20 }} />
                                </span>
                              </button>
                            </div>
                          </>
                        )}
                      </div>
                    </Section>
                    <Section>
                      <button className={`btn ${opened ? "green" : "tinted"}`} onClick={() => setStep("confirm")}>
                        <I.checkCircle /> {t("I have paid")}
                      </button>
                      <button
                        type="button"
                        className="other-way"
                        onClick={() => {
                          setOther(true);
                          setStep("confirm");
                        }}
                      >
                        {t("Paid in cash or by bank transfer instead?")}
                      </button>
                    </Section>
                  </>
                ) : (
                  <>
                    <Section>
                      <div className="banner blue">
                        <I.wallet />
                        <div className="grow">
                          <b>{t("Pay {value} directly", { value: payee.name || "your owner" })}</b>
                          <span>
                            {t(
                              "Your owner hasn't added a UPI ID yet. Pay by cash, bank transfer or UPI as usual, then let them know here.",
                            )}
                          </span>
                        </div>
                      </div>
                    </Section>
                    <Section>
                      <button className="btn green" onClick={() => setStep("confirm")}>
                        <I.checkCircle /> {t("I have paid")}
                      </button>
                    </Section>
                  </>
                )}
              </>
            ) : (
              <>
                <Section
                  footer={
                    other
                      ? t(
                          "Let {ownerFirst} know you paid in cash or by bank transfer. Add the bank reference if you have one.",
                          { ownerFirst },
                        )
                      : t(
                          "You'll find the 12-digit UTR or UPI reference in your payment app's receipt. It helps the owner match your payment faster.",
                        )
                  }
                >
                  <div className="list">
                    <div className="row">
                      <span className="grow title">{t("Amount")}</span>
                      <span className="value num money" style={{ color: "var(--label)" }}>
                        {rupees(c.balance)}
                      </span>
                    </div>
                    <Field
                      label={other ? t("Reference (optional)") : t("UTR (optional)")}
                      value={utr}
                      onChange={setUtr}
                      inputMode={other ? "text" : "numeric"}
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
                    <button
                      className="btn gray"
                      onClick={() => {
                        setStep("pay");
                        setOther(false);
                      }}
                      disabled={busy}
                    >
                      {t("Back")}
                    </button>
                    <button className="btn" onClick={markPaid} disabled={busy}>
                      {busy ? <Spinner /> : t("Send to {ownerFirst}", { ownerFirst })}
                    </button>
                  </div>
                  <div className="t-foot c2 center-text mt12">
                    {t("Due {date}. Marked as “awaiting confirmation” until {ownerFirst} confirms.", {
                      date: dateLabel(c.dueDate, true),
                      ownerFirst,
                    })}
                  </div>
                </Section>
              </>
            )}
          </>
        )
      )}
    </Sheet>
  );
}

/** Rent, meter bill, what's already paid and what's left, before any payment button. */
function Breakdown({ c }: { c: LedgerRow }) {
  const t = useT();
  const extra = c.extra ?? 0;
  const late = c.overdue ? -daysFromToday(c.dueDate) : 0;
  return (
    <div className="list breakdown">
      <div className="row">
        <span className="grow">{t("Rent")}</span>
        <span className="num">{rupees(c.amount - extra)}</span>
      </div>
      {extra > 0 && (
        <div className="row">
          <span className="grow">
            {t("Meter bill")} <span className="c2">{t("(electricity / water)")}</span>
          </span>
          <span className="num">{rupees(extra)}</span>
        </div>
      )}
      {c.paid > 0 && (
        <div className="row">
          <span className="grow c-green">{t("Already paid")}</span>
          <span className="num c-green">−{rupees(c.paid)}</span>
        </div>
      )}
      <div className="row total">
        <span className="grow">
          {t("To pay")}
          <span className={`bd-due ${c.overdue ? "c-red" : "c2"}`}>
            {c.overdue
              ? t("{late} {value} late · was due {date}", {
                  late,
                  value: late === 1 ? t("day") : t("days"),
                  date: dateLabel(c.dueDate),
                })
              : t("Due {date}", { date: dateLabel(c.dueDate, true) })}
          </span>
        </span>
        <span className="num money">{rupees(c.balance)}</span>
      </div>
    </div>
  );
}

/** A calm "we've told them" state after "I have paid", with a shortcut to message the owner. */
export function SentState({
  amount,
  owner,
  waLink,
  onDone,
}: {
  amount: number;
  owner: string;
  waLink: string;
  onDone: () => void;
}) {
  const t = useT();
  return (
    <Section>
      <div className="center-text" style={{ padding: "12px 8px 4px" }}>
        <div className="paid-check sent-check">
          <I.check />
        </div>
        <div className="t-title2 mt16">{t("Sent to {owner}", { owner })}</div>
        <div className="t-sub c2" style={{ marginTop: 6 }}>
          {t("You told")} {owner} {t("you paid")} <b className="num">{rupees(amount)}</b>
          {t(". Owners usually confirm within a day. It shows as paid here as soon as they do.")}
        </div>
      </div>
      <div className="wait-steps mt16" aria-label={t("Payment progress")}>
        <span className="ws done">
          <I.check /> {t("Paid")}
        </span>
        <i />
        <span className="ws done">
          <I.check /> {t("Told")} {owner}
        </span>
        <i />
        <span className="ws now">
          <I.clock /> {t("Confirmation")}
        </span>
      </div>
      <div className="stack-8 mt24">
        {waLink && (
          <a className="btn whatsapp" href={waLink} target="_blank" rel="noopener noreferrer">
            <I.chat /> {t("Message")} {owner}
          </a>
        )}
        <button className="btn gray" onClick={onDone}>
          {t("Done")}
        </button>
      </div>
    </Section>
  );
}
