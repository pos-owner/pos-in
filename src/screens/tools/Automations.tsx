import { useState } from "react";
import { api, ApiError, invalidate, useApi } from "../../lib/api";
import { useAuth } from "../../lib/auth";
import { monthLabel, relTime, rupees } from "../../lib/format";
import { reminderText, upcomingReminderText, whatsappLink } from "../../lib/links";
import type { AutomationsResponse, Flow, FlowKey, ReminderItem, RemindersResponse } from "../../lib/types";
import { ErrorState, Field, Page, Row, Section, Segmented, Skeleton, Toggle, useToast } from "../../components/kit";
import { I, Icon, type IconName } from "../../components/icons";
import "../../styles/owner.css";
import "../../styles/tools.css";
import { useT } from "../../lib/i18n";

/** The monthly cycle, and which workflow powers each link in it. */
const STEPS: { icon: IconName; bg: string; title: string; sub: string; flow?: FlowKey }[] = [
  { icon: "gauge", bg: "var(--orange)", title: "Meter reading saved", sub: "You or your staff scan the meter" },
  {
    icon: "rupee",
    bg: "var(--green)",
    title: "Bill added to rent",
    sub: "Units × your rate join the month's charge",
    flow: "meter_to_bill",
  },
  {
    icon: "chat",
    bg: "#25d366",
    title: "Reminder lined up",
    sub: "One tap sends it on WhatsApp",
    flow: "rent_reminders",
  },
  {
    icon: "receipt",
    bg: "var(--teal)",
    title: "Receipt issued",
    sub: "PDF ready as soon as you confirm payment",
    flow: "auto_receipts",
  },
];

const RUN: Record<string, { label: (n: string | null) => string; bg: string }> = {
  receipt: { label: () => "Receipt issued for a payment", bg: "var(--teal)" },
  bill: { label: () => "Meter bill added to rent", bg: "var(--green)" },
  charges: {
    label: (n) => `${n ?? "New"} rent ${n === "1" ? "charge" : "charges"} created for the month`,
    bg: "var(--accent)",
  },
  reminders: { label: (n) => `${n ?? "Some"} ${n === "1" ? "reminder" : "reminders"} ready to send`, bg: "#25d366" },
  late_fee: { label: (n) => `${n ?? "A"} late ${n === "1" ? "fee" : "fees"} added`, bg: "var(--red)" },
  recurring_expense: {
    label: (n) => `${n ?? "Some"} recurring ${n === "1" ? "expense" : "expenses"} logged`,
    bg: "var(--indigo)",
  },
  lease_alert: { label: (n) => `${n ?? "A"} lease expiry ${n === "1" ? "alert" : "alerts"} sent`, bg: "var(--orange)" },
  end_tenancy: {
    label: (n) => `${n ?? "A"} ${n === "1" ? "tenancy" : "tenancies"} ended at move-out`,
    bg: "var(--purple)",
  },
};

