import { useMemo, useState } from "react";
import { ApiError, downloadPdf, useApi } from "../../lib/api";
import { monthLabel, monthName, rupees } from "../../lib/format";
import type { ReportMonth, ReportResponse } from "../../lib/types";
import { Empty, ErrorState, NavButton, Page, Row, Section, Segmented, Skeleton, useToast } from "../../components/kit";
import { Icon } from "../../components/icons";
import { CATEGORIES } from "../shared/Expenses";
import "../../styles/owner.css";
import "../../styles/tools.css";
import { useT } from "../../lib/i18n";

type Span = "3" | "6" | "12";
const pct = (n: number) => `${Math.round(n * 100)}%`;
const short = (m: string) => monthName(m).slice(0, 3);

/** Compact rupees for chart axes: ₹1.2L, ₹45k. */
function compact(n: number) {
  if (Math.abs(n) >= 1e5) return `₹${(n / 1e5).toFixed(n >= 1e6 ? 0 : 1).replace(/\.0$/, "")}L`;
  if (Math.abs(n) >= 1e3) return `₹${Math.round(n / 1e3)}k`;
  return `₹${n}`;
}
/** A round ceiling for the y axis so gridlines land on friendly numbers. */
function niceMax(n: number) {
  if (n <= 0) return 1000;
  const p = 10 ** Math.floor(Math.log10(n));
  const f = n / p;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * p;
}

/** Owner: income, expenses, profit, occupancy and late payers over the last few months. */
export default function Reports() {
  const tx = useT();
  const toast = useToast();
  const [span, setSpan] = useState<Span>("6");
  const [propertyId, setPropertyId] = useState<number | null>(null);
  const key = `/api/reports?span=${span}${propertyId ? `&propertyId=${propertyId}` : ""}`;
  const { data, error, loading, reload } = useApi<ReportResponse>(key);

  return (
    <Page
      title="Reports & insights"
      back="/more"
      tabs={false}
      right={
        data && (
          <div style={{ display: "flex", gap: 8 }}>
            <NavButton
              icon="receipt"
              label="Download PDF"
              onClick={() => {
                // The PDF is drawn on this phone from the report data (see src/lib/pdf.ts).
                const q = `span=${span}${propertyId ? `&propertyId=${propertyId}` : ""}`;
                downloadPdf(`/api/reports/print.json?${q}`, `pOS-report-${data.from}-to-${data.to}.pdf`)
                  .then(() => toast("PDF downloaded"))
                  .catch((e) => toast(e instanceof ApiError ? e.message : "Couldn't prepare the PDF.", "alert"));
              }}
            />
            <NavButton
              icon="share"
              label="Export CSV"
              onClick={() => {
                exportCsv(data, propertyId);
                toast("Report downloaded");
              }}
            />
          </div>
        )
      }
    >
      <div className="pad mb16">
        <Segmented
          label="Period"
          value={span}
          onChange={setSpan}
          options={[
            { value: "3", label: "3 months" },
            { value: "6", label: "6 months" },
            { value: "12", label: "12 months" },
          ]}
        />
      </div>
      {data && data.properties.length > 1 && (
        <div className="pad mb16">
          <div className="chips" role="group" aria-label={tx("Property")}>
            <button
              type="button"
              className="chip"
              aria-pressed={propertyId === null}
              onClick={() => setPropertyId(null)}
            >
              {tx("All properties")}
            </button>
            {data.properties.map((p) => (
              <button
                key={p.id}
                type="button"
                className="chip"
                aria-pressed={propertyId === p.id}
                onClick={() => setPropertyId(p.id)}
              >
                {p.name}
              </button>
            ))}
          </div>
        </div>
      )}

      {loading ? (
        <Section>
          <Skeleton rows={5} avatar={false} />
        </Section>
      ) : error || !data ? (
        <ErrorState error={error ?? { message: "Couldn't load reports." }} retry={reload} />
      ) : !data.totals.units ? (
        <Empty
          icon="chart"
          title="Nothing to report yet"
          text="Add properties, units and tenants. Reports fill in as rent comes in and expenses are logged."
        />
      ) : (
        <ReportBody r={data} />
      )}
    </Page>
  );
}

