import { useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { useNavigate, useSearchParams } from "react-router-dom";
import { api, invalidate, useApi } from "../../lib/api";
import { useAuth } from "../../lib/auth";
import { features } from "../../lib/features";
import { daysFromToday, monthLabel, rupees } from "../../lib/format";
import { reminderText, whatsappLink } from "../../lib/links";
import { haptic } from "../../lib/perf";
import type { ChargeStatus, LedgerResponse, LedgerRow } from "../../lib/types";
import {
  Avatar,
  Empty,
  ErrorState,
  Page,
  Section,
  Segmented,
  Sheet,
  Skeleton,
  Spinner,
  StatusPill,
} from "../../components/kit";
import { I } from "../../components/icons";
import { ChargeSheet, chargeSub } from "./ChargeSheet";
import { AwaitingCard, pendingOf, usePaymentDecisions } from "./confirm";
import "../../styles/owner.css";
import { useT } from "../../lib/i18n";

type Filter = "all" | "unpaid" | "awaiting" | "paid";
const ORDER: Record<ChargeStatus, number> = { overdue: 0, awaiting: 1, partial: 2, due: 3, upcoming: 4, paid: 5 };

export default function Rent() {
  const t = useT();
  const { data, error, loading, reload } = useApi<LedgerResponse>("/api/ledger");
  const [params, setParams] = useSearchParams();
  const view = params.get("view"); // "overdue" | "awaiting" | null
  const [month, setMonth] = useState("");
  const [prop, setProp] = useState(0);
  const [filter, setFilter] = useState<Filter>(view === "awaiting" ? "awaiting" : "all");
  const [charge, setCharge] = useState<number | null>(null);
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [remindAll, setRemindAll] = useState(false);
  const decide = usePaymentDecisions();
  const nav = useNavigate();

  const overdueMode = view === "overdue";
  const awaitingAll = view === "awaiting";
  const m = month || data?.months[0] || "";

  const all = data?.rows ?? [];
  const overdueRows = all.filter((r) => r.overdue);
  const overdueTotal = overdueRows.reduce((s, r) => s + r.balance, 0);
  const awaitingCount = all.filter((r) => r.status === "awaiting").length;

  const rows = useMemo(() => {
    let rs = overdueMode
      ? overdueRows
      : awaitingAll
        ? all.filter((r) => r.status === "awaiting")
        : all.filter((r) => r.month === m);
    if (prop) rs = rs.filter((r) => r.propertyId === prop);
    if (!overdueMode && !awaitingAll) {
      if (filter === "unpaid") rs = rs.filter((r) => r.balance > 0 && r.status !== "awaiting");
      if (filter === "awaiting") rs = rs.filter((r) => r.status === "awaiting");
      if (filter === "paid") rs = rs.filter((r) => r.status === "paid");
    }
    return [...rs].sort(
      (a, b) =>
        ORDER[a.status] - ORDER[b.status] || a.month.localeCompare(b.month) || a.unitLabel.localeCompare(b.unitLabel),
    );
  }, [all, m, prop, filter, overdueMode, awaitingAll]); // eslint-disable-line react-hooks/exhaustive-deps

  // Claims waiting for the owner are shown as confirm cards, not ledger lines.
  const showCards = awaitingAll || (!overdueMode && filter === "awaiting");
  const claimRows = showCards ? rows.filter((r) => pendingOf(r).length > 0) : [];
  const picked = claimRows.filter((r) => selected.has(r.id));
  const pickedTotal = picked.reduce((s, r) => s + pendingOf(r)[0].amount, 0);
  const toggle = (id: number) =>
    setSelected((cur) => {
      const n = new Set(cur);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  const stopSelecting = () => {
    setSelecting(false);
    setSelected(new Set());
  };
  async function confirmPicked() {
    await decide.confirmMany(picked.map((r) => ({ payment: pendingOf(r)[0], who: r.tenantName })));
    stopSelecting();
  }

  const monthRows = all.filter((r) => r.month === m && (!prop || r.propertyId === prop));
  const sum = (k: "amount" | "paid" | "balance") => monthRows.reduce((s, r) => s + r[k], 0);

  const pickMonth = (v: string) => {
    setMonth(v);
    if (view) setParams({}, { replace: true });
  };

  return (
    <Page
      title="Rent"
      eyebrow={overdueMode ? t("Overdue") : awaitingAll ? t("To confirm") : m ? monthLabel(m, true) : undefined}
    >
      {loading ? (
        <>
          <div className="filters">
            <div className="sk" style={{ height: 34, width: "70%", borderRadius: 17 }} />
          </div>
          <Section>
            <div className="sk" style={{ height: 74, borderRadius: 18 }} />
          </Section>
          <Section>
            <Skeleton rows={5} />
          </Section>
        </>
      ) : error || !data ? (
        <ErrorState error={error ?? { message: "Couldn't load the ledger." }} retry={reload} />
      ) : !all.length ? (
        <Empty
          icon="rupee"
          title="No rent yet"
          text="Add a tenant with a monthly rent and due day. pOS creates one charge per month automatically, without duplicates."
          action={
            <button className="btn md auto" onClick={() => nav("/tenants?new=1")}>
              <I.userPlus /> {t("Add tenant")}
            </button>
          }
        />
      ) : (
        <>
          <div className="filters">
            <div className="chips" role="group" aria-label={t("Month")}>
              {overdueRows.length > 0 && (
                <button
                  type="button"
                  className="chip danger"
                  aria-pressed={overdueMode}
                  onClick={() => setParams(overdueMode ? {} : { view: "overdue" }, { replace: true })}
                >
                  {t("Overdue · {n}", { n: overdueRows.length })}
                </button>
              )}
              {awaitingCount > 0 && (
                <button
                  type="button"
                  className="chip purple"
                  aria-pressed={awaitingAll}
                  onClick={() => {
                    stopSelecting();
                    setParams(awaitingAll ? {} : { view: "awaiting" }, { replace: true });
                  }}
                >
                  {t("To confirm · {awaitingCount}", { awaitingCount })}
                </button>
              )}
              {data.months.map((x) => (
                <button
                  key={x}
                  type="button"
                  className="chip"
                  aria-pressed={!view && x === m}
                  onClick={() => pickMonth(x)}
                >
                  {monthLabel(x)}
                </button>
              ))}
            </div>
            {data.properties.length > 1 && (
              <div className="chips" role="group" aria-label={t("Property")}>
                <button type="button" className="chip" aria-pressed={!prop} onClick={() => setProp(0)}>
                  {t("All properties")}
                </button>
                {data.properties.map((p) => (
                  <button
                    key={p.id}
                    type="button"
                    className="chip"
                    aria-pressed={prop === p.id}
                    onClick={() => setProp(p.id)}
                  >
                    {p.name}
                  </button>
                ))}
              </div>
            )}
          </div>

          {overdueMode ? (
            <Section>
              <div className="banner">
                <I.alert />
                <div className="grow">
                  <b>{t("{amount} overdue", { amount: rupees(overdueTotal) })}</b>
                  <span>{t("Tap a charge to record a payment, or remind everyone in one go.")}</span>
                </div>
                {overdueRows.some((r) => r.tenantPhone) && (
                  <button className="btn sm whatsapp" onClick={() => setRemindAll(true)}>
                    <I.chat /> {t("Remind all")}
                  </button>
                )}
              </div>
            </Section>
          ) : awaitingAll ? (
            <Section>
              <div className="banner purple">
                <I.clock />
                <div className="grow">
                  <b>{t("Payments to confirm")}</b>
                  <span>
                    {t(
                      "UPI can't confirm payments automatically. Match the amount or UTR in your bank app, then confirm. Several paid the same day? Tap Select.",
                    )}
                  </span>
                </div>
              </div>
            </Section>
          ) : (
            <>
              <Section>
                <div className="summary-strip">
                  <div className="stat">
                    <div className="k">{t("Due")}</div>
                    <div className="v">{rupees(sum("amount"))}</div>
                  </div>
                  <div className="stat">
                    <div className="k c-green">{t("Collected")}</div>
                    <div className="v">{rupees(sum("paid"))}</div>
                  </div>
                  <div className="stat">
                    <div className={`k ${sum("balance") ? "c-orange" : ""}`}>{t("Left")}</div>
                    <div className="v">{rupees(sum("balance"))}</div>
                  </div>
                </div>
              </Section>
              <Section>
                <Segmented
                  label="Status"
                  value={filter}
                  onChange={setFilter}
                  options={[
                    { value: "all", label: "All" },
                    { value: "unpaid", label: "Unpaid" },
                    { value: "awaiting", label: "To confirm" },
                    { value: "paid", label: "Paid" },
                  ]}
                />
              </Section>
            </>
          )}

          {showCards ? (
            <Section
              title={claimRows.length ? t("{n} to confirm", { n: claimRows.length }) : undefined}
              action={
                claimRows.length > 1 ? (
                  selecting ? (
                    <button onClick={stopSelecting}>{t("Cancel")}</button>
                  ) : (
                    <button
                      onClick={() => {
                        haptic();
                        setSelecting(true);
                      }}
                    >
                      {t("Select")}
                    </button>
                  )
                ) : undefined
              }
            >
              {selecting && (
                <div className="hstack mb8" style={{ justifyContent: "flex-end" }}>
                  <button
                    className="t-sub c-accent"
                    onClick={() =>
                      setSelected(picked.length === claimRows.length ? new Set() : new Set(claimRows.map((r) => r.id)))
                    }
                  >
                    {picked.length === claimRows.length ? t("Clear all") : t("Select all")}
                  </button>
                </div>
              )}
              {claimRows.length ? (
                claimRows.map((r) => (
                  <AwaitingCard
                    key={r.id}
                    row={r}
                    onOpen={() => setCharge(r.id)}
                    showMonth
                    selectable={selecting}
                    selected={selected.has(r.id)}
                    onSelect={() => toggle(r.id)}
                  />
                ))
              ) : (
                <div className="card">
                  <Empty
                    icon="checkCircle"
                    title="Nothing to confirm"
                    text="When a tenant taps “I have paid”, it lands here for you to check against your bank app."
                  />
                </div>
              )}
            </Section>
          ) : (
            <Section>
              {rows.length ? (
                <div className="list dense">
                  {rows.map((r) => (
                    <LedgerLine
                      key={r.id}
                      r={r}
                      showMonth={overdueMode || awaitingAll}
                      onOpen={() => setCharge(r.id)}
                    />
                  ))}
                </div>
              ) : (
                <div className="card">
                  <Empty
                    icon="checkCircle"
                    title="Nothing here"
                    text={
                      filter === "paid"
                        ? t("No charges are fully paid for this month yet.")
                        : t("Every charge in this view is settled.")
                    }
                  />
                </div>
              )}
            </Section>
          )}
        </>
      )}
      {selecting &&
        picked.length > 0 &&
        createPortal(
          <div className="bulk-bar" role="region" aria-label={t("Confirm selected payments")}>
            <span className="grow">
              <b>{t("{n} selected", { n: picked.length })}</b>
              <br />
              <span className="c2 num">{rupees(pickedTotal)}</span>
            </span>
            <button className="btn green md" disabled={decide.busy === "many"} onClick={confirmPicked}>
              {decide.busy === "many" ? (
                <Spinner />
              ) : (
                <>
                  <I.check /> {t("Confirm")} {picked.length}
                </>
              )}
            </button>
          </div>,
          document.body,
        )}
      <RemindAllSheet open={remindAll} rows={overdueRows} onClose={() => setRemindAll(false)} />
      <ChargeSheet chargeId={charge} onClose={() => setCharge(null)} />
    </Page>
  );
}

function LedgerLine({ r, onOpen, showMonth }: { r: LedgerRow; onOpen: () => void; showMonth: boolean }) {
  return (
    <button type="button" className="row" onClick={onOpen}>
      <Avatar name={r.tenantName} />
      <span className="grow">
        <span className="title" style={{ display: "block" }}>
          {r.tenantName}
        </span>
        <span className="sub" style={{ display: "block" }}>
          {showMonth ? `${monthLabel(r.month)} · ` : ""}
          {r.unitLabel} · {chargeSub(r)}
        </span>
      </span>
      <span className="end">
        <span className="stack">
          <span className={`num money ${r.overdue ? "c-red" : ""}`}>
            {rupees(r.balance > 0 ? r.balance : r.amount)}
          </span>
          <StatusPill status={r.status} />
        </span>
        <I.chevR className="chev" />
      </span>
    </button>
  );
}

/**
 * WhatsApp can't send in bulk, so this is a queue: one tap per tenant opens the prefilled message, and each sent
 * reminder is ticked off (and logged when automations are on) so nobody gets two.
 */
function RemindAllSheet({ open, rows, onClose }: { open: boolean; rows: LedgerRow[]; onClose: () => void }) {
  const t = useT();
  const { me } = useAuth();
  const owner = me?.profile?.fullName || "Owner";
  const [sent, setSent] = useState<Set<number>>(new Set());
  const withPhone = rows.filter((r) => r.tenantPhone);
  const left = withPhone.filter((r) => !sent.has(r.id)).length;
  return (
    <Sheet open={open} onClose={onClose} title="Remind overdue tenants">
      <Section
        footer={
          left
            ? t(
                "{left} still to send. Each tap opens WhatsApp with the message written; send it and come back for the next.",
                { left },
              )
            : t("All reminders sent. Payments show up under To confirm as tenants respond.")
        }
      >
        <div className="list dense">
          {withPhone.map((r) => {
            const done = sent.has(r.id);
            const late = -daysFromToday(r.dueDate);
            return (
              <a
                key={r.id}
                className="row"
                href={whatsappLink(r.tenantPhone, reminderText(r, owner))}
                target="_blank"
                rel="noopener noreferrer"
                onClick={() => {
                  haptic();
                  setSent((cur) => new Set(cur).add(r.id));
                  if (features.automations)
                    void api(`/api/charges/${r.id}/reminded`, { method: "POST" })
                      .then(() => invalidate("/api/reminders"))
                      .catch(() => {
                        /* the reminder itself went out on WhatsApp; only the log entry failed */
                      });
                }}
              >
                <Avatar name={r.tenantName} />
                <span className="grow">
                  <span className="title" style={{ display: "block" }}>
                    {r.tenantName}
                  </span>
                  <span className="sub" style={{ display: "block" }}>
                    {t("{value} · {amount} · {late} {value2} late", {
                      value: monthLabel(r.month),
                      amount: rupees(r.balance),
                      late,
                      value2: late === 1 ? t("day") : t("days"),
                    })}
                  </span>
                </span>
                <span className="end">
                  {done ? (
                    <StatusPill status="done" label="Sent" />
                  ) : (
                    <span className="mini-btn wa-btn">
                      <I.chat /> {t("Send")}
                    </span>
                  )}
                </span>
              </a>
            );
          })}
        </div>
      </Section>
    </Sheet>
  );
}