/** Owner: switch the ready-made workflows on or off, tune reminders, and send what's queued. */
export default function Automations() {
  const t = useT();
  const toast = useToast();
  const auto = useApi<AutomationsResponse>("/api/automations");
  const queue = useApi<RemindersResponse>("/api/reminders");
  const [saving, setSaving] = useState<FlowKey | "">("");
  // Optimistic copy so switches respond instantly.
  const [local, setLocal] = useState<Record<string, Partial<Flow>>>({});

  const flows = (auto.data?.flows ?? []).map((f) => ({
    ...f,
    ...local[f.key],
    config: { ...f.config, ...local[f.key]?.config },
  }));
  const on = (k: FlowKey) => flows.find((f) => f.key === k)?.enabled ?? false;

  async function save(f: Flow, patch: { enabled?: boolean; config?: Record<string, number> }) {
    setLocal((l) => ({ ...l, [f.key]: { ...l[f.key], ...patch, config: { ...l[f.key]?.config, ...patch.config } } }));
    setSaving(f.key);
    try {
      await api(`/api/automations/${f.key}`, {
        method: "PATCH",
        body: { enabled: patch.enabled ?? f.enabled, config: { ...f.config, ...patch.config } },
      });
      if (patch.enabled !== undefined) toast(patch.enabled ? `${f.title} is on` : `${f.title} is off`);
      invalidate("/api/automations", "/api/reminders", "/api/meters");
    } catch (e) {
      setLocal((l) => {
        const n = { ...l };
        delete n[f.key];
        return n;
      });
      toast(e instanceof ApiError ? e.message : "Couldn't save that change.", "alert");
    } finally {
      setSaving("");
    }
  }

  return (
    <Page title="Automations" back="/more" tabs={false}>
      {auto.loading ? (
        <Section>
          <Skeleton rows={4} />
        </Section>
      ) : auto.error || !auto.data ? (
        <ErrorState error={auto.error ?? { message: "Couldn't load automations." }} retry={auto.reload} />
      ) : (
        <>
          <Section footer="Each step runs on its own once it's switched on. Rent charges for the new month are created every morning at 6 AM.">
            <div className="card flow-hero">
              <div className="t-headline mb8">{t("Monthly rent cycle")}</div>
              <div className="flow mt8">
                {STEPS.map((s, i) => {
                  const lit = !s.flow || on(s.flow);
                  return (
                    <div key={s.title}>
                      {i > 0 && <div className={`flow-link ${lit ? "on" : ""}`} />}
                      <div className={`flow-step ${lit ? "" : "off"}`}>
                        <span className="icon-sq" style={{ background: s.bg }}>
                          <Icon name={s.icon} />
                        </span>
                        <span className="grow">
                          <span className="t-callout w6" style={{ display: "block" }}>
                            {s.title}
                          </span>
                          <span className="t-foot c2" style={{ display: "block" }}>
                            {lit ? s.sub : t("Switched off")}
                          </span>
                        </span>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          </Section>

          <Section title="Workflows">
            <div className="list">
              {flows.map((f) => (
                <Toggle
                  key={f.key}
                  label={f.title}
                  sub={f.sub}
                  checked={f.enabled}
                  onChange={(v) => save(f, { enabled: v })}
                />
              ))}
            </div>
          </Section>

          {flows
            .filter((f) => f.key === "rent_reminders" && f.enabled)
            .map((f) => (
              <Section
                key={f.key}
                title="Reminder timing"
                footer="Tenants who tap “I have paid” are skipped while you confirm."
              >
                <div className="list">
                  <StepperRow
                    label="Start before due date"
                    value={f.config.daysBefore ?? 2}
                    min={0}
                    max={10}
                    unit="day"
                    busy={saving === f.key}
                    onChange={(v) => save(f, { config: { daysBefore: v } })}
                  />
                  <StepperRow
                    label="Repeat every"
                    value={f.config.repeatEvery ?? 3}
                    min={1}
                    max={14}
                    unit="day"
                    busy={saving === f.key}
                    onChange={(v) => save(f, { config: { repeatEvery: v } })}
                  />
                </div>
              </Section>
            ))}

          {flows
            .filter((f) => f.key === "advance_rent")
            .map((f) => (
              <Section
                key={f.key}
                title="Advance rent"
                footer={
                  f.enabled
                    ? t(
                        "Tenants can clear dues and pay up to {n} {value} ahead in one UPI transfer, never past the lease end. Each month gets its share and one receipt covers the lot.",
                        {
                          n: f.config.maxMonthsAhead ?? 12,
                          value: (f.config.maxMonthsAhead ?? 12) === 1 ? t("month") : t("months"),
                        },
                      )
                    : t(
                        "Tenants can still clear months that are due. You can always record money received ahead from a tenant's page.",
                      )
                }
              >
                <div className="list">
                  <StepperRow
                    label="Pay ahead up to"
                    value={f.config.maxMonthsAhead ?? 12}
                    min={1}
                    max={24}
                    unit="month"
                    busy={saving === f.key || !f.enabled}
                    onChange={(v) => save(f, { config: { maxMonthsAhead: v } })}
                  />
                </div>
              </Section>
            ))}

          {flows
            .filter((f) => f.key === "lease_alerts" && f.enabled)
            .map((f) => (
              <Section
                key={f.key}
                title="Lease expiry alerts"
                footer="You get an in-app and push alert this many days before each lease ends. A lease that runs past its end date keeps billing (holdover) and is flagged until you renew it or set a move-out."
              >
                <div className="list">
                  {(
                    [
                      ["first", "First alert", 60],
                      ["second", "Second alert", 30],
                      ["last", "Last alert", 7],
                    ] as const
                  ).map(([k, label, d]) => (
                    <StepperRow
                      key={k}
                      label={label}
                      value={f.config[k] ?? d}
                      min={1}
                      max={180}
                      unit="day"
                      busy={saving === f.key}
                      onChange={(v) => save(f, { config: { [k]: v } })}
                    />
                  ))}
                </div>
              </Section>
            ))}

          {flows
            .filter((f) => f.key === "prorate" && f.enabled)
            .map((f) => (
              <Section
                key={f.key}
                title="Pro-rating"
                footer="Applies to the move-in and move-out months created from now on. Months already billed keep their amount."
              >
                <Segmented
                  label="Count days by"
                  value={String(f.config.method ?? 0) as "0" | "1"}
                  onChange={(v) => save(f, { config: { method: Number(v) } })}
                  options={[
                    { value: "0", label: "Days in the month" },
                    { value: "1", label: "30-day month" },
                  ]}
                />
              </Section>
            ))}

          {flows
            .filter((f) => f.key === "late_fees" && f.enabled)
            .map((f) => (
              <LateFeeSettings key={f.key} f={f} busy={saving === f.key} save={(config) => save(f, { config })} />
            ))}

          {on("recurring_expenses") && (
            <Section>
              <div className="list icons">
                <Row
                  icon="calendar"
                  iconBg="var(--indigo)"
                  title="Recurring expenses"
                  sub="Society maintenance, taxes and other regular bills"
                  chevron
                  to="/more/recurring"
                />
              </div>
            </Section>
          )}

          {on("rent_reminders") && <ReminderQueue q={queue} />}

          <Section
            title="Recent activity"
            footer="Everything an automation does is logged here, so nothing happens silently."
          >
            {auto.data.runs.length ? (
              <div className="list">
                {auto.data.runs.map((r) => {
                  const m = RUN[r.action] ?? { label: () => r.action, bg: "var(--label-2)" };
                  return (
                    <div className="row" key={r.id}>
                      <span className="run-dot" style={{ background: m.bg }} />
                      <span className="grow">
                        <span className="title" style={{ display: "block" }}>
                          {m.label(r.entityId)}
                        </span>
                      </span>
                      <span className="end">
                        <span className="t-foot c2">{relTime(r.createdAt)}</span>
                      </span>
                    </div>
                  );
                })}
              </div>
            ) : (
              <div className="card tight t-sub c2 center-text">
                {t("Nothing has run yet. Activity shows up here after the next payment, reading or morning run.")}
              </div>
            )}
          </Section>
        </>
      )}
    </Page>
  );
}

function StepperRow({
  label,
  value,
  min,
  max,
  unit,
  busy,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  unit: string;
  busy: boolean;
  onChange: (v: number) => void;
}) {
  const t = useT();
  return (
    <div className="row">
      <span className="grow">
        <span className="title">{label}</span>
      </span>
      <span className="end">
        <span className="stepper">
          <button
            type="button"
            aria-label={t("Fewer {unit}s", { unit })}
            disabled={busy || value <= min}
            onClick={() => onChange(value - 1)}
          >
            −
          </button>
          <b aria-live="polite">{value}</b>
          <button
            type="button"
            aria-label={t("More {unit}s", { unit })}
            disabled={busy || value >= max}
            onClick={() => onChange(value + 1)}
          >
            +
          </button>
        </span>
        <span className="t-sub c2" style={{ minWidth: 34 }}>
          {value === 1 ? unit : `${unit}s`}
        </span>
      </span>
    </div>
  );
}

function ReminderQueue({ q }: { q: ReturnType<typeof useApi<RemindersResponse>> }) {
  const t = useT();
  const { me } = useAuth();
  const owner = me?.profile?.fullName || "Owner";
  const [sent, setSent] = useState<Set<number>>(new Set());
  const items = (q.data?.items ?? []).filter((i) => !sent.has(i.id));

  function mark(r: ReminderItem) {
    setSent((s) => new Set(s).add(r.id));
    api(`/api/charges/${r.id}/reminded`, { method: "POST" })
      .then(() => invalidate("/api/automations"))
      .catch(() =>
        setSent((s) => {
          const n = new Set(s);
          n.delete(r.id);
          return n;
        }),
      );
  }

  return (
    <Section
      title="Reminders to send"
      footer="Tap to open WhatsApp with the message filled in. A sent reminder comes back after the repeat gap if rent is still unpaid."
    >
      {q.loading ? (
        <Skeleton rows={2} />
      ) : q.error ? (
        <ErrorState error={q.error} retry={q.reload} />
      ) : items.length ? (
        <div className="list">
          {items.map((r) => (
            <Row
              key={r.id}
              avatar={r.tenantName}
              title={r.tenantName}
              sub={`${r.unitLabel} · ${monthLabel(r.month)} · ${rupees(r.balance)}`}
              end={
                <>
                  <span className={`pill ${r.overdue ? "red" : "orange"}`}>{r.reason}</span>
                  {r.tenantPhone ? (
                    <a
                      className="circle-btn plain wa"
                      href={whatsappLink(r.tenantPhone, (r.overdue ? reminderText : upcomingReminderText)(r, owner))}
                      target="_blank"
                      rel="noopener noreferrer"
                      aria-label={t("Send WhatsApp reminder to {tenantName}", { tenantName: r.tenantName })}
                      onClick={() => mark(r)}
                    >
                      <I.chat />
                    </a>
                  ) : null}
                </>
              }
            />
          ))}
        </div>
      ) : (
        <div className="card tight t-sub c2 center-text">
          <I.checkCircle style={{ width: 16, height: 16, verticalAlign: "-3px" }} />{" "}
          {t("All caught up. No reminders due right now.")}
        </div>
      )}
    </Section>
  );
}

/** Late fee rule: flat amount, a percent of the month's rent, or an amount per day late, after a grace period. */
function LateFeeSettings({
  f,
  busy,
  save,
}: {
  f: Flow;
  busy: boolean;
  save: (config: Record<string, number>) => void;
}) {
  const t = useT();
  const mode = f.config.mode ?? 0;
  const [amount, setAmount] = useState(String(f.config.amount ?? 500));
  const [cap, setCap] = useState(String(f.config.cap ?? 0));
  const n = (v: string) => Math.max(0, Math.round(Number(v.replace(/[,\s%₹]/g, "")) || 0));
  const amountN = n(amount);
  const example =
    mode === 1
      ? `${amountN}% of the month's rent`
      : mode === 2
        ? `${rupees(amountN)} for every day late`
        : `${rupees(amountN)} once`;
  return (
    <Section
      title="Late fee rule"
      footer={t(
        "Rent still unpaid {n} {value} after the due date gets {example}{value2}. Fees show separately on the month and can be waived.",
        {
          n: f.config.graceDays ?? 5,
          value: (f.config.graceDays ?? 5) === 1 ? t("day") : t("days"),
          example,
          value2: n(cap) && mode !== 0 ? `, up to ${rupees(n(cap))} a month` : "",
        },
      )}
    >
      <Segmented
        label="Fee type"
        value={String(mode) as "0" | "1" | "2"}
        onChange={(v) => {
          const m = Number(v);
          const next = m === 1 ? 2 : m === 2 ? 50 : 500;
          setAmount(String(next));
          save({ mode: m, amount: next });
        }}
        options={[
          { value: "0", label: "Flat" },
          { value: "1", label: "% of rent" },
          { value: "2", label: "Per day" },
        ]}
      />
      <div className="list mt12">
        <StepperRow
          label="Grace period"
          value={f.config.graceDays ?? 5}
          min={0}
          max={60}
          unit="day"
          busy={busy}
          onChange={(v) => save({ graceDays: v })}
        />
        <div onBlur={() => amountN !== f.config.amount && save({ amount: amountN })}>
          <Field
            label={mode === 1 ? t("Percent") : mode === 2 ? t("Per day") : t("Amount")}
            value={amount}
            onChange={setAmount}
            inputMode="numeric"
            prefix={mode === 1 ? "%" : "₹"}
          />
        </div>
        {mode !== 0 && (
          <div onBlur={() => n(cap) !== f.config.cap && save({ cap: n(cap) })}>
            <Field
              label="Cap per month"
              value={cap}
              onChange={setCap}
              inputMode="numeric"
              prefix="₹"
              placeholder="0 = no cap"
            />
          </div>
        )}
      </div>
    </Section>
  );
}
