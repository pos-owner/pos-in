import { useState } from "react";
import { useParams, useSearchParams } from "react-router-dom";
import { api, ApiError, invalidate, sharePdf, useApi } from "../../lib/api";
import { dateLabel, rupees, todayISO } from "../../lib/format";
import type { SettlementDeduction, SettlementInfo, SettlementResponse, TenantDetailResponse } from "../../lib/types";
import {
  Empty,
  ErrorState,
  Field,
  FormError,
  Page,
  Row,
  Section,
  Segmented,
  SelectField,
  Sheet,
  SkeletonPage,
  Spinner,
  useToast,
} from "../../components/kit";
import { I } from "../../components/icons";
import { refreshRent } from "./ChargeSheet";
import { useT } from "../../lib/i18n";

/*
 * Move-out and deposit settlement. Route: /tenants/:id/settlement?tenancy=<id>
 *
 * The server does every calculation: while the settlement is a draft its numbers follow the ledger, and
 * finalising freezes them, applies rent and utility deductions to the unpaid months and numbers the statement.
 */

const KIND_LABEL: Record<SettlementDeduction["kind"], string> = {
  damage: "Damage",
  rent: "Unpaid rent",
  utility: "Utilities",
  other: "Other",
};

export default function Settlement() {
  const { id = "" } = useParams();
  const [params] = useSearchParams();
  const tenantId = Number(id);
  // Without ?tenancy= (an old link), use the tenant's current tenancy.
  const detail = useApi<TenantDetailResponse>(params.get("tenancy") ? null : `/api/tenants/${tenantId}`);
  const current = detail.data?.tenancies.find((t) => t.status === "active") ?? detail.data?.tenancies[0];
  const tenancyId = Number(params.get("tenancy")) || current?.id || 0;
  const key = tenancyId ? `/api/tenancies/${tenancyId}/settlement` : null;
  const { data, error, loading, reload } = useApi<SettlementResponse>(key);

  if (!params.get("tenancy") && detail.data && !current)
    return (
      <Page title="Move-out" back tabs={false}>
        <Empty icon="key" title="No tenancy" text="This tenant has no tenancy to settle." />
      </Page>
    );
  if (error)
    return (
      <Page title="Move-out" back tabs={false}>
        <ErrorState error={error} retry={reload} />
      </Page>
    );
  if (loading || !data || detail.loading)
    return (
      <Page title="Move-out" back tabs={false}>
        <SkeletonPage variant="detail" />
      </Page>
    );
  return <SettlementView data={data} tenancyId={tenancyId} tenantId={tenantId} cacheKey={key!} />;
}

