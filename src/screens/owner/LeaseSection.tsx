import { useState } from "react";
import { api, ApiError, invalidate, useApi } from "../../lib/api";
import { dateLabel, ordinal, rupees } from "../../lib/format";
import { LEASE_STATE, TERM_REASON, leaseStatusText, termLine } from "../../lib/lease";
import type { LeaseResponse } from "../../lib/types";
import { Field, FormError, Row, Section, Segmented, Sheet, Skeleton, Spinner, useToast } from "../../components/kit";
import { I } from "../../components/icons";
import { refreshRent } from "./ChargeSheet";
import { useT } from "../../lib/i18n";

/*
 * The lease on the owner's tenant screen: where the lease stands (running, ending soon, holdover,
 * moving out), its append-only history of terms, renewals and rent revisions, cancelling a scheduled move-out,
 * and the way into the move-out settlement.
 */

export function LeaseSection({
  tenancyId,
  tenantId,
  tenantName,
}: {
  tenancyId: number;
  tenantId: number;
  tenantName: string;
}) {
  const tx = useT();
  const key = `/api/tenancies/${tenancyId}/lease`;
  const { data, error, reload } = useApi<LeaseResponse>(key);
  const toast = useToast();
  const [renewing, setRenewing] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [busy, setBusy] = useState(false);
  const [showAll, setShowAll] = useState(false);

  if (error)
    return (
      <Section title="Lease">
        <div className="card tight t-sub c2 center-text">
          {error.message}{" "}
          <button className="link" onClick={() => reload()}>
            {tx("Try again")}
          </button>
        </div>
      </Section>
    );
  if (!data)
    return (
      <Section title="Lease">
        <Skeleton rows={2} avatar={false} />
      </Section>
    );

  const { tenancy: tn, terms, settlement } = data;
  const st = LEASE_STATE[tn.state];
  const history = [...terms].reverse();
  const shown = showAll ? history : history.slice(0, 3);
  const first = tenantName.split(/[\s&]/)[0];

  async function cancelMoveOut() {
    if (!cancelling) return setCancelling(true);
    setBusy(true);
    try {
      await api(`/api/tenancies/${tenancyId}/move-out/cancel`, { method: "POST" });
      refreshRent();
      invalidate(`/api/tenants/${tenantId}`, key, "/api/workspace");
      toast(`${first} is staying on`);
    } catch (e) {
      toast(e instanceof ApiError ? e.message : "Couldn't cancel the move-out.", "alert");
    } finally {
      setBusy(false);
      setCancelling(false);
    }
  }

  return (
    <Section
      title="Lease"
      action={tn.status === "active" ? <button onClick={() => setRenewing(true)}>{tx("Renew")}</button> : undefined}
    >
      <div className={`banner ${tn.state === "holdover" ? "" : tn.state === "ending" ? "orange" : "blue"}`}>
        {tn.state === "holdover" ? <I.alert /> : <I.key />}
        <div className="grow">
          <b>
            <span className={`pill ${st.cls}`} style={{ marginRight: 6 }}>
              {st.label}
            </span>
            {rupees(tn.rent)} {tx("a month · due")} {ordinal(tn.dueDay)}
          </b>
          <span>{leaseStatusText(tn)}</span>
        </div>
      </div>

      {tn.status === "active" && (
        <div className="btn-row mt12">
          <button className="btn tinted md" onClick={() => setRenewing(true)}>
            <I.calendar /> {tx("Renew or revise rent")}
          </button>
          {tn.moveOutDate ? (
            <button className="btn gray md" onClick={cancelMoveOut} disabled={busy}>
              {busy ? <Spinner /> : cancelling ? tx("Tap again to confirm") : tx("Cancel move-out")}
            </button>
          ) : null}
        </div>
      )}

      {(tn.moveOutDate || tn.status !== "active" || settlement) && (
        <div className="list icons mt12">
          <Row
            icon="wallet"
            iconBg="var(--indigo)"
            title="Move-out & deposit"
            sub={
              settlement
                ? settlement.status === "final"
                  ? `${settlement.number} · ${settlement.refundAmount < 0 ? `${rupees(-settlement.refundAmount)} owed by tenant` : `refund ${rupees(settlement.refundAmount)}${settlement.refundStatus === "paid" ? " · paid" : " · pending"}`}`
                  : tx("Draft · refund {amount}", { amount: rupees(settlement.refundAmount) })
                : tx("Work out the deposit refund")
            }
            chevron
            to={`/tenants/${tenantId}/settlement?tenancy=${tenancyId}`}
          />
        </div>
      )}

      <div className="sub-head">{tx("Lease history")}</div>
      <div className="list">
        {shown.map((t, i) => (
          <Row
            key={t.id}
            title={
              <span className="hstack" style={{ gap: 8 }}>
                {TERM_REASON[t.reason]}
                {i === 0 && !showAll && <span className="pill blue">{tx("Current")}</span>}
              </span>
            }
            sub={`${termLine(t)}${t.note ? ` · ${t.note}` : ""}`}
            value={<span className="num">{rupees(t.rent)}</span>}
          />
        ))}
      </div>
      {history.length > 3 && (
        <button className="btn plain sm mt8" onClick={() => setShowAll((v) => !v)}>
          {showAll ? tx("Show less") : tx("Show all {n}", { n: history.length })}
        </button>
      )}

      <RenewSheet
        open={renewing}
        onClose={() => setRenewing(false)}
        lease={data}
        onDone={() => {
          refreshRent();
          invalidate(`/api/tenants/${tenantId}`, key, "/api/workspace");
        }}
      />
    </Section>
  );
}

