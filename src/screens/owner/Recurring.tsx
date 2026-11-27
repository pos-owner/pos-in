import { useState } from "react";
import { api, ApiError, invalidate, useApi } from "../../lib/api";
import { dateLabel, rupees, todayISO } from "../../lib/format";
import type { Frequency, RecurringExpense, RecurringResponse } from "../../lib/types";
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
  SkeletonPage,
  Spinner,
  Toggle,
  useToast,
} from "../../components/kit";
import { I } from "../../components/icons";
import { CATEGORIES } from "../shared/Expenses";
import { useT } from "../../lib/i18n";

/*
 * Recurring expenses. Route: /more/recurring
 * Society maintenance, property tax, a caretaker's salary… The daily job logs each one as a normal expense on its
 * due date (once per period, so a retry never logs twice) and moves the rule's next date on.
 */

export const FREQ_LABEL: Record<Frequency, string> = {
  monthly: "Every month",
  quarterly: "Every 3 months",
  half_yearly: "Every 6 months",
  yearly: "Every year",
};
const FREQ_SHORT: Record<Frequency, string> = {
  monthly: "/ month",
  quarterly: "/ quarter",
  half_yearly: "/ half-year",
  yearly: "/ year",
};
const PER_MONTH: Record<Frequency, number> = { monthly: 1, quarterly: 3, half_yearly: 6, yearly: 12 };

const KEY = "/api/recurring";
const catOf = (n: string) => CATEGORIES.find((c) => c.name === n) ?? CATEGORIES[CATEGORIES.length - 1];

export default function Recurring() {
  const t = useT();
  const { data, error, loading, reload } = useApi<RecurringResponse>(KEY);
  const toast = useToast();
  const [editing, setEditing] = useState<RecurringExpense | "new" | null>(null);
  const [turningOn, setTurningOn] = useState(false);

  async function enable() {
    setTurningOn(true);
    try {
      await api("/api/automations/recurring_expenses", { method: "PATCH", body: { enabled: true } });
      invalidate(KEY, "/api/automations");
      toast("Recurring expenses are on");
    } catch (e) {
      toast(e instanceof ApiError ? e.message : "Couldn't turn it on.", "alert");
    } finally {
      setTurningOn(false);
    }
  }

  const add = data?.properties.length ? (
    <NavButton icon="plus" label="Add recurring expense" accent onClick={() => setEditing("new")} />
  ) : undefined;

  if (loading)
    return (
      <Page title="Recurring expenses" back tabs={false}>
        <SkeletonPage variant="list" />
      </Page>
    );
  if (error || !data)
    return (
      <Page title="Recurring expenses" back tabs={false}>
        <ErrorState error={error ?? { message: "Couldn't load recurring expenses." }} retry={reload} />
      </Page>
    );

  const active = data.items.filter((r) => r.active);
  const paused = data.items.filter((r) => !r.active);
  const monthly = active.reduce((n, r) => n + r.amount / PER_MONTH[r.frequency], 0);
  const soon = active.filter((r) => r.nextDate <= addDaysISO(todayISO(), 30)).reduce((n, r) => n + r.amount, 0);

  return (
    <Page title="Recurring expenses" back tabs={false} right={add}>
      {!data.enabled && (
        <Section>
          <div className="banner orange">
            <I.alert />
            <div className="grow">
              <b>{t("Automatic logging is off")}</b>
              <span>{t("Nothing below is added to your expenses until you turn it back on.")}</span>
            </div>
            <button className="btn sm auto" onClick={enable} disabled={turningOn}>
              {turningOn ? <Spinner size={16} /> : t("Turn on")}
            </button>
          </div>
        </Section>
      )}

      {!data.properties.length ? (
        <Empty icon="building" title="Add a property first" text="Recurring expenses belong to a property." />
      ) : !data.items.length ? (
        <Empty
          icon="calendar"
          title="No recurring expenses"
          text="Add society maintenance, property tax, insurance or a caretaker's salary once. pOS logs each one on its due date."
          action={
            <button className="btn md auto" onClick={() => setEditing("new")}>
              <I.plus /> {t("Add recurring expense")}
            </button>
          }
        />
      ) : (
        <>
          <Section>
            <div className="stats">
              <div className="stat">
                <div className="k">{t("About a month")}</div>
                <div className="v">{rupees(Math.round(monthly))}</div>
              </div>
              <div className="stat">
                <div className="k">{t("Due in 30 days")}</div>
                <div className="v">{rupees(soon)}</div>
              </div>
            </div>
          </Section>
          <Section
            title="Active"
            footer="Each one is logged as an expense on its due date, then moves to the next date."
          >
            {active.length ? (
              <div className="list icons">
                {active.map((r) => (
                  <RuleRow key={r.id} r={r} onClick={() => setEditing(r)} />
                ))}
              </div>
            ) : (
              <div className="card tight t-sub c2 center-text">{t("Everything is paused.")}</div>
            )}
          </Section>
          {paused.length > 0 && (
            <Section title="Paused">
              <div className="list icons">
                {paused.map((r) => (
                  <RuleRow key={r.id} r={r} onClick={() => setEditing(r)} />
                ))}
              </div>
            </Section>
          )}
        </>
      )}

      <Sheet
        open={editing !== null}
        onClose={() => setEditing(null)}
        title={editing === "new" ? t("New recurring expense") : t("Recurring expense")}
      >
        {editing !== null && (
          <RuleForm
            rule={editing === "new" ? null : editing}
            properties={data.properties}
            onClose={() => setEditing(null)}
          />
        )}
      </Sheet>
    </Page>
  );
}