function SettlementView({
  data,
  tenancyId,
  tenantId,
  cacheKey,
}: {
  data: SettlementResponse;
  tenancyId: number;
  tenantId: number;
  cacheKey: string;
}) {
  const tx = useT();
  const toast = useToast();
  const { tenancy: tn, settlement: s } = data;
  const [moveOut, setMoveOut] = useState(data.suggestedMoveOut);
  const [busy, setBusy] = useState<"" | "start" | "finalize" | "pdf" | "delete">("");
  const [confirmFinal, setConfirmFinal] = useState(false);
  const [adding, setAdding] = useState(false);
  const [refunding, setRefunding] = useState(false);
  const [err, setErr] = useState("");

  function refresh() {
    invalidate(cacheKey, `/api/tenancies/${tenancyId}/lease`, `/api/tenants/${tenantId}`, "/api/workspace");
    refreshRent();
  }

  async function start() {
    if (!moveOut) return setErr("Enter the move-out date.");
    setBusy("start");
    setErr("");
    try {
      await api(`/api/tenancies/${tenancyId}/settlement`, { body: { moveOutDate: moveOut } });
      refresh();
      toast("Settlement started");
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : "Couldn't start the settlement.");
    } finally {
      setBusy("");
    }
  }

  async function changeDate(d: string) {
    setMoveOut(d);
    if (!s || s.status !== "draft" || !d || d === s.moveOutDate) return;
    try {
      await api(`/api/tenancies/${tenancyId}/settlement`, { body: { moveOutDate: d } });
      refresh();
    } catch (e) {
      toast(e instanceof ApiError ? e.message : "Couldn't change the date.", "alert");
    }
  }

  async function removeDeduction(d: SettlementDeduction) {
    if (!s) return;
    setBusy("delete");
    try {
      await api(`/api/settlements/${s.id}/deductions/${d.id}`, { method: "DELETE" });
      refresh();
    } catch (e) {
      toast(e instanceof ApiError ? e.message : "Couldn't remove the deduction.", "alert");
    } finally {
      setBusy("");
    }
  }

  async function finalize() {
    if (!s) return;
    if (!confirmFinal) return setConfirmFinal(true);
    setBusy("finalize");
    try {
      const r = await api<{ appliedMonths: number }>(`/api/settlements/${s.id}/finalize`, { method: "POST" });
      refresh();
      toast(
        r.appliedMonths
          ? `Final · deposit applied to ${r.appliedMonths} unpaid ${r.appliedMonths === 1 ? "month" : "months"}`
          : "Settlement is final",
      );
    } catch (e) {
      toast(e instanceof ApiError ? e.message : "Couldn't finalise the settlement.", "alert");
    } finally {
      setBusy("");
      setConfirmFinal(false);
    }
  }

  async function statement() {
    if (!s) return;
    setBusy("pdf");
    try {
      await sharePdf(
        `/api/tenancies/${tenancyId}/settlement.json`,
        `${s.number || "Settlement-draft"}.pdf`,
        "Deposit settlement",
      );
    } catch (e) {
      toast(e instanceof ApiError ? e.message : "Couldn't prepare the statement.", "alert");
    } finally {
      setBusy("");
    }
  }

  const figures = s ?? (data.preview ? { ...data.preview, deductions: [], deductionTotal: 0, refundAmount: 0 } : null);
  const final = s?.status === "final";

  return (
    <Page title="Move-out" eyebrow={`${tn.tenantName} · ${tn.unitLabel}`} back tabs={false}>
      <Section>
        <div className={`banner ${final ? "blue" : "purple"}`}>
          <I.wallet />
          <div className="grow">
            <b>
              {final
                ? tx("{number} · final", { number: s!.number })
                : s
                  ? tx("Draft settlement")
                  : tx("Deposit settlement")}
            </b>
            <span>
              {final
                ? tx("Finalised {value}. The numbers can no longer change.", {
                    value: s!.finalizedAt ? dateLabel(s!.finalizedAt, true) : "",
                  })
                : s
                  ? tx(
                      "The numbers follow the ledger until you finalise. Add deductions for damage or anything else owed.",
                    )
                  : tx("{propertyName}. Lived here since {date}. Start a settlement to work out the deposit refund.", {
                      propertyName: tn.propertyName,
                      date: dateLabel(tn.startDate, true),
                    })}
            </span>
          </div>
        </div>
      </Section>

      <Section title="Move-out date">
        <div className="list">
          {final ? (
            <Row title="Moved out" value={dateLabel(s!.moveOutDate, true)} />
          ) : (
            <Field label="Move-out date" type="date" value={moveOut} onChange={changeDate} />
          )}
        </div>
        {!s && (
          <>
            <FormError text={err} />
            <button className="btn mt12" onClick={start} disabled={!!busy}>
              {busy === "start" ? <Spinner /> : tx("Start settlement")}
            </button>
            {tn.status === "active" && (
              <div className="t-foot c2 mt8">
                {tx("Starting schedules the move-out on {value}. Rent is billed until then{value2}.", {
                  value: moveOut ? dateLabel(moveOut, true) : tx("this date"),
                  value2: moveOut && moveOut < todayISO() ? tx(", and the tenancy ends on the next rent cycle") : "",
                })}
              </div>
            )}
          </>
        )}
      </Section>

      {figures && <Figures f={figures} settlement={s} />}

      {s && (
        <Section
          title="Deductions"
          action={!final ? <button onClick={() => setAdding(true)}>{tx("Add")}</button> : undefined}
          footer={
            !final
              ? tx(
                  "Rent and utility deductions are paid from the deposit when you finalise, so those months show as paid.",
                )
              : undefined
          }
        >
          {s.deductions.length === 0 ? (
            <div className="card tight t-sub c2 center-text">
              {tx("No deductions.")}{" "}
              {!final &&
                (figures!.outstandingRent > 0 || figures!.pendingUtilities > 0) &&
                tx("Add the unpaid rent and bills below.")}
            </div>
          ) : (
            <div className="list">
              {s.deductions.map((d) => (
                <Row
                  key={d.id}
                  title={d.description}
                  sub={KIND_LABEL[d.kind]}
                  value={<span className="num">−{rupees(d.amount)}</span>}
                  end={
                    !final ? (
                      <button
                        className="circle-btn plain"
                        aria-label={tx("Remove {description}", { description: d.description })}
                        disabled={busy === "delete"}
                        onClick={() => removeDeduction(d)}
                      >
                        <I.trash />
                      </button>
                    ) : undefined
                  }
                />
              ))}
            </div>
          )}
          {!final && <QuickDeductions settlement={s} onDone={refresh} />}
        </Section>
      )}

      {s && (
        <Section>
          <div className="btn-row">
            <button className="btn tinted md" onClick={statement} disabled={!!busy}>
              {busy === "pdf" ? (
                <Spinner />
              ) : (
                <>
                  <I.receipt /> {final ? tx("Statement (PDF)") : tx("Draft PDF")}
                </>
              )}
            </button>
            {final && s.refundAmount > 0 && s.refundStatus !== "paid" && (
              <button className="btn md" onClick={() => setRefunding(true)}>
                <I.check /> {tx("Mark refund paid")}
              </button>
            )}
          </div>
          {!final && (
            <>
              <button className="btn mt12" onClick={finalize} disabled={!!busy}>
                {busy === "finalize" ? (
                  <Spinner />
                ) : confirmFinal ? (
                  tx("Tap again to finalise")
                ) : (
                  tx("Finalise settlement")
                )}
              </button>
              <div className="t-foot c2 mt8">
                {tx(
                  "Finalising freezes the numbers, numbers the statement and shares it with {value}. It can't be undone.",
                  { value: tn.tenantName.split(/[\s&]/)[0] },
                )}
              </div>
            </>
          )}
          {final && s.refundStatus === "paid" && (
            <div className="card tight t-sub c2 center-text mt12">
              {tx("Refund paid by {value}{value2}{value3}.", {
                value: s.refundMethod.toUpperCase(),
                value2: s.refundRef ? ` · ${s.refundRef}` : "",
                value3: s.refundPaidOn ? ` on ${dateLabel(s.refundPaidOn, true)}` : "",
              })}
            </div>
          )}
        </Section>
      )}

      {s && (
        <>
          <Sheet open={adding} onClose={() => setAdding(false)} title="Add deduction">
            {adding && <DeductionForm settlement={s} onClose={() => setAdding(false)} onDone={refresh} />}
          </Sheet>
          <Sheet open={refunding} onClose={() => setRefunding(false)} title="Refund paid">
            {refunding && <RefundForm settlement={s} onClose={() => setRefunding(false)} onDone={refresh} />}
          </Sheet>
        </>
      )}
    </Page>
  );
}

