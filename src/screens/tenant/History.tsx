import { useMemo, useState } from "react";
import { useApi } from "../../lib/api";
import { dateLabel, monthLabel, rupees, batchNote } from "../../lib/format";
import type { LedgerRow, Payment, TenantHome } from "../../lib/types";
import { Empty, ErrorState, Page, Row, Section, Sheet, Skeleton, StatusPill } from "../../components/kit";
import { Icon, type IconName } from "../../components/icons";
import { PdfButton, receiptPath, useTenantDocuments } from "../tools/TenantDocs";
import "../../styles/tenant.css";
import { useT } from "../../lib/i18n";

export const METHOD: Record<string, { label: string; icon: IconName; bg: string }> = {
  upi: { label: "UPI", icon: "qr", bg: "var(--indigo)" },
  cash: { label: "Cash", icon: "cash", bg: "var(--green)" },
  bank: { label: "Bank transfer", icon: "bank", bg: "var(--teal)" },
};

export default function History() {
  const t = useT();
  const { data, error, loading, reload } = useApi<TenantHome>("/api/tenant/home");
  const [open, setOpen] = useState<LedgerRow | null>(null);

  const year = (data?.today ?? new Date().toISOString()).slice(0, 4);
  const groups = useMemo(() => {
    const m = new Map<string, LedgerRow[]>();
    for (const r of data?.ledger ?? []) {
      const y = r.month.slice(0, 4);
      m.set(y, [...(m.get(y) ?? []), r]);
    }
    return [...m.entries()].sort((a, b) => b[0].localeCompare(a[0]));
  }, [data]);

  const paidThisYear = (data?.ledger ?? []).filter((r) => r.month.startsWith(year)).reduce((s, r) => s + r.paid, 0);
  const due = (data?.ledger ?? []).reduce((s, r) => s + r.balance, 0);

  return (
    <Page title="History">
      {loading ? (
        <Section>
          <Skeleton rows={5} avatar={false} />
        </Section>
      ) : error || !data ? (
        <ErrorState error={error ?? { message: "Couldn't load your history." }} retry={reload} />
      ) : !data.ledger.length ? (
        <Empty
          icon="clock"
          title="No rent history yet"
          text="Your monthly charges and payments will show up here once your tenancy starts."
        />
      ) : (
        <>
          <Section>
            <div className="summary-card">
              <div className="stat">
                <div className="k c-green">{t("Paid in {year}", { year })}</div>
                <div className="v">{rupees(paidThisYear)}</div>
              </div>
              <div className="stat">
                <div className={`k ${due > 0 ? "c-orange" : ""}`}>{t("Still due")}</div>
                <div className="v">{rupees(due)}</div>
              </div>
            </div>
          </Section>
          {groups.map(([y, rows]) => (
            <Section key={y} title={y}>
              <div className="list">
                {rows.map((r) => (
                  <Row
                    key={r.id}
                    title={monthLabel(r.month, true).replace(` ${y}`, "")}
                    sub={summary(r)}
                    end={
                      <span className="stack">
                        <span className="num w6">{rupees(r.amount)}</span>
                        <StatusPill status={r.status} />
                      </span>
                    }
                    chevron
                    onClick={() => setOpen(r)}
                  />
                ))}
              </div>
            </Section>
          ))}
        </>
      )}

      <Sheet open={!!open} onClose={() => setOpen(null)} title={open ? monthLabel(open.month, true) : ""}>
        {open && <ChargeDetail c={open} />}
      </Sheet>
    </Page>
  );
}

function summary(r: LedgerRow) {
  if (r.status === "paid") {
    const last = r.payments.filter((p) => p.status === "confirmed").sort((a, b) => b.paidOn.localeCompare(a.paidOn))[0];
    return last ? `Paid ${dateLabel(last.paidOn)}` : "Paid";
  }
  if (r.status === "awaiting") return `${rupees(r.pending)} awaiting confirmation`;
  if (r.paid > 0) return `${rupees(r.paid)} paid · ${rupees(r.balance)} left`;
  return `Due ${dateLabel(r.dueDate)}`;
}

function ChargeDetail({ c }: { c: LedgerRow }) {
  const t = useT();
  const docs = useTenantDocuments();
  const receipts = (docs.data?.receipts ?? []).filter((r) =>
    c.payments.some((p) => p.id === r.paymentId && p.status === "confirmed"),
  );
  return (
    <>
      <div className="center-text" style={{ padding: "4px 20px 20px" }}>
        <div className="t-sub c2">
          {c.unitLabel} · {c.propertyName}
        </div>
        <div className="hero" style={{ padding: "6px 0 4px" }}>
          <div className="amount">{rupees(c.amount)}</div>
        </div>
        <StatusPill status={c.status} />
      </div>
      <Section>
        <div className="list">
          <Row title="Due date" value={dateLabel(c.dueDate, true)} />
          <Row title="Paid" value={<span className="num c-green">{rupees(c.paid)}</span>} />
          {c.pending > 0 && (
            <Row title="Awaiting confirmation" value={<span className="num">{rupees(c.pending)}</span>} />
          )}
          <Row
            title="Balance"
            value={<span className={`num ${c.balance > 0 ? "c-orange" : ""}`}>{rupees(c.balance)}</span>}
          />
        </div>
      </Section>
      <Section title="Payments">
        {c.payments.length ? (
          <div className="list icons">
            {c.payments.map((p) => (
              <PaymentRow key={p.id} p={p} />
            ))}
          </div>
        ) : (
          <div className="card tight t-sub c2 center-text">{t("No payments recorded for this month yet.")}</div>
        )}
      </Section>
      {receipts.length > 0 && (
        <Section title="Receipts" footer="Keep these for HRA claims. Share opens WhatsApp, Mail or Files.">
          <div className="stack-8">
            {receipts.map((r) => (
              <PdfButton
                key={r.id}
                path={receiptPath(r.paymentId)}
                filename={`${r.number}.pdf`}
                title={t("Rent receipt {number}", { number: r.number })}
                label={
                  receipts.length > 1
                    ? t("Receipt {number} · {amount}", { number: r.number, amount: rupees(r.amount) })
                    : t("Rent receipt {number}", { number: r.number })
                }
                className="btn gray"
              />
            ))}
          </div>
        </Section>
      )}
    </>
  );
}

export function PaymentRow({ p }: { p: Payment }) {
  const t = useT();
  const m = METHOD[p.method] ?? { label: p.method, icon: "wallet" as IconName, bg: "var(--label-2)" };
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
          {[batchNote(p.batch), p.utr && `UTR ${p.utr}`, p.note].filter(Boolean).join(" · ") || t("No reference")}
        </span>
      </span>
      <span className="end">
        <span className="stack">
          <span
            className={`num w6 ${p.status === "rejected" ? "c3" : ""}`}
            style={p.status === "rejected" ? { textDecoration: "line-through" } : undefined}
          >
            {rupees(p.amount)}
          </span>
          <StatusPill status={p.status} />
        </span>
      </span>
    </div>
  );
}