function addDaysISO(d: string, n: number) {
  return new Date(Date.parse(`${d}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
}

function RuleRow({ r, onClick }: { r: RecurringExpense; onClick: () => void }) {
  const c = catOf(r.category);
  const title = r.note || r.category;
  return (
    <Row
      icon={c.icon}
      iconBg={r.active ? c.bg : "var(--gray-text)"}
      title={title}
      sub={[
        title !== r.category ? r.category : "",
        r.propertyName,
        r.active ? `next ${dateLabel(r.nextDate, true)}` : "paused",
        r.generated ? `${r.generated} logged` : "",
      ]
        .filter(Boolean)
        .join(" · ")}
      value={
        <span className="num">
          {rupees(r.amount)} <span className="c2">{FREQ_SHORT[r.frequency]}</span>
        </span>
      }
      chevron
      onClick={onClick}
    />
  );
}

function RuleForm({
  rule,
  properties,
  onClose,
}: {
  rule: RecurringExpense | null;
  properties: { id: number; name: string }[];
  onClose: () => void;
}) {
  const t = useT();
  const toast = useToast();
  const [propertyId, setPropertyId] = useState(rule?.propertyId ?? (properties.length === 1 ? properties[0].id : 0));
  const [category, setCategory] = useState(rule?.category ?? "Maintenance");
  const [amount, setAmount] = useState(rule ? String(rule.amount) : "");
  const [frequency, setFrequency] = useState<Frequency>(rule?.frequency ?? "monthly");
  const [nextDate, setNextDate] = useState(rule?.nextDate ?? todayISO());
  const [note, setNote] = useState(rule?.note ?? "");
  const [active, setActive] = useState(rule?.active ?? true);
  const [busy, setBusy] = useState<"" | "save" | "delete">("");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [err, setErr] = useState("");

  async function save() {
    const n = Math.round(Number(amount.replace(/[,\s]/g, "")));
    if (!propertyId) return setErr("Choose the property.");
    if (!n || n < 1) return setErr("Enter the amount.");
    if (!nextDate) return setErr("Enter the date it's next due.");
    setBusy("save");
    setErr("");
    try {
      const values = { propertyId, category, amount: n, frequency, nextDate, note: note.trim(), active };
      const r = await api<{ logged: number }>(rule ? `${KEY}/${rule.id}` : KEY, {
        method: rule ? "PATCH" : "POST",
        body: values,
      });
      invalidate(KEY, "/api/expenses", "/api/dashboard", "/api/reports");
      toast(
        r.logged
          ? `Saved · ${r.logged} ${r.logged === 1 ? "expense" : "expenses"} logged`
          : rule
            ? "Saved"
            : "Recurring expense added",
      );
      onClose();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : "Couldn't save.");
    } finally {
      setBusy("");
    }
  }

  async function remove() {
    if (!rule) return;
    if (!confirmDelete) return setConfirmDelete(true);
    setBusy("delete");
    try {
      await api(`${KEY}/${rule.id}`, { method: "DELETE" });
      invalidate(KEY);
      toast("Stopped. Expenses already logged stay.");
      onClose();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : "Couldn't delete.");
    } finally {
      setBusy("");
      setConfirmDelete(false);
    }
  }

  return (
    <>
      <Section>
        <div className="list">
          <Field
            label="Amount"
            value={amount}
            onChange={setAmount}
            inputMode="numeric"
            prefix="₹"
            big
            autoFocus={!rule}
          />
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
              {c.name}
            </button>
          ))}
        </div>
      </Section>
      <Section
        footer={
          rule?.lastDate
            ? t("Last logged {date}. Changes apply from the next date; logged expenses don't change.", {
                date: dateLabel(rule.lastDate, true),
              })
            : t("If the first date is today or earlier, it's logged straight away.")
        }
      >
        <div className="list">
          {properties.length > 1 && (
            <SelectField
              label="Property"
              value={propertyId}
              onChange={setPropertyId}
              options={[{ value: 0, label: "Choose…" }, ...properties.map((p) => ({ value: p.id, label: p.name }))]}
            />
          )}
          <SelectField
            label="Repeats"
            value={frequency}
            onChange={setFrequency}
            options={(Object.keys(FREQ_LABEL) as Frequency[]).map((f) => ({ value: f, label: FREQ_LABEL[f] }))}
          />
          <Field label={rule ? t("Next due") : t("First due")} type="date" value={nextDate} onChange={setNextDate} />
          <Field label="Note" value={note} onChange={setNote} placeholder="e.g. Society maintenance" maxLength={200} />
          {rule && (
            <Toggle label="Active" sub="Paused rules don't log anything" checked={active} onChange={setActive} />
          )}
        </div>
        <FormError text={err} />
        <button className="btn mt16" onClick={save} disabled={!!busy}>
          {busy === "save" ? <Spinner /> : rule ? t("Save changes") : t("Add recurring expense")}
        </button>
        {rule && (
          <button className="btn gray md mt12" onClick={remove} disabled={!!busy} style={{ color: "var(--red-text)" }}>
            {busy === "delete" ? <Spinner /> : confirmDelete ? t("Tap again to delete") : t("Delete")}
          </button>
        )}
      </Section>
    </>
  );
}
