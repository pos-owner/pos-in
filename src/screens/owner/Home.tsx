import { useEffect, useMemo, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { useNavigate } from "react-router-dom";
import { prefetch, useApi } from "../../lib/api";
import { useAuth } from "../../lib/auth";
import {
  dateLabel,
  daysFromToday,
  firstName,
  greeting,
  longToday,
  monthLabel,
  monthName,
  rupees,
} from "../../lib/format";
import { reminderText, whatsappLink } from "../../lib/links";
import { haptic } from "../../lib/perf";
import { useT } from "../../lib/i18n";
import type { Dashboard, LedgerResponse, LedgerRow, RemindersResponse, TenantListItem } from "../../lib/types";
import { features } from "../../lib/features";
import {
  Avatar,
  NavButton,
  Page,
  PRIORITY_COLOR,
  Row,
  Section,
  Sheet,
  SkeletonPage,
  StatusPill,
  ErrorState,
  Empty,
} from "../../components/kit";
import { I, Icon, type IconName } from "../../components/icons";
import { InstallCard } from "../../components/InstallCard";
import { ChargeSheet, chargeSub } from "./ChargeSheet";
import { AwaitingCard, pendingOf } from "./confirm";
import { Bell } from "../../components/Bell";
import { OutboxButton } from "../../components/OutboxButton";
import { openQuickSearch } from "../../components/QuickSearch";
import "../../styles/owner.css";

/**
 * Owner Home is a command center, not a status board: the first thing on screen answers "what needs me right now?"
 * (payments to confirm, overdue rent, urgent requests, approvals) with one-tap actions, then shows the month.
 */
export default function OwnerHome() {
  const tx = useT();
  const { me } = useAuth();
  const { data, error, loading, reload } = useApi<Dashboard>("/api/dashboard");
  // The ledger carries payment ids (for one-tap confirm) and per-unit status (for the property bars).
  const ledger = useApi<LedgerResponse>(data?.hasProperties ? "/api/ledger" : null);
  const reminders = useApi<RemindersResponse>(features.automations && data?.hasProperties ? "/api/reminders" : null);
  const [charge, setCharge] = useState<{ id: number; record?: boolean } | null>(null);
  const [collecting, setCollecting] = useState(false);
  const nav = useNavigate();
  const name = firstName(me?.profile?.fullName ?? "");
  const owner = me?.profile?.fullName || "Owner";
  const title = name ? `${greeting()}, ${name}` : greeting();
  const settings = (
    <>
      <OutboxButton />
      <NavButton icon="search" label="Search" onClick={() => openQuickSearch()} />
      <Bell />
      <NavButton icon="gear" label="Settings" onClick={() => nav("/settings")} />
    </>
  );

  const rows = useMemo(() => ledger.data?.rows ?? [], [ledger.data]);
  const awaitingRows = useMemo(
    () => rows.filter((r) => pendingOf(r).length > 0).sort((a, b) => a.month.localeCompare(b.month)),
    [rows],
  );
  const collectable = useMemo(
    () =>
      rows
        .filter((r) => r.balance > 0 && r.pending === 0 && (r.month <= (data?.month ?? "") || r.overdue))
        .sort((a, b) => Number(b.overdue) - Number(a.overdue) || a.month.localeCompare(b.month)),
    [rows, data?.month],
  );

  if (loading)
    return (
      <Page title="Home" eyebrow={longToday()} right={settings}>
        <SkeletonPage />
      </Page>
    );
  if (error || !data)
    return (
      <Page title="Home" right={settings}>
        <ErrorState error={error ?? { message: "Couldn't load your dashboard." }} retry={reload} />
      </Page>
    );

  if (!data.hasProperties) {
    return (
      <Page title={title} eyebrow={longToday()} right={settings}>
        <Section>
          <div className="card setup-card">
            <Empty
              icon="building"
              title="Let's set up your rent ledger"
              text="Three short steps and pOS creates each month's rent, reminders and receipts for you."
              action={
                <button className="btn md auto" onClick={() => nav("/more/properties?new=1")}>
                  <I.plus /> {tx("Add your first property")}
                </button>
              }
            />
            <SetupSteps
              steps={[
                { label: "Add a property and its units", sub: "Name, address and base rent per unit", done: false },
                { label: "Add your first tenant", sub: "Monthly rent and due day", done: false },
                { label: "Invite them to pOS", sub: "They pay by UPI and tap “I have paid”", done: false },
              ]}
              onGo={() => nav("/more/properties?new=1")}
            />
          </div>
        </Section>
        <InstallCard />
      </Page>
    );
  }

  const pct = data.due ? Math.min(1, data.collected / data.due) : 0;
  const left = Math.max(0, data.due - data.collected);
  const urgentRequests = data.openRequests.filter((r) => r.priority === "high");
  const otherRequests = data.openRequests.filter((r) => r.priority !== "high");
  const reminderCount = reminders.data?.items.length ?? 0;
  const soonLeases = data.leasesEnding.filter((l) => daysFromToday(l.endDate) <= 30);

  // While the ledger loads, the dashboard's slim list still lets the owner open each claim.
  const awaitingCount = ledger.data ? awaitingRows.length : data.awaiting.length;
  const inboxCount =
    awaitingCount +
    data.overdue.length +
    urgentRequests.length +
    (data.pendingExpenseCount ? 1 : 0) +
    (reminderCount ? 1 : 0);

  const quick: { label: string; icon: IconName; bg: string; run: () => void }[] = [
    { label: "Cash received", icon: "cash", bg: "var(--green)", run: () => setCollecting(true) },
    ...(features.meterReadings
      ? [{ label: "Meter reading", icon: "gauge" as IconName, bg: "var(--yellow)", run: () => nav("/more/meters") }]
      : [{ label: "Add tenant", icon: "userPlus" as IconName, bg: "var(--accent)", run: () => nav("/tenants?new=1") }]),
    { label: "Add expense", icon: "wallet", bg: "var(--indigo)", run: () => nav("/more/expenses?new=1") },
    { label: "New request", icon: "wrench", bg: "var(--orange)", run: () => nav("/requests?new=1") },
  ];

  return (
    <Page title={title} eyebrow={longToday()} right={settings}>
      <SetupChecklist data={data} ledgerRows={ledger.data ? rows.length : null} />

      {/* ---------- Action Inbox ---------- */}
      <Section
        title={
          <span className="inbox-head">
            {tx("Needs you now")} {inboxCount > 0 && <span className="count-pill">{inboxCount}</span>}
          </span>
        }
        action={
          awaitingCount > 1 ? (
            <button onClick={() => nav("/rent?view=awaiting")}>{tx("Confirm in bulk")}</button>
          ) : undefined
        }
      >
        {inboxCount === 0 ? (
          <div className="card tight caught-up">
            <span className="cu-ic">
              <I.checkCircle />
            </span>
            <span className="grow">
              <span className="t-headline" style={{ display: "block" }}>
                {tx("You're all caught up")}
              </span>
              <span className="t-sub c2">{tx("No payments to confirm, nothing overdue, no urgent requests.")}</span>
            </span>
          </div>
        ) : (
          <>
            {ledger.data
              ? awaitingRows
                  .slice(0, 3)
                  .map((r) => <AwaitingCard key={r.id} row={r} onOpen={() => setCharge({ id: r.id })} />)
              : data.awaiting.length > 0 && (
                  <div className="list">
                    {data.awaiting.slice(0, 3).map((c) => (
                      <Row
                        key={c.id}
                        avatar={c.tenantName}
                        title={c.tenantName}
                        sub={tx("{unitLabel} · says paid {amount}", {
                          unitLabel: c.unitLabel,
                          amount: rupees(c.pending),
                        })}
                        end={<StatusPill status="awaiting" />}
                        chevron
                        onClick={() => setCharge({ id: c.id })}
                      />
                    ))}
                  </div>
                )}
            {awaitingCount > 3 && (
              <button className="btn tinted md mt12" onClick={() => nav("/rent?view=awaiting")}>
                {tx("See all {awaitingCount} payments to confirm", { awaitingCount })}
              </button>
            )}

            {(data.overdue.length > 0 ||
              urgentRequests.length > 0 ||
              !!data.pendingExpenseCount ||
              !!reminderCount) && (
              <div className={`list ${awaitingCount ? "inbox-list" : ""}`}>
                {data.overdue.slice(0, 5).map((c) => {
                  const late = -daysFromToday(c.dueDate);
                  return (
                    <div className="row inbox-row" key={c.id}>
                      <button type="button" className="row" onClick={() => setCharge({ id: c.id })}>
                        <Avatar name={c.tenantName} />
                        <span className="grow">
                          <span className="title" style={{ display: "block" }}>
                            {c.tenantName}
                          </span>
                          <span className="sub" style={{ display: "block" }}>
                            <span className="money c-red">{rupees(c.balance)}</span> · {late}{" "}
                            {late === 1 ? tx("day") : tx("days")} {tx("late")}
                          </span>
                        </span>
                      </button>
                      <span className="row-actions">
                        {c.tenantPhone && (
                          <a
                            className="mini-btn wa-btn"
                            href={whatsappLink(c.tenantPhone, reminderText(c, owner))}
                            target="_blank"
                            rel="noopener noreferrer"
                            onClick={() => haptic()}
                            aria-label={tx("Send WhatsApp reminder to {tenantName}", { tenantName: c.tenantName })}
                          >
                            <I.chat /> <span className="mini-label">{tx("Remind")}</span>
                          </a>
                        )}
                        <button
                          type="button"
                          className="mini-btn"
                          onClick={() => setCharge({ id: c.id, record: true })}
                          aria-label={tx("Record a payment from {tenantName}", { tenantName: c.tenantName })}
                        >
                          <I.rupee /> {tx("Paid")}
                        </button>
                      </span>
                    </div>
                  );
                })}
                {data.overdue.length > 5 && (
                  <Row
                    icon="alert"
                    iconBg="var(--red)"
                    title={tx("{n} more overdue", { n: data.overdue.length - 5 })}
                    chevron
                    to="/rent?view=overdue"
                  />
                )}
                {urgentRequests.map((r) => (
                  <Row
                    key={r.id}
                    icon="wrench"
                    iconBg={PRIORITY_COLOR.high}
                    title={r.title}
                    sub={tx("Urgent · {unitLabel}", { unitLabel: r.unitLabel })}
                    end={<span className="mini-btn">{tx("View")}</span>}
                    to={`/requests/${r.id}`}
                  />
                ))}
                {!!data.pendingExpenseCount && (
                  <Row
                    icon="wallet"
                    iconBg="var(--indigo)"
                    title={tx("{n} {value} to approve", {
                      n: data.pendingExpenseCount,
                      value: data.pendingExpenseCount === 1 ? tx("expense") : tx("expenses"),
                    })}
                    sub="Logged by your staff"
                    end={<span className="mini-btn">{tx("Review")}</span>}
                    to="/more/expenses"
                  />
                )}
                {!!reminderCount && (
                  <Row
                    icon="chat"
                    iconBg="#25d366"
                    title={tx("{reminderCount} {value} to send", {
                      reminderCount,
                      value: reminderCount === 1 ? tx("reminder") : tx("reminders"),
                    })}
                    sub={
                      reminders
                        .data!.items.slice(0, 3)
                        .map((r) => firstName(r.tenantName))
                        .join(", ") + (reminderCount > 3 ? " and others" : "")
                    }
                    end={<span className="mini-btn">{tx("Send")}</span>}
                    to="/more/automations"
                  />
                )}
              </div>
            )}
          </>
        )}
      </Section>

      {/* ---------- This month ---------- */}
      <Section>
        <div className="hero collect-hero">
          <button
            type="button"
            style={{ width: "100%", textAlign: "left", display: "block" }}
            onClick={() => nav("/rent")}
            onPointerDown={() => prefetch("/api/ledger")}
          >
            <div className="between">
              <span className="k">{tx("{value} rent collected", { value: monthName(data.month) })}</span>
              <span className="pill green">{Math.round(pct * 100)}%</span>
            </div>
            <div className="mt8">
              <span className="amount">{rupees(data.collected)}</span>{" "}
              <span className="of">{tx("of {amount}", { amount: rupees(data.due) })}</span>
            </div>
            <div className="meter">
              <span style={{ "--p": pct } as CSSProperties} />
            </div>
            <div className="legend">
              <span>
                <i style={{ background: "var(--green)" }} /> {tx("Collected")}
              </span>
              <span>
                <i style={{ background: "var(--fill)" }} /> {rupees(left)} {tx("to collect")}
              </span>
              {data.outstanding > left && (
                <span>
                  <i style={{ background: "var(--red)" }} /> {rupees(data.outstanding)} {tx("total outstanding")}
                </span>
              )}
              {(data.advance ?? 0) > 0 && (
                <span>
                  <i style={{ background: "var(--indigo)" }} /> {rupees(data.advance)} {tx("paid ahead")}
                </span>
              )}
            </div>
          </button>
          <PropertyProgress rows={rows} month={data.month} />
        </div>
      </Section>

      <Section>
        <div className="quick">
          {quick.map((q) => (
            <button
              key={q.label}
              onClick={() => {
                haptic();
                q.run();
              }}
            >
              <span
                className="q-ic"
                style={{ background: `linear-gradient(160deg, color-mix(in srgb, ${q.bg} 78%, white), ${q.bg})` }}
              >
                <Icon name={q.icon} />
              </span>
              {q.label}
            </button>
          ))}
        </div>
      </Section>

      <Section>
        <div className="stats">
          <StatTile
            icon="building"
            color="var(--accent)"
            k="Occupancy"
            v={`${data.occupied}/${data.totalUnits}`}
            s={data.totalUnits - data.occupied ? `${data.totalUnits - data.occupied} vacant` : "All units let"}
            onClick={() => nav("/more/properties")}
          />
          <StatTile
            icon="wrench"
            color="var(--orange)"
            k="Open requests"
            v={String(data.openRequestCount)}
            s={data.openRequestCount ? "Needs attention" : "All clear"}
            onClick={() => nav("/requests")}
          />
        </div>
      </Section>

      {otherRequests.length > 0 && (
        <Section title="Open requests" action={<button onClick={() => nav("/requests")}>{tx("See all")}</button>}>
          <div className="list">
            {otherRequests.slice(0, 3).map((r) => (
              <Row
                key={r.id}
                className="req-row"
                title={
                  <span className="hstack" style={{ gap: 10 }}>
                    <span className="dot" style={{ background: PRIORITY_COLOR[r.priority], marginTop: 0 }} />
                    {r.title}
                  </span>
                }
                sub={<span style={{ paddingLeft: 18 }}>{r.unitLabel}</span>}
                end={<StatusPill status={r.status} plain />}
                chevron
                to={`/requests/${r.id}`}
              />
            ))}
          </div>
        </Section>
      )}

      {soonLeases.length > 0 && (
        <Section title="Leases ending soon">
          <div className="list icons">
            {soonLeases.map((l) => {
              const d = daysFromToday(l.endDate);
              return (
                <Row
                  key={l.tenancyId}
                  icon="calendar"
                  iconBg={d < 0 ? "var(--red)" : d <= 14 ? "var(--orange)" : "var(--teal)"}
                  title={l.tenantName}
                  sub={tx("{unitLabel} · ends {date}", { unitLabel: l.unitLabel, date: dateLabel(l.endDate, true) })}
                  value={d < 0 ? "Ended" : d === 0 ? "Today" : `${d}d`}
                  chevron
                  to={`/tenants/${l.tenantId}`}
                />
              );
            })}
          </div>
        </Section>
      )}

      <InstallCard />
      <div style={{ height: 56 }} aria-hidden="true" />

      <CollectFab
        onOpen={() => {
          haptic();
          setCollecting(true);
        }}
      />

      <CollectSheet
        open={collecting}
        rows={collectable}
        loading={ledger.loading}
        onClose={() => setCollecting(false)}
        onPick={(r) => {
          setCollecting(false);
          setCharge({ id: r.id, record: true });
        }}
      />
      <ChargeSheet chargeId={charge?.id ?? null} record={charge?.record} onClose={() => setCharge(null)} />
    </Page>
  );
}

/** "3/5 paid" per property, one segment per unit coloured by its status this month. */
function PropertyProgress({ rows, month }: { rows: LedgerRow[]; month: string }) {
  const tx = useT();
  const props = useMemo(() => {
    const m = new Map<number, { name: string; rows: LedgerRow[] }>();
    for (const r of rows) {
      if (r.month !== month) continue;
      const p = m.get(r.propertyId) ?? { name: r.propertyName, rows: [] };
      p.rows.push(r);
      m.set(r.propertyId, p);
    }
    return [...m.values()];
  }, [rows, month]);
  if (!props.length) return null;
  const segClass = (r: LedgerRow) =>
    r.status === "paid"
      ? "paid"
      : r.overdue
        ? "overdue"
        : r.status === "awaiting"
          ? "awaiting"
          : r.paid > 0
            ? "partial"
            : "";
  return (
    <div className="prop-progress" aria-label={tx("Collection by property")}>
      {props.map((p) => {
        const paid = p.rows.filter((r) => r.status === "paid").length;
        const sorted = [...p.rows].sort((a, b) => a.unitLabel.localeCompare(b.unitLabel));
        return (
          <div className="prop-line" key={p.name}>
            <div className="between">
              <b>{p.name}</b>
              <span className="num">{tx("{paid}/{n} paid", { paid, n: p.rows.length })}</span>
            </div>
            <div className="segs">
              {sorted.map((r, i) => (
                <i
                  key={r.id}
                  className={segClass(r)}
                  style={{ animationDelay: `${i * 40}ms` }}
                  title={`${r.unitLabel}: ${r.tenantName}`}
                />
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}

/** "Collect today": pick who paid in cash (or by bank) and record it in two taps. */
function CollectSheet({
  open,
  rows,
  loading,
  onClose,
  onPick,
}: {
  open: boolean;
  rows: LedgerRow[];
  loading: boolean;
  onClose: () => void;
  onPick: (r: LedgerRow) => void;
}) {
  return (
    <Sheet open={open} onClose={onClose} title="Record a payment">
      <Section footer="Pick who paid. Cash, bank transfers and UPI you've already seen in your bank app are recorded as confirmed.">
        {loading ? (
          <div className="list">
            <div className="sk-row">
              <div className="sk" style={{ height: 40, width: "100%" }} />
            </div>
          </div>
        ) : rows.length ? (
          <div className="list dense">
            {rows.map((r) => (
              <button type="button" key={r.id} className="row" onClick={() => onPick(r)}>
                <Avatar name={r.tenantName} />
                <span className="grow">
                  <span className="title" style={{ display: "block" }}>
                    {r.tenantName}
                  </span>
                  <span className="sub" style={{ display: "block" }}>
                    {monthLabel(r.month)} · {r.unitLabel} · {chargeSub(r)}
                  </span>
                </span>
                <span className="end">
                  <span className={`num money ${r.overdue ? "c-red" : ""}`}>{rupees(r.balance)}</span>
                  <I.chevR className="chev" />
                </span>
              </button>
            ))}
          </div>
        ) : (
          <div className="card">
            <Empty
              icon="checkCircle"
              title="Nothing left to collect"
              text="Every charge so far is paid or waiting for you to confirm."
            />
          </div>
        )}
      </Section>
    </Sheet>
  );
}

/** Guided first run: units → first tenant → invite → the ledger appears. Hidden once done or dismissed. */
function SetupChecklist({ data, ledgerRows }: { data: Dashboard; ledgerRows: number | null }) {
  const tx = useT();
  const nav = useNavigate();
  const [hidden, setHidden] = useState(() => {
    try {
      return localStorage.getItem("pos.setupDone") === "1";
    } catch {
      return false;
    }
  });
  const needTenants = !hidden && data.occupied > 0;
  const tenants = useApi<TenantListItem[]>(needTenants ? "/api/tenants" : null);
  const list = tenants.data ?? [];
  const steps = [
    { label: "Add a property", sub: "Done", done: true, to: "/more/properties" },
    {
      label: "Add units",
      sub: "Label, type and base rent for each flat",
      done: data.totalUnits > 0,
      to: "/more/properties",
    },
    {
      label: "Add your first tenant",
      sub: "Monthly rent and due day",
      done: data.occupied > 0,
      to: "/tenants?new=1",
    },
    {
      label: "Invite them to pOS",
      sub: "A link and a PIN; they pay by UPI in the app",
      done: list.some((t) => t.linked),
      to: "/more/invites",
    },
    { label: "See the rent ledger", sub: "One charge per tenant per month", done: (ledgerRows ?? 0) > 0, to: "/rent" },
  ];
  const doneCount = steps.filter((s) => s.done).length;
  // Wait for the facts before deciding, so the card doesn't flash for owners who are already set up.
  if (hidden || ledgerRows === null || (needTenants && tenants.loading) || doneCount === steps.length) return null;
  const dismiss = () => {
    try {
      localStorage.setItem("pos.setupDone", "1");
    } catch {
      /* storage blocked: hidden for this visit only */
    }
    setHidden(true);
  };
  return (
    <Section>
      <div className="card setup-card">
        <div className="between">
          <span className="t-headline">{tx("Finish setting up")}</span>
          <button className="t-sub c-accent" onClick={dismiss}>
            {tx("Hide")}
          </button>
        </div>
        <div className="hstack mt8" style={{ gap: 10 }}>
          <span className="progress-dots" aria-hidden="true">
            {steps.map((s, i) => (
              <i key={i} className={s.done ? "on" : ""} />
            ))}
          </span>
          <span className="t-foot c2">{tx("{doneCount} of {n} done", { doneCount, n: steps.length })}</span>
        </div>
        <SetupSteps steps={steps} onGo={(to) => nav(to)} />
      </div>
    </Section>
  );
}

function SetupSteps({
  steps,
  onGo,
}: {
  steps: { label: string; sub: string; done: boolean; to?: string }[];
  onGo: (to: string) => void;
}) {
  const next = steps.findIndex((s) => !s.done);
  return (
    <ol className="setup-steps">
      {steps.map((s, i) => (
        <li key={s.label}>
          <button
            type="button"
            className={`setup-step ${s.done ? "done" : i === next ? "next" : ""}`}
            disabled={s.done}
            onClick={() => onGo(s.to ?? "/more/properties?new=1")}
          >
            <span className="n">{s.done ? <I.check /> : i + 1}</span>
            <span className="grow">
              <b>{s.label}</b>
              {!s.done && <span>{s.sub}</span>}
            </span>
            {!s.done && <I.chevR className="chev" />}
          </button>
        </li>
      ))}
    </ol>
  );
}

function StatTile({
  icon,
  color,
  k,
  v,
  s,
  onClick,
}: {
  icon: IconName;
  color: string;
  k: string;
  v: string;
  s: string;
  onClick: () => void;
}) {
  return (
    <button className="stat stat-btn" onClick={onClick}>
      <div className="k">
        <Icon name={icon} style={{ color }} /> {k}
      </div>
      <div className="v">{v}</div>
      <div className="s">{s}</div>
    </button>
  );
}

/**
 * The floating "Collect" button. It shrinks to a round + once the page scrolls, so it covers less of the rows (and
 * their buttons) passing underneath, and grows back at the top.
 */
function CollectFab({ onOpen }: { onOpen: () => void }) {
  const t = useT();
  const [compact, setCompact] = useState(false);
  useEffect(() => {
    let frame = 0;
    const check = () => {
      frame = 0;
      setCompact(window.scrollY > 24);
    };
    const onScroll = () => {
      if (!frame) frame = requestAnimationFrame(check);
    };
    check();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      window.removeEventListener("scroll", onScroll);
      if (frame) cancelAnimationFrame(frame);
    };
  }, []);
  return createPortal(
    <button
      type="button"
      className={`fab ${compact ? "compact" : ""}`}
      aria-label={t("Collect")}
      onClick={onOpen}
      onPointerDown={() => prefetch("/api/ledger")}
    >
      <I.plus />
      <span className="fab-label" aria-hidden="true">
        {t("Collect")}
      </span>
    </button>,
    document.body,
  );
}
