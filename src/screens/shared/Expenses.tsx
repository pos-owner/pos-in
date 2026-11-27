import { useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { api, ApiError, invalidate, useApi } from "../../lib/api";
import { useAuth } from "../../lib/auth";
import { dateLabel, monthLabel, rupees, todayISO } from "../../lib/format";
import type { ExpenseRow, ExpensesResponse } from "../../lib/types";
import {
  Empty,
  ErrorState,
  Field,
  FormError,
  NavButton,
  Page,
  Row,
  Section,
  SelectField,
  Sheet,
  Skeleton,
  Spinner,
  useToast,
} from "../../components/kit";
import { I, type IconName } from "../../components/icons";
import { OutboxNote } from "../../components/OutboxButton";
import { useT } from "../../lib/i18n";
import { sendOrQueue } from "../../lib/outbox";
import "../../styles/ops.css";

export const CATEGORIES: { name: string; icon: IconName; bg: string }[] = [
  { name: "Repairs", icon: "wrench", bg: "var(--orange)" },
  { name: "Maintenance", icon: "building", bg: "var(--accent)" },
  { name: "Utilities", icon: "bolt", bg: "var(--yellow)" },
  { name: "Cleaning", icon: "drop", bg: "var(--teal)" },
  { name: "Tax", icon: "receipt", bg: "var(--indigo)" },
  { name: "Insurance", icon: "lock", bg: "var(--mint)" },
  { name: "Salary", icon: "person", bg: "var(--pink)" },
  { name: "Other", icon: "tag", bg: "var(--brown)" },
];
const catOf = (n: string) => CATEGORIES.find((c) => c.name === n) ?? CATEGORIES[CATEGORIES.length - 1];

export default function Expenses() {
  const t = useT();
  const { me } = useAuth();
  const isOwner = me?.profile?.role === "owner";
  const { data, error, loading, reload } = useApi<ExpensesResponse>("/api/expenses");
  const [params, setParams] = useSearchParams();
  const [adding, setAdding] = useState(params.get("new") === "1");
  const [open, setOpen] = useState<ExpenseRow | null>(null);
  const [prop, setProp] = useState(0);
  const nav = useNavigate();
  // A unit row links here with `?new=1&property=<id>&note=<unit>` so the form opens already filled in.
  const [preset] = useState(() => ({ property: Number(params.get("property")) || 0, note: params.get("note") ?? "" }));

  const rows = (data?.rows ?? []).filter((r) => !prop || r.propertyId === prop);
  const pending = rows.filter((r) => !r.approved);
  const approved = rows.filter((r) => r.approved);
  const thisMonth = todayISO().slice(0, 7);
  const monthTotal = approved.filter((r) => r.date.startsWith(thisMonth)).reduce((s, r) => s + r.amount, 0);
  const yearTotal = approved.filter((r) => r.date.startsWith(thisMonth.slice(0, 4))).reduce((s, r) => s + r.amount, 0);

  const groups = useMemo(() => {
    const m = new Map<string, ExpenseRow[]>();
    for (const r of isOwner ? approved : rows) m.set(r.date.slice(0, 7), [...(m.get(r.date.slice(0, 7)) ?? []), r]);
    return [...m.entries()].sort((a, b) => b[0].localeCompare(a[0]));
  }, [data, prop, isOwner]); // eslint-disable-line react-hooks/exhaustive-deps

  const close = () => {
    setAdding(false);
    if (params.get("new")) setParams({}, { replace: true });
  };

  return (
    <Page
      title="Expenses"
      back={isOwner ? "/more" : undefined}
      eyebrow={
        isOwner && data
          ? t("{amount} this month", { amount: rupees(monthTotal) })
          : !isOwner
            ? t("Submitted for owner approval")
            : undefined
      }
      left={!isOwner ? <NavButton icon="gear" label="Settings" onClick={() => nav("/settings")} /> : undefined}
      right={<NavButton icon="plus" label="Add expense" accent onClick={() => setAdding(true)} />}
    >
      {loading ? (
        <Section>
          <Skeleton rows={4} />
        </Section>
      ) : error || !data ? (
        <>
          <OutboxNote kind="expense" />
          <ErrorState error={error ?? { message: "Couldn't load expenses." }} retry={reload} />
        </>
      ) : !data.properties.length ? (
        <Empty
          icon="building"
          title="No properties yet"
          text="Expenses are logged against a property. Add one first."
        />
      ) : (
        <>
          <OutboxNote kind="expense" />
          {data.properties.length > 1 && (
            <div className="filters" style={{ margin: "0 var(--gap) 18px" }}>
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
            </div>
          )}

          {isOwner && (
            <Section>
              <div className="stats">
                <div className="stat">
                  <div className="k">{monthLabel(thisMonth, true)}</div>
                  <div className="v">{rupees(monthTotal)}</div>
                </div>
                <div className="stat">
                  <div className="k">{t("This year")}</div>
                  <div className="v">{rupees(yearTotal)}</div>
                </div>
              </div>
            </Section>
          )}

          {isOwner && pending.length > 0 && (
            <Section title="Waiting for your approval">
              <div className="list icons">
                {pending.map((r) => (
                  <ExpenseLine key={r.id} r={r} showBy onOpen={() => setOpen(r)} />
                ))}
              </div>
            </Section>
          )}

          {!rows.length ? (
            <Empty
              icon="wallet"
              title="No expenses yet"
              text={
                isOwner
                  ? t(
                      "Log repairs, utilities, taxes and other costs by property. Staff entries wait for your approval.",
                    )
                  : t("Log what you spend on repairs, cleaning or supplies. The owner approves each entry.")
              }
              action={
                <button className="btn md auto tinted" onClick={() => setAdding(true)}>
                  <I.plus /> {t("Add expense")}
                </button>
              }
            />
          ) : (
            groups.map(([m, list]) => (
              <Section
                key={m}
                title={monthLabel(m, true)}
                action={<span className="t-sub c2 num">{rupees(list.reduce((s, r) => s + r.amount, 0))}</span>}
              >
                <div className="list icons">
                  {list.map((r) => (
                    <ExpenseLine
                      key={r.id}
                      r={r}
                      showBy={isOwner && !!r.submittedByName && r.submittedByName !== me?.profile?.fullName}
                      onOpen={() => setOpen(r)}
                    />
                  ))}
                </div>
              </Section>
            ))
          )}
        </>
      )}
      <AddExpenseSheet open={adding} onClose={close} properties={data?.properties ?? []} preset={preset} />
      <ExpenseSheet row={open} onClose={() => setOpen(null)} isOwner={isOwner} />
    </Page>
  );
}

function ExpenseLine({ r, onOpen, showBy }: { r: ExpenseRow; onOpen: () => void; showBy?: boolean }) {
  const t = useT();
  const c = catOf(r.category);
  return (
    <Row
      icon={c.icon}
      iconBg={c.bg}
      title={r.note || r.category}
      sub={[
        r.category !== (r.note || r.category) ? r.category : "",
        r.propertyName,
        dateLabel(r.date),
        showBy ? `by ${r.submittedByName.split(" ")[0]}` : "",
      ]
        .filter(Boolean)
        .join(" · ")}
      end={
        <span className="stack">
          <span className="num w6">{rupees(r.amount)}</span>
          {!r.approved && <span className="pill purple">{t("Pending")}</span>}
        </span>
      }
      chevron
      onClick={onOpen}
    />
  );
}

function AddExpenseSheet({
  open,
  onClose,
  properties,
  preset,
}: {
  open: boolean;
  onClose: () => void;
  properties: { id: number; name: string }[];
  preset?: { property: number; note: string };
}) {
  const { me } = useAuth();
  const isOwner = me?.profile?.role === "owner";
  const toast = useToast();
  const t = useT();
  const [prop, setProp] = useState(preset?.property ?? 0);
  const [category, setCategory] = useState("Repairs");
  const [amount, setAmount] = useState("");
  const [date, setDate] = useState(todayISO());
  const [note, setNote] = useState(preset?.note ? `${preset.note.slice(0, 40)}: ` : "");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const propertyId = prop || (properties.length === 1 ? properties[0].id : 0);

  async function save() {
    const n = Math.round(Number(amount.replace(/[,\s]/g, "")));
    if (!propertyId) return setErr("Choose the property.");
    if (!n || n < 1) return setErr("Enter the amount.");
    setBusy(true);
    setErr("");
    try {
      // Kept on the phone and sent later when there's no connection (src/lib/outbox.ts).
      const r = await sendOrQueue({
        kind: "expense",
        body: { propertyId, category, amount: n, date, note: note.trim() },
        title: `${rupees(n)} · ${t(category)}`,
        detail: [properties.find((p) => p.id === propertyId)?.name, dateLabel(date), note.trim()]
          .filter(Boolean)
          .join(" · "),
      });
      if (r.queued) toast(t("Saved on this phone. It's sent when you're back online."), "cloudUp");
      else {
        invalidate("/api/expenses", "/api/dashboard");
        toast(isOwner ? "Expense added" : "Sent to the owner for approval");
      }
      setAmount("");
      setNote("");
      onClose();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : "Couldn't save the expense.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Sheet open={open} onClose={onClose} title="New expense" onDone={save} doneLabel="Save expense" busy={busy}>
      <Section>
        <div className="list">
          <Field label="Amount" value={amount} onChange={setAmount} inputMode="numeric" prefix="₹" big autoFocus />
        </div>
      </Section>
      <Section title="Category">
        <div className="chips" style={{ flexWrap: "wrap", margin: 0, padding: 0 }}>
          {CATEGORIES.map((c) => (
            <button
              key={c.name}
              type="button"
              className="chip"
              aria-pressed={category === c.name}
              onClick={() => setCategory(c.name)}
            >
              {t(c.name)}
            </button>
          ))}
        </div>
      </Section>
      <Section footer={isOwner ? undefined : t("The owner sees this right away and approves it.")}>
        <div className="list">
          {properties.length > 1 && (
            <SelectField
              label="Property"
              value={prop}
              onChange={setProp}
              options={[{ value: 0, label: "Choose…" }, ...properties.map((p) => ({ value: p.id, label: p.name }))]}
            />
          )}
          <Field label="Date" type="date" value={date} onChange={setDate} />
          <Field
            label="Note"
            value={note}
            onChange={setNote}
            placeholder="e.g. Plumber: bathroom tap"
            maxLength={300}
          />
        </div>
        <FormError text={err} />
        <button className="btn mt16" onClick={save} disabled={busy}>
          {busy ? <Spinner /> : isOwner ? t("Save expense") : t("Submit for approval")}
        </button>
      </Section>
    </Sheet>
  );
}

function ExpenseSheet({ row, onClose, isOwner }: { row: ExpenseRow | null; onClose: () => void; isOwner: boolean }) {
  const t = useT();
  const toast = useToast();
  const [busy, setBusy] = useState("");
  const [confirm, setConfirm] = useState(false);
  const [err, setErr] = useState("");
  const r = row;
  const canDelete = !!r && (isOwner || !r.approved);

  async function act(kind: "approve" | "delete") {
    if (!r) return;
    if (kind === "delete" && !confirm) return setConfirm(true);
    setBusy(kind);
    setErr("");
    try {
      await api(kind === "approve" ? `/api/expenses/${r.id}/approve` : `/api/expenses/${r.id}`, {
        method: kind === "approve" ? "POST" : "DELETE",
      });
      invalidate("/api/expenses", "/api/dashboard");
      toast(kind === "approve" ? "Expense approved" : "Expense removed");
      setConfirm(false);
      onClose();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : "That didn't work.");
    } finally {
      setBusy("");
    }
  }

  return (
    <Sheet
      open={!!row}
      onClose={() => {
        setConfirm(false);
        setErr("");
        onClose();
      }}
      title={r?.category ?? t("Expense")}
    >
      {r && (
        <>
          <div className="center-text" style={{ padding: "4px 20px 18px" }}>
            <div className="amount-lg">{rupees(r.amount)}</div>
            <div className="t-sub c2" style={{ marginTop: 4 }}>
              {r.propertyName} · {dateLabel(r.date, true)}
            </div>
            <span className={`pill ${r.approved ? "green" : "purple"} mt8`}>
              {r.approved ? t("Approved") : t("Waiting for approval")}
            </span>
          </div>
          <Section>
            <div className="list">
              <Row title="Category" value={r.category} />
              <Row title="Note" sub={r.note || t("No note")} />
              {r.submittedByName && <Row title="Logged by" value={r.submittedByName} />}
            </div>
            <FormError text={err} />
          </Section>
          <Section>
            <div className="stack-8">
              {isOwner && !r.approved && (
                <button className="btn green" onClick={() => act("approve")} disabled={!!busy}>
                  {busy === "approve" ? (
                    <Spinner />
                  ) : (
                    <>
                      <I.check /> {t("Approve")}
                    </>
                  )}
                </button>
              )}
              {canDelete && (
                <button className="btn danger" onClick={() => act("delete")} disabled={!!busy}>
                  {busy === "delete" ? (
                    <Spinner />
                  ) : confirm ? (
                    t("Tap again to remove")
                  ) : (
                    <>
                      <I.trash /> {t("Remove")}
                    </>
                  )}
                </button>
              )}
              {!canDelete && (
                <div className="t-foot c2 center-text">{t("Approved entries can only be changed by the owner.")}</div>
              )}
            </div>
          </Section>
        </>
      )}
    </Sheet>
  );
}