function Figures({
  f,
  settlement,
}: {
  f: Pick<
    SettlementInfo,
    "depositHeld" | "outstandingRent" | "pendingUtilities" | "advanceUnused" | "deductionTotal" | "refundAmount"
  >;
  settlement: SettlementInfo | null;
}) {
  const tx = useT();
  const owes = settlement && f.refundAmount < 0;
  return (
    <Section title="The numbers">
      <div className="stats">
        <div className="stat">
          <div className="k">{tx("Deposit held")}</div>
          <div className="v">{rupees(f.depositHeld)}</div>
        </div>
        <div className="stat">
          <div className={`k ${owes ? "c-red" : "c-green"}`}>
            {settlement ? (owes ? tx("Tenant owes") : tx("Refund")) : tx("Refund")}
          </div>
          <div className="v">{settlement ? rupees(Math.abs(f.refundAmount)) : "—"}</div>
        </div>
      </div>
      <div className="list mt12">
        <Row title="Unpaid rent up to move-out" value={<span className="num">{rupees(f.outstandingRent)}</span>} />
        <Row title="Unpaid utility bills" value={<span className="num">{rupees(f.pendingUtilities)}</span>} />
        {f.advanceUnused > 0 && (
          <Row
            title="Rent paid for months after move-out"
            sub="Returned with the deposit"
            value={<span className="num">+{rupees(f.advanceUnused)}</span>}
          />
        )}
        {settlement && <Row title="Deductions" value={<span className="num">−{rupees(f.deductionTotal)}</span>} />}
      </div>
      {settlement && (
        <div className="t-foot c2 mt8">
          {tx("Refund = deposit {amount} − deductions {amount2}{value}.", {
            amount: rupees(f.depositHeld),
            amount2: rupees(f.deductionTotal),
            value: f.advanceUnused > 0 ? ` + unused advance ${rupees(f.advanceUnused)}` : "",
          })}
        </div>
      )}
    </Section>
  );
}