function ReportBody({ r }: { r: ReportResponse }) {
  const tx = useT();
  const t = r.totals;
  const range = `${monthLabel(r.from)} – ${monthLabel(r.to)}`;
  return (
    <>
      <Section
        footer={tx(
          "{range}. Income counts confirmed payments by the date received. Expenses count approved entries only.",
          { range },
        )}
      >
        <div className="kpis">
          <div className="stat">
            <div className="k">{tx("Profit")}</div>
            <div className={`v ${t.profit >= 0 ? "pos" : "neg"}`}>{rupees(t.profit)}</div>
          </div>
          <div className="stat">
            <div className="k">{tx("Income")}</div>
            <div className="v">{rupees(t.income)}</div>
          </div>
          <div className="stat">
            <div className="k">{tx("Expenses")}</div>
            <div className="v">{rupees(t.expenses)}</div>
          </div>
          <div className="stat">
            <div className="k">{tx("Collected")}</div>
            <div className="v">{pct(t.collectionRate)}</div>
            <div className="s">
              {tx("{amount} of {amount2} billed", { amount: rupees(t.collected), amount2: rupees(t.billed) })}
            </div>
          </div>
        </div>
      </Section>

      <IncomeChart months={r.months} />

      <Section
        title="Occupancy"
        footer={tx("{value} of unit-months had a tenant across {n} {value2}.", {
          value: pct(t.occupancy),
          n: t.units,
          value2: t.units === 1 ? tx("unit") : tx("units"),
        })}
      >
        <div className="card">
          <div className="between">
            <span className="t-headline">{tx("{value} occupied", { value: pct(t.occupancy) })}</span>
            <span className="t-foot c2">
              {tx("{n} of {n2} let now", { n: r.months[r.months.length - 1]?.occupied ?? 0, n2: t.units })}
            </span>
          </div>
          <div
            className="occ-strip"
            role="img"
            aria-label={r.months.map((m) => `${monthLabel(m.month)} ${m.occupied} of ${m.units}`).join(", ")}
          >
            {r.months.map((m) => (
              <span
                key={m.month}
                style={{ "--p": m.units ? m.occupied / m.units : 0 } as React.CSSProperties}
                title={tx("{value}: {n} of {n2}", { value: monthLabel(m.month), n: m.occupied, n2: m.units })}
              />
            ))}
          </div>
          <div className="occ-strip-l" aria-hidden="true">
            {r.months.map((m, i) => (
              <span key={m.month}>{r.months.length > 6 && i % 2 ? "" : short(m.month)}</span>
            ))}
          </div>
        </div>
      </Section>

      {r.byProperty.length > 1 && (
        <Section title="By property">
          <div className="list">
            {r.byProperty.map((p) => {
              const max = Math.max(...r.byProperty.map((x) => x.income), 1);
              return (
                <div className="row" key={p.id}>
                  <span className="grow">
                    <span className="between">
                      <span className="title">{p.name}</span>
                      <span className={`num w6 ${p.profit < 0 ? "c-orange" : ""}`}>{rupees(p.profit)}</span>
                    </span>
                    <span className="sub" style={{ display: "block" }}>
                      {tx("{amount} in · {amount2} out · {n}/{n2} let", {
                        amount: rupees(p.income),
                        amount2: rupees(p.expenses),
                        n: p.occupied,
                        n2: p.units,
                      })}
                    </span>
                    <span className="hbar accent">
                      <span style={{ "--p": p.income / max } as React.CSSProperties} />
                    </span>
                  </span>
                </div>
              );
            })}
          </div>
        </Section>
      )}

      <Section title="Where the money went">
        {r.categories.length ? (
          <div className="list icons">
            {r.categories.map((c) => {
              const cat = CATEGORIES.find((x) => x.name === c.category) ?? CATEGORIES[CATEGORIES.length - 1];
              const share = t.expenses ? c.amount / t.expenses : 0;
              return (
                <div className="row" key={c.category}>
                  <span className="icon-sq" style={{ background: cat.bg }}>
                    <Icon name={cat.icon} />
                  </span>
                  <span className="grow">
                    <span className="between">
                      <span className="title">{c.category}</span>
                      <span className="num w6">{rupees(c.amount)}</span>
                    </span>
                    <span className="hbar">
                      <span style={{ "--p": share } as React.CSSProperties} />
                    </span>
                  </span>
                </div>
              );
            })}
          </div>
        ) : (
          <div className="card tight t-sub c2 center-text">{tx("No approved expenses in this period.")}</div>
        )}
      </Section>

      <Section title="Paying late" footer="Months where rent was fully paid after the due date, or is still unpaid.">
        {r.latePayers.length ? (
          <div className="list">
            {r.latePayers.map((p) => (
              <Row
                key={p.tenantId}
                avatar={p.tenantName}
                title={p.tenantName}
                sub={tx("Late {n} of {n2} {value} · about {n3} {value2} late", {
                  n: p.lateMonths,
                  n2: p.months,
                  value: p.months === 1 ? tx("month") : tx("months"),
                  n3: p.avgDaysLate,
                  value2: p.avgDaysLate === 1 ? tx("day") : tx("days"),
                })}
                end={
                  p.unpaid ? (
                    <span className="pill red">{tx("{n} unpaid", { n: p.unpaid })}</span>
                  ) : (
                    <span className="pill orange">{tx("Late")}</span>
                  )
                }
                chevron
                to={`/tenants/${p.tenantId}`}
              />
            ))}
          </div>
        ) : (
          <div className="card tight t-sub c2 center-text">{tx("Everyone paid on time. Nice.")}</div>
        )}
      </Section>

      {r.vacancy.length > 0 && (
        <Section title="Vacant months" footer="Months in this period when the unit had no tenancy.">
          <div className="list">
            {r.vacancy.map((v) => (
              <Row
                key={v.unitId}
                icon="building"
                iconBg="var(--label-2)"
                title={v.unitLabel}
                sub={v.propertyName}
                value={
                  <span className="num">
                    {v.vacantMonths} {v.vacantMonths === 1 ? tx("month") : tx("months")}
                  </span>
                }
              />
            ))}
          </div>
        </Section>
      )}
    </>
  );
}

