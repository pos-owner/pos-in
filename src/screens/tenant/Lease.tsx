import { useState } from "react";
import { ApiError, sharePdf, useApi } from "../../lib/api";
import { dateLabel, ordinal, rupees } from "../../lib/format";
import type { LeaseResponse } from "../../lib/types";
import { Empty, ErrorState, Page, Row, Section, SkeletonPage, Spinner, useToast } from "../../components/kit";
import { I } from "../../components/icons";
import { LEASE_STATE, TERM_REASON, leaseStatusText, termLine } from "../../lib/lease";
import "../../styles/tenant.css";
import { useT } from "../../lib/i18n";

/** The tenant's lease: current terms, history of renewals and rent changes, and the final deposit settlement. Route: /lease */
export default function Lease() {
  const tx = useT();
  const { data, error, loading, reload } = useApi<{ lease: LeaseResponse | null }>("/api/tenant/lease");
  const toast = useToast();
  const [busy, setBusy] = useState(false);

  if (loading)
    return (
      <Page title="My lease" back tabs={false}>
        <SkeletonPage variant="detail" />
      </Page>
    );
  if (error || !data)
    return (
      <Page title="My lease" back tabs={false}>
        <ErrorState error={error ?? { message: "Couldn't load your lease." }} retry={reload} />
      </Page>
    );
  if (!data.lease)
    return (
      <Page title="My lease" back tabs={false}>
        <Empty icon="key" title="No lease yet" text="Your owner hasn't linked a tenancy to your account." />
      </Page>
    );

  const { tenancy: tn, terms, settlement: s } = data.lease;
  const st = LEASE_STATE[tn.state];

  async function statement() {
    if (!s) return;
    setBusy(true);
    try {
      await sharePdf(
        `/api/tenancies/${tn.id}/settlement.json`,
        `${s.number || "Settlement"}.pdf`,
        "Deposit settlement",
      );
    } catch (e) {
      toast(e instanceof ApiError ? e.message : "Couldn't prepare the statement.", "alert");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Page title="My lease" back tabs={false}>
      <Section>
        <div className={`banner ${tn.state === "holdover" || tn.state === "ending" ? "orange" : "blue"}`}>
          <I.key />
          <div className="grow">
            <b>
              {tn.unitLabel} · {tn.propertyName}{" "}
              <span className={`pill ${st.cls}`} style={{ marginLeft: 4 }}>
                {st.label}
              </span>
            </b>
            <span>{leaseStatusText(tn, true)}</span>
          </div>
        </div>
      </Section>

      <Section title="Current terms">
        <div className="list icons">
          <Row
            icon="rupee"
            iconBg="var(--green)"
            title="Monthly rent"
            value={<span className="num">{rupees(tn.rent)}</span>}
          />
          <Row icon="calendar" iconBg="var(--orange)" title="Due day" value={`${ordinal(tn.dueDay)} of each month`} />
          <Row
            icon="wallet"
            iconBg="var(--indigo)"
            title="Deposit"
            value={<span className="num">{rupees(tn.deposit)}</span>}
          />
          <Row
            icon="key"
            iconBg="var(--teal)"
            title="Lease"
            value={`${dateLabel(tn.startDate, true)} – ${tn.endDate ? dateLabel(tn.endDate, true) : "ongoing"}`}
          />
          {tn.moveOutDate && (
            <Row
              icon="out"
              iconBg="var(--purple, var(--indigo))"
              title="Moving out"
              value={dateLabel(tn.moveOutDate, true)}
            />
          )}
        </div>
      </Section>

      {s && (
        <Section
          title="Deposit settlement"
          footer={
            s.refundAmount > 0 && s.refundStatus !== "paid"
              ? tx("Your owner will mark the refund as paid once it's sent.")
              : undefined
          }
        >
          <div className="summary-card" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
            <div className="stat">
              <div className="k">{tx("Deposit held")}</div>
              <div className="v">{rupees(s.depositHeld)}</div>
            </div>
            <div className="stat">
              <div className={`k ${s.refundAmount < 0 ? "c-red" : "c-green"}`}>
                {s.refundAmount < 0 ? tx("You still owe") : tx("Refund")}
              </div>
              <div className="v">{rupees(Math.abs(s.refundAmount))}</div>
            </div>
          </div>
          <div className="list mt12">
            {s.deductions.map((d) => (
              <Row
                key={d.id}
                title={d.description}
                sub={d.kind}
                value={<span className="num">−{rupees(d.amount)}</span>}
              />
            ))}
            {s.advanceUnused > 0 && (
              <Row
                title="Rent paid for months after move-out"
                value={<span className="num">+{rupees(s.advanceUnused)}</span>}
              />
            )}
            {s.refundAmount > 0 && (
              <Row
                title="Refund status"
                value={
                  s.refundStatus === "paid"
                    ? `Paid ${s.refundPaidOn ? dateLabel(s.refundPaidOn, true) : ""}`
                    : "Pending"
                }
              />
            )}
          </div>
          <button className="btn tinted md mt12" onClick={statement} disabled={busy}>
            {busy ? (
              <Spinner />
            ) : (
              <>
                <I.receipt /> {tx("Settlement statement (PDF)")}
              </>
            )}
          </button>
        </Section>
      )}

      <Section title="History" footer="Every renewal and rent change your owner makes is kept here.">
        <div className="list">
          {[...terms].reverse().map((t) => (
            <Row
              key={t.id}
              title={TERM_REASON[t.reason]}
              sub={`${termLine(t)}${t.note ? ` · ${t.note}` : ""}`}
              value={<span className="num">{rupees(t.rent)}</span>}
            />
          ))}
        </div>
      </Section>

      <Section>
        <div className="list icons">
          <Row
            icon="receipt"
            iconBg="var(--accent)"
            title="Rent statements"
            sub="Monthly, yearly and FY statements for HRA"
            chevron
            to="/statements"
          />
        </div>
      </Section>
    </Page>
  );
}