/** Adds `months` to a date and returns the day before (an 11-month lease from 1 Apr ends 28 Feb). */
function endAfter(start: string, months: number) {
  const [y, m, d] = start.split("-").map(Number);
  const t = y * 12 + (m - 1) + months;
  const yy = Math.floor(t / 12);
  const mm = (t % 12) + 1;
  const last = new Date(Date.UTC(yy, mm, 0)).getUTCDate();
  const day = new Date(Date.UTC(yy, mm - 1, Math.min(d, last)) - 86400000);
  return day.toISOString().slice(0, 10);
}

function RenewSheet({
  open,
  onClose,
  lease,
  onDone,
}: {
  open: boolean;
  onClose: () => void;
  lease: LeaseResponse;
  onDone: () => void;
}) {
  return (
    <Sheet open={open} onClose={onClose} title="Renew or revise">
      {open && <RenewForm lease={lease} onClose={onClose} onDone={onDone} />}
    </Sheet>
  );
}

function RenewForm({ lease, onClose, onDone }: { lease: LeaseResponse; onClose: () => void; onDone: () => void }) {
  const tx = useT();
  const toast = useToast();
  const tn = lease.tenancy;
  const [kind, setKind] = useState<"renewal" | "revision">("renewal");
  const [from, setFrom] = useState(lease.renewal?.effectiveFrom ?? tn.startDate);
  const [end, setEnd] = useState(lease.renewal?.endDate ?? "");
  const [rent, setRent] = useState(String(tn.rent));
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const rentN = Math.round(Number(rent.replace(/[,\s]/g, "")));
  const change = rentN && tn.rent ? ((rentN - tn.rent) / tn.rent) * 100 : 0;

  async function save() {
    if (!rentN || rentN < 1) return setErr("Enter the monthly rent.");
    if (!from) return setErr("Enter the date the new terms start.");
    if (kind === "renewal" && !end) return setErr("Choose when the renewed lease ends.");
    setBusy(true);
    setErr("");
    try {
      const r = await api<{ repriced: number }>(`/api/tenancies/${tn.id}/renew`, {
        body: {
          kind,
          effectiveFrom: from,
          rent: rentN,
          ...(kind === "renewal" ? { endDate: end } : {}),
          note: note.trim(),
        },
      });
      onDone();
      toast(
        kind === "renewal"
          ? `Lease renewed to ${dateLabel(end, true)}`
          : `Rent revised to ${rupees(rentN)}${r.repriced ? ` · ${r.repriced} ${r.repriced === 1 ? "month" : "months"} updated` : ""}`,
      );
      onClose();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : "Couldn't save the new terms.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Section>
        <Segmented
          label="Change"
          value={kind}
          onChange={(k) => {
            setKind(k);
            setErr("");
          }}
          options={[
            { value: "renewal", label: "Renew lease" },
            { value: "revision", label: "Revise rent" },
          ]}
        />
      </Section>
      <Section
        title={`${tn.unitLabel} · ${tn.tenantName}`}
        footer={
          kind === "renewal"
            ? tx("A renewal adds a new term to the lease history. Months already paid or claimed keep their amount.")
            : tx(
                "A revision changes the rent from a date without changing when the lease ends. Paid months are never changed.",
              )
        }
      >
        <div className="list">
          <Field
            label={kind === "renewal" ? tx("New term starts") : tx("New rent from")}
            type="date"
            value={from}
            onChange={setFrom}
          />
          {kind === "renewal" && <Field label="Lease ends" type="date" value={end} onChange={setEnd} />}
          <Field label="Monthly rent" value={rent} onChange={setRent} inputMode="numeric" prefix="₹" />
          <Field label="Note" value={note} onChange={setNote} placeholder="Optional" maxLength={200} />
        </div>
        {kind === "renewal" && from && (
          <div className="chips mt8" style={{ margin: "8px 0 0", padding: "2px 0 4px" }}>
            {[11, 12, 24].map((m) => (
              <button
                key={m}
                type="button"
                className="chip"
                aria-pressed={end === endAfter(from, m)}
                onClick={() => setEnd(endAfter(from, m))}
              >
                {tx("{m} months", { m })}
              </button>
            ))}
          </div>
        )}
        <div className="chips" style={{ margin: "4px 0 0", padding: "2px 0 4px" }}>
          {[5, 8, 10].map((p) => {
            const v = String(Math.round((tn.rent * (100 + p)) / 100 / 50) * 50);
            return (
              <button key={p} type="button" className="chip" aria-pressed={rent === v} onClick={() => setRent(v)}>
                +{p}% · {rupees(Number(v))}
              </button>
            );
          })}
        </div>
        {rentN > 0 && rentN !== tn.rent && (
          <div className="t-foot c2 mt8">
            {tx("{value} {value2}% from {amount}.", {
              value: change > 0 ? tx("Up") : tx("Down"),
              value2: Math.abs(change).toFixed(1),
              amount: rupees(tn.rent),
            })}
          </div>
        )}
        <FormError text={err} />
        <button className="btn mt12" onClick={save} disabled={busy}>
          {busy ? <Spinner /> : kind === "renewal" ? tx("Renew lease") : tx("Save new rent")}
        </button>
      </Section>
    </>
  );
}