function IncomeChart({ months }: { months: ReportMonth[] }) {
  const tx = useT();
  const [sel, setSel] = useState<string | null>(null);
  const max = useMemo(() => niceMax(Math.max(...months.map((m) => Math.max(m.income, m.expenses)), 0)), [months]);
  const picked = months.find((m) => m.month === sel) ?? months[months.length - 1];
  const dense = months.length > 6;
  return (
    <Section title="Income and expenses">
      <div className="card">
        <div className="legend" style={{ marginTop: 0 }}>
          <span>
            <i style={{ background: "var(--series-1)" }} /> {tx("Income")}
          </span>
          <span>
            <i style={{ background: "var(--series-2)" }} /> {tx("Expenses")}
          </span>
        </div>
        <div className="chart mt12">
          <div className="grid-y" aria-hidden="true">
            {[1, 0.5, 0].map((f) => (
              <span key={f}>
                <em>{compact(max * f)}</em>
              </span>
            ))}
          </div>
          <div className="bars" style={{ gap: dense ? 4 : 10 }}>
            {months.map((m, i) => (
              <button
                type="button"
                className="b"
                key={m.month}
                aria-pressed={picked?.month === m.month}
                aria-label={tx("{value}: income {amount}, expenses {amount2}", {
                  value: monthLabel(m.month, true),
                  amount: rupees(m.income),
                  amount2: rupees(m.expenses),
                })}
                onClick={() => setSel(m.month)}
              >
                <span className="pair">
                  <i
                    style={{
                      height: `${(m.income / max) * 100}%`,
                      minHeight: m.income ? 3 : 0,
                      background: "var(--series-1)",
                    }}
                  />
                  <i
                    style={{
                      height: `${(m.expenses / max) * 100}%`,
                      minHeight: m.expenses ? 3 : 0,
                      background: "var(--series-2)",
                    }}
                  />
                </span>
                <span className="lbl">{dense && i % 2 ? "" : short(m.month)}</span>
              </button>
            ))}
          </div>
        </div>
        {picked && (
          <div className="chart-tip" aria-live="polite">
            <span className="w6">{monthLabel(picked.month, true)}</span>
            <span>
              {tx("In")} <b>{rupees(picked.income)}</b> {tx("· Out")} <b>{rupees(picked.expenses)}</b> {tx("· Profit")}{" "}
              <b className={picked.profit < 0 ? "c-orange" : "c-green"}>{rupees(picked.profit)}</b>
            </span>
          </div>
        )}
      </div>
    </Section>
  );
}

/** Builds a CSV the owner can send to their CA. Everything is already on screen, so no extra request. */
function exportCsv(r: ReportResponse, propertyId: number | null) {
  const q = (v: string | number) => (typeof v === "number" ? String(v) : `"${v.replace(/"/g, '""')}"`);
  const lines: (string | number)[][] = [
    ["pOS report", `${monthLabel(r.from)} to ${monthLabel(r.to)}`],
    ["Property", propertyId ? (r.properties.find((p) => p.id === propertyId)?.name ?? "") : "All properties"],
    [],
    [
      "Month",
      "Income (INR)",
      "Expenses (INR)",
      "Profit (INR)",
      "Rent billed (INR)",
      "Collected on bills (INR)",
      "Occupied units",
      "Total units",
    ],
    ...r.months.map((m) => [
      monthLabel(m.month, true),
      m.income,
      m.expenses,
      m.profit,
      m.billed,
      m.collectedOnBill,
      m.occupied,
      m.units,
    ]),
    [
      "Total",
      r.totals.income,
      r.totals.expenses,
      r.totals.profit,
      r.totals.billed,
      r.totals.collected,
      "",
      r.totals.units,
    ],
    [],
    ["Expense category", "Amount (INR)"],
    ...r.categories.map((c) => [c.category, c.amount]),
    [],
    ["Property", "Income (INR)", "Expenses (INR)", "Profit (INR)", "Units", "Let now"],
    ...r.byProperty.map((p) => [p.name, p.income, p.expenses, p.profit, p.units, p.occupied]),
  ];
  const csv = lines.map((l) => l.map(q).join(",")).join("\r\n");
  const url = URL.createObjectURL(new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = `pOS-report-${r.from}-to-${r.to}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}