/** One-tap deductions for the unpaid rent and utilities the server found, when they aren't added yet. */
function QuickDeductions({ settlement: s, onDone }: { settlement: SettlementInfo; onDone: () => void }) {
  const toast = useToast();
  const [busy, setBusy] = useState("");
  const has = (k: SettlementDeduction["kind"]) => s.deductions.some((d) => d.kind === k);
  const items = [
    !has("rent") && s.outstandingRent > 0
      ? { kind: "rent" as const, amount: s.outstandingRent, description: "Unpaid rent up to move-out" }
      : null,
    !has("utility") && s.pendingUtilities > 0
      ? { kind: "utility" as const, amount: s.pendingUtilities, description: "Unpaid electricity and water bills" }
      : null,
  ].filter((x) => x !== null);
  if (!items.length) return null;

  async function add(it: (typeof items)[number]) {
    setBusy(it.kind);
    try {
      await api(`/api/settlements/${s.id}/deductions`, { body: it });
      onDone();
    } catch (e) {
      toast(e instanceof ApiError ? e.message : "Couldn't add the deduction.", "alert");
    } finally {
      setBusy("");
    }
  }

  return (
    <div className="chips" style={{ margin: "10px 0 0", padding: "2px 0 4px" }}>
      {items.map((it) => (
        <button key={it.kind} type="button" className="chip" disabled={!!busy} onClick={() => add(it)}>
          {busy === it.kind ? <Spinner size={14} /> : <I.plus />} {KIND_LABEL[it.kind]} {rupees(it.amount)}
        </button>
      ))}
    </div>
  );
}

function DeductionForm({
  settlement,
  onClose,
  onDone,
}: {
  settlement: SettlementInfo;
  onClose: () => void;
  onDone: () => void;
}) {
  const tx = useT();
  const [kind, setKind] = useState<SettlementDeduction["kind"]>("damage");
  const [description, setDescription] = useState("");
  const [amount, setAmount] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const n = Math.round(Number(amount.replace(/[,\s]/g, "")));

  async function save() {
    if (!description.trim()) return setErr("Describe the deduction.");
    if (!n || n < 1) return setErr("Enter the amount.");
    setBusy(true);
    setErr("");
    try {
      await api(`/api/settlements/${settlement.id}/deductions`, {
        body: { kind, description: description.trim(), amount: n },
      });
      onDone();
      onClose();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : "Couldn't add the deduction.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Section>
      <div className="list">
        <SelectField
          label="For"
          value={kind}
          onChange={setKind}
          options={(Object.keys(KIND_LABEL) as SettlementDeduction["kind"][]).map((k) => ({
            value: k,
            label: KIND_LABEL[k],
          }))}
        />
        <Field
          label="Description"
          value={description}
          onChange={setDescription}
          placeholder="e.g. Broken window, repainting"
          maxLength={160}
        />
        <Field label="Amount" value={amount} onChange={setAmount} inputMode="numeric" prefix="₹" />
      </div>
      <FormError text={err} />
      <button className="btn mt12" onClick={save} disabled={busy}>
        {busy ? <Spinner /> : tx("Add deduction")}
      </button>
    </Section>
  );
}

function RefundForm({
  settlement,
  onClose,
  onDone,
}: {
  settlement: SettlementInfo;
  onClose: () => void;
  onDone: () => void;
}) {
  const tx = useT();
  const toast = useToast();
  const [method, setMethod] = useState<"upi" | "bank" | "cash">("upi");
  const [ref, setRef] = useState("");
  const [paidOn, setPaidOn] = useState(todayISO());
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  async function save() {
    setBusy(true);
    setErr("");
    try {
      await api(`/api/settlements/${settlement.id}/refund`, { body: { method, ref: ref.trim(), paidOn } });
      onDone();
      toast(`Refund of ${rupees(settlement.refundAmount)} recorded`);
      onClose();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : "Couldn't record the refund.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Section title={tx("Refund {amount}", { amount: rupees(settlement.refundAmount) })}>
      <Segmented
        label="Paid by"
        value={method}
        onChange={setMethod}
        options={[
          { value: "upi", label: "UPI" },
          { value: "bank", label: "Bank" },
          { value: "cash", label: "Cash" },
        ]}
      />
      <div className="list mt12">
        <Field label="Paid on" type="date" value={paidOn} onChange={setPaidOn} />
        {method !== "cash" && (
          <Field label="Reference" value={ref} onChange={setRef} placeholder="UTR or transaction ID" maxLength={60} />
        )}
      </div>
      <FormError text={err} />
      <button className="btn mt12" onClick={save} disabled={busy}>
        {busy ? <Spinner /> : tx("Save")}
      </button>
    </Section>
  );
}
