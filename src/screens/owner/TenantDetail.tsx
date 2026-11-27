import { useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { api, ApiError, invalidate, useApi } from "../../lib/api";
import { useAuth } from "../../lib/auth";
import {
  dateLabel,
  daysFromToday,
  monthLabel,
  ordinal,
  parseRentAmount,
  phoneLabel,
  rupees,
  todayISO,
} from "../../lib/format";
import { reminderText, telLink, whatsappLink } from "../../lib/links";
import type { TenantDetailResponse } from "../../lib/types";
import {
  Avatar,
  Empty,
  ErrorState,
  Field,
  FormError,
  Page,
  PRIORITY_COLOR,
  Row,
  Section,
  Sheet,
  SkeletonPage,
  Spinner,
  StatusPill,
  useToast,
} from "../../components/kit";
import { I } from "../../components/icons";
import { ChargeSheet, chargeSub, refreshRent } from "./ChargeSheet";
import { NewInviteSheet } from "./Invites";
import { MultiPaySheet } from "../shared/MultiPaySheet";
import { LeaseSection } from "./LeaseSection";
import "../../styles/owner.css";
import { useT } from "../../lib/i18n";

type Tn = TenantDetailResponse["tenancies"][number];

export default function TenantDetail() {
  const tx = useT();
  const { id = "" } = useParams();
  const { me } = useAuth();
  const isOwner = me?.profile?.role === "owner";
  const { data, error, loading, reload } = useApi<TenantDetailResponse>(`/api/tenants/${id}`);
  const [charge, setCharge] = useState<number | null>(null);
  const [editing, setEditing] = useState(false);
  const [editTn, setEditTn] = useState<Tn | null>(null);
  const [inviting, setInviting] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const [multi, setMulti] = useState(false);
  const nav = useNavigate();

  if (loading)
    return (
      <Page title="Tenant" back tabs={false} hideLarge>
        <SkeletonPage />
      </Page>
    );
  if (error || !data)
    return (
      <Page title="Tenant" back tabs={false}>
        <ErrorState error={error ?? { message: "Couldn't load this tenant." }} retry={reload} />
      </Page>
    );

  const { tenant: t, tenancies, ledger, requests } = data;
  const active = tenancies.find((x) => x.status === "active");
  const thisMonth = todayISO().slice(0, 7);
  // Months after this one aren't owed yet; money on them is rent paid ahead.
  const owed = (ledger ?? []).filter((r) => r.month <= thisMonth).reduce((s, r) => s + r.balance, 0);
  const aheadRows = (ledger ?? []).filter((r) => r.month > thisMonth && r.paid > 0);
  const aheadPaid = aheadRows.reduce((s, r) => s + r.paid, 0);
  const paidThrough = [...aheadRows].filter((r) => r.balance === 0).sort((a, b) => b.month.localeCompare(a.month))[0];
  const overdue = (ledger ?? []).filter((r) => r.overdue);
  const oldestDue = [...(ledger ?? [])]
    .filter((r) => r.balance > 0 && r.month <= thisMonth)
    .sort((a, b) => a.month.localeCompare(b.month))[0];
  const ownerName = me?.profile?.fullName || "Owner";
  const shownLedger = showAll ? (ledger ?? []) : (ledger ?? []).slice(0, 6);
  const paidTotal = (ledger ?? []).reduce((s, r) => s + r.paid, 0);

  return (
    <Page title={t.fullName} back tabs={false} hideLarge>
      <div className="center-text" style={{ padding: "4px 20px 18px" }}>
        <div style={{ display: "inline-block" }}>
          <Avatar name={t.fullName} size="lg" />
        </div>
        <div className="t-title1 mt12">{t.fullName}</div>
        <div className="t-sub c2" style={{ marginTop: 2 }}>
          {active ? `${active.unitLabel} · ${active.propertyName}` : tx("No active tenancy")}
        </div>
        <div className="hstack mt8" style={{ justifyContent: "center" }}>
          {active ? (
            <span className="pill green">{tx("Active")}</span>
          ) : (
            <span className="pill gray">{tx("Moved out")}</span>
          )}
          {t.linked ? (
            <span className="pill blue">{tx("On pOS")}</span>
          ) : (
            <span className="pill gray">{tx("Not on app")}</span>
          )}
        </div>
      </div>

      <Section>
        <div className="actions">
          {t.phone ? (
            <a className="action" href={telLink(t.phone)}>
              <I.phone /> {tx("Call")}
            </a>
          ) : (
            <span className="action" aria-disabled="true">
              <I.phone /> {tx("Call")}
            </span>
          )}
          {t.phone ? (
            <a
              className="action"
              target="_blank"
              rel="noopener noreferrer"
              href={whatsappLink(
                t.phone,
                isOwner && oldestDue
                  ? reminderText({ ...oldestDue, tenantName: t.fullName }, ownerName)
                  : `Hi ${t.fullName.split(/[\s&]/)[0]}, `,
              )}
            >
              <I.chat /> {isOwner && overdue.length ? tx("Remind") : tx("WhatsApp")}
            </a>
          ) : (
            <span className="action" aria-disabled="true">
              <I.chat /> {tx("WhatsApp")}
            </span>
          )}
          {isOwner && oldestDue && (
            <button className="action" onClick={() => setCharge(oldestDue.id)}>
              <I.rupee /> {tx("Record")}
            </button>
          )}
          {isOwner && active && (
            <button className="action" onClick={() => setMulti(true)}>
              <I.calendar /> {tx("Months")}
            </button>
          )}
          {isOwner && !t.linked && active && (
            <button className="action" onClick={() => setInviting(true)}>
              <I.userPlus /> {tx("Invite")}
            </button>
          )}
          {isOwner && (
            <button className="action" onClick={() => setEditing(true)}>
              <I.pencil /> {tx("Edit")}
            </button>
          )}
        </div>
      </Section>

      {isOwner && ledger && (
        <Section>
          {overdue.length > 0 ? (
            <div className="banner">
              <I.alert />
              <div className="grow">
                <b>{tx("{amount} overdue", { amount: rupees(overdue.reduce((s, r) => s + r.balance, 0)) })}</b>
                <span>
                  {overdue.length === 1
                    ? tx("{value} rent was due {date}.", {
                        value: monthLabel(overdue[0].month, true),
                        date: dateLabel(overdue[0].dueDate),
                      })
                    : tx("{n} months are unpaid past their due date.", { n: overdue.length })}
                </span>
              </div>
            </div>
          ) : (
            <div className="summary-card" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
              <div className="stat">
                <div className={`k ${owed ? "c-orange" : "c-green"}`}>
                  {owed ? tx("Balance due") : tx("All paid up")}
                </div>
                <div className="v">{rupees(owed)}</div>
              </div>
              <div className="stat">
                <div className="k">{tx("Paid to date")}</div>
                <div className="v">{rupees(paidTotal)}</div>
              </div>
            </div>
          )}
          {aheadPaid > 0 && (
            <div className="banner blue mt12">
              <I.calendar />
              <div className="grow">
                <b>
                  {paidThrough
                    ? tx("Paid through {value}", { value: monthLabel(paidThrough.month, true) })
                    : tx("{amount} paid ahead", { amount: rupees(aheadPaid) })}
                </b>
                <span>
                  {tx(
                    "{amount} received for {n} upcoming {value}. Reports count it as income in the month it was received.",
                    {
                      amount: rupees(aheadPaid),
                      n: aheadRows.length,
                      value: aheadRows.length === 1 ? tx("month") : tx("months"),
                    },
                  )}
                </span>
              </div>
            </div>
          )}
        </Section>
      )}

      {isOwner && data.pendingInvite && !t.linked && (
        <Section>
          <div className="banner blue">
            <I.link />
            <div className="grow">
              <b>{tx("Invite sent")}</b>
              <span>
                {tx("Waiting for {value} to join. The link expires {date}.", {
                  value: t.fullName.split(/[\s&]/)[0],
                  date: dateLabel(data.pendingInvite.expiresAt),
                })}
              </span>
            </div>
            <button className="btn sm tinted" onClick={() => nav("/more/invites")}>
              {tx("View")}
            </button>
          </div>
        </Section>
      )}

      {active && <TenancyCard tn={active} isOwner={isOwner} onEdit={() => setEditTn(active)} />}
      {isOwner && (active ?? tenancies[0]) && (
        <LeaseSection
          key={(active ?? tenancies[0]).id}
          tenancyId={(active ?? tenancies[0]).id}
          tenantId={t.id}
          tenantName={t.fullName}
        />
      )}

      <Section title="Contact">
        <div className="list">
          <Row
            title="Mobile"
            value={
              t.phone ? (
                <a href={telLink(t.phone)} className="c-accent num">
                  {phoneLabel(t.phone)}
                </a>
              ) : (
                "—"
              )
            }
          />
          <Row
            title="Email"
            value={
              <span className="ellipsis" style={{ maxWidth: 210, display: "inline-block", verticalAlign: "bottom" }}>
                {t.email || "—"}
              </span>
            }
          />
          <Row title="Emergency" sub={t.emergencyContact || tx("Not added")} />
          {isOwner && <Row title="ID" sub={t.idNote || tx("Not added")} />}
          <Row title="Moved in" value={t.moveInDate ? dateLabel(t.moveInDate, true) : "—"} />
        </div>
      </Section>

      {ledger && (
        <Section
          title="Payment history"
          action={
            ledger.length > 6 ? (
              <button onClick={() => setShowAll((v) => !v)}>
                {showAll ? tx("Show less") : tx("All {n}", { n: ledger.length })}
              </button>
            ) : undefined
          }
        >
          {ledger.length ? (
            <div className="list">
              {shownLedger.map((r) => (
                <Row
                  key={r.id}
                  title={monthLabel(r.month, true)}
                  sub={`${r.unitLabel} · ${chargeSub(r)}`}
                  end={
                    <span className="stack">
                      <span className={`num w6 ${r.overdue ? "c-red" : ""}`}>
                        {rupees(r.balance > 0 ? r.balance : r.amount)}
                      </span>
                      <StatusPill status={r.status} />
                    </span>
                  }
                  chevron
                  onClick={() => setCharge(r.id)}
                />
              ))}
            </div>
          ) : (
            <div className="card tight t-sub c2 center-text">
              {tx("No charges yet. The first one appears in the month the tenancy starts.")}
            </div>
          )}
        </Section>
      )}

      <Section title="Requests">
        {requests.length ? (
          <div className="list">
            {requests.map((r) => (
              <Row
                key={r.id}
                title={
                  <span className="hstack" style={{ gap: 10 }}>
                    <span className="dot" style={{ background: PRIORITY_COLOR[r.priority] }} />
                    {r.title}
                  </span>
                }
                sub={<span style={{ paddingLeft: 18 }}>{dateLabel(r.createdAt, true)}</span>}
                end={<StatusPill status={r.status} />}
                chevron
                to={`/requests/${r.id}`}
              />
            ))}
          </div>
        ) : (
          <div className="card tight t-sub c2 center-text">{tx("No maintenance requests for this tenant's unit.")}</div>
        )}
      </Section>

      {tenancies.filter((x) => x.status !== "active").length > 0 && (
        <Section title="Past tenancies">
          <div className="list">
            {tenancies
              .filter((x) => x.status !== "active")
              .map((x) => (
                <Row
                  key={x.id}
                  title={`${x.unitLabel} · ${x.propertyName}`}
                  sub={`${dateLabel(x.startDate, true)} – ${(x.moveOutDate ?? x.endDate) ? dateLabel((x.moveOutDate ?? x.endDate)!, true) : "?"}`}
                  value={x.rent !== undefined ? <span className="num">{rupees(x.rent)}</span> : undefined}
                  chevron={isOwner}
                  onClick={isOwner ? () => nav(`/tenants/${t.id}/settlement?tenancy=${x.id}`) : undefined}
                />
              ))}
          </div>
        </Section>
      )}

      {isOwner && (
        <>
          <ChargeSheet chargeId={charge} onClose={() => setCharge(null)} />
          <MultiPaySheet
            tenancyId={multi && active ? active.id : null}
            role="owner"
            unitLabel={active?.unitLabel ?? ""}
            tenantName={t.fullName}
            onClose={() => setMulti(false)}
            onRecorded={refreshRent}
          />
          <EditTenantSheet open={editing} onClose={() => setEditing(false)} t={t} />
          <TenancySheet tn={editTn} onClose={() => setEditTn(null)} tenantName={t.fullName} />
          <NewInviteSheet
            open={inviting}
            onClose={() => {
              setInviting(false);
              invalidate(`/api/tenants/${t.id}`);
            }}
            tenantId={t.id}
          />
        </>
      )}
      {!ledger && !requests.length && !active && (
        <Empty icon="person" title="Nothing more to show" text="This tenant has no active tenancy." />
      )}
    </Page>
  );
}

function TenancyCard({ tn, isOwner, onEdit }: { tn: Tn; isOwner: boolean; onEdit: () => void }) {
  const tx = useT();
  const left = tn.endDate ? daysFromToday(tn.endDate) : null;
  return (
    <Section title="Tenancy" action={isOwner ? <button onClick={onEdit}>{tx("Edit")}</button> : undefined}>
      <div className="list icons">
        <Row icon="building" iconBg="var(--accent)" title={tn.unitLabel} sub={tn.propertyName} />
        {tn.rent !== undefined && (
          <Row
            icon="rupee"
            iconBg="var(--green)"
            title="Monthly rent"
            value={<span className="num">{rupees(tn.rent)}</span>}
          />
        )}
        <Row icon="calendar" iconBg="var(--orange)" title="Due day" value={`${ordinal(tn.dueDay)} of each month`} />
        {tn.deposit !== undefined && (
          <Row
            icon="wallet"
            iconBg="var(--indigo)"
            title="Deposit"
            value={<span className="num">{rupees(tn.deposit)}</span>}
          />
        )}
        <Row
          icon="key"
          iconBg="var(--teal)"
          title="Lease"
          value={`${dateLabel(tn.startDate, true)} – ${tn.endDate ? dateLabel(tn.endDate, true) : "ongoing"}`}
          sub={
            tn.moveOutDate
              ? tx("Moving out {date}", { date: dateLabel(tn.moveOutDate, true) })
              : tn.state === "holdover"
                ? tx("Holdover: past the end date, still billed")
                : left !== null && left >= 0 && left <= 60
                  ? tx("Ends in {left} days", { left })
                  : undefined
          }
        />
      </div>
    </Section>
  );
}

function EditTenantSheet({
  open,
  onClose,
  t,
}: {
  open: boolean;
  onClose: () => void;
  t: TenantDetailResponse["tenant"];
}) {
  const toast = useToast();
  const init = () => ({
    fullName: t.fullName,
    phone: t.phone,
    email: t.email,
    idNote: t.idNote,
    emergencyContact: t.emergencyContact,
  });
  const [f, setF] = useState(init);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const set = (k: keyof ReturnType<typeof init>) => (v: string) => setF((x) => ({ ...x, [k]: v }));

  async function save() {
    if (!f.fullName.trim()) return setErr("Enter the tenant's name.");
    setBusy(true);
    setErr("");
    try {
      await api(`/api/tenants/${t.id}`, { method: "PATCH", body: f });
      refreshRent();
      invalidate("/api/workspace", "/api/requests");
      toast("Details saved");
      onClose();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : "Couldn't save.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Sheet open={open} onClose={onClose} title="Edit tenant" onDone={save} busy={busy}>
      <Section>
        <div className="list">
          <Field label="Name" value={f.fullName} onChange={set("fullName")} maxLength={80} />
          <Field label="Mobile" value={f.phone} onChange={set("phone")} type="tel" inputMode="tel" maxLength={20} />
          <Field label="Email" value={f.email} onChange={set("email")} type="email" inputMode="email" maxLength={120} />
          <Field label="ID note" value={f.idNote} onChange={set("idNote")} maxLength={200} />
          <Field label="Emergency" value={f.emergencyContact} onChange={set("emergencyContact")} maxLength={120} />
        </div>
        <FormError text={err} />
      </Section>
    </Sheet>
  );
}

function TenancySheet({ tn, onClose, tenantName }: { tn: Tn | null; onClose: () => void; tenantName: string }) {
  return (
    <Sheet open={!!tn} onClose={onClose} title="Tenancy">
      {tn && <TenancyForm key={tn.id} tn={tn} onClose={onClose} tenantName={tenantName} />}
    </Sheet>
  );
}

function TenancyForm({ tn, onClose, tenantName }: { tn: Tn; onClose: () => void; tenantName: string }) {
  const tx = useT();
  const toast = useToast();
  const [rent, setRent] = useState(String(tn.rent ?? ""));
  const [dueDay, setDueDay] = useState(String(tn.dueDay));
  const [deposit, setDeposit] = useState(String(tn.deposit ?? ""));
  const [endDate, setEndDate] = useState(tn.endDate ?? "");
  const [moveOut, setMoveOut] = useState(todayISO());
  const [ending, setEnding] = useState(false);
  const [busy, setBusy] = useState("");
  const [err, setErr] = useState("");

  async function save() {
    const d = Number(dueDay);
    const monthlyRent = parseRentAmount(rent, 1);
    const depositAmount = parseRentAmount(deposit);
    if (monthlyRent === null) return setErr("Enter a valid monthly rent.");
    if (depositAmount === null) return setErr("Enter a valid deposit.");
    if (!Number.isInteger(d) || d < 1 || d > 28) return setErr("The due day must be between 1 and 28.");
    if (endDate && endDate < tn.startDate) return setErr("The end date must be after the start date.");
    setBusy("save");
    setErr("");
    try {
      await api(`/api/tenancies/${tn.id}`, {
        method: "PATCH",
        body: { rent: monthlyRent, dueDay: d, deposit: depositAmount, endDate: endDate || null },
      });
      refreshRent();
      toast("Tenancy updated");
      onClose();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : "Couldn't save.");
    } finally {
      setBusy("");
    }
  }
  async function end() {
    if (!ending) return setEnding(true);
    setBusy("end");
    setErr("");
    try {
      const r = await api<{ scheduled?: boolean; endDate?: string }>(`/api/tenancies/${tn.id}/end`, {
        body: { endDate: moveOut },
      });
      refreshRent();
      invalidate("/api/workspace");
      const first = tenantName.split(/[\s&]/)[0];
      toast(r.scheduled && r.endDate ? `${first} moves out on ${dateLabel(r.endDate, true)}` : `${first} moved out`);
      onClose();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : "Couldn't end the tenancy.");
    } finally {
      setBusy("");
    }
  }

  return (
    <>
      <Section
        title={`${tn.unitLabel} · ${tn.propertyName}`}
        footer="Edits are kept in the lease history. To raise the rent from a date (and update unpaid months), use Renew or revise rent instead."
      >
        <div className="list">
          <Field label="Monthly rent" value={rent} onChange={setRent} inputMode="numeric" prefix="₹" />
          <Field label="Due day" value={dueDay} onChange={setDueDay} inputMode="numeric" maxLength={2} />
          <Field label="Deposit" value={deposit} onChange={setDeposit} inputMode="numeric" prefix="₹" />
          <Field label="Lease ends" type="date" value={endDate} onChange={setEndDate} />
        </div>
        <FormError text={err} />
        <button className="btn mt12" onClick={save} disabled={!!busy}>
          {busy === "save" ? <Spinner /> : tx("Save changes")}
        </button>
      </Section>
      <Section
        title="Move out"
        footer="Ending the tenancy frees the unit and stops new charges; the history stays. A future date keeps rent running until then. Settle the deposit from Move-out & deposit on the lease."
      >
        {ending && (
          <div className="list mb8">
            <Field label="Move-out date" type="date" value={moveOut} onChange={setMoveOut} />
          </div>
        )}
        <button className="btn danger" onClick={end} disabled={!!busy}>
          {busy === "end" ? <Spinner /> : ending ? tx("Confirm move-out") : tx("End tenancy")}
        </button>
      </Section>
    </>
  );
}
