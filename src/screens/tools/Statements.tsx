import { useMemo, useState } from "react";
import { useApi } from "../../lib/api";
import { useAuth } from "../../lib/auth";
import { monthLabel, rupees } from "../../lib/format";
import type { StatementsResponse, StatementTenancy } from "../../lib/types";
import type { StatementModel } from "../../../shared/pdf/models";
import { Empty, ErrorState, Page, Section, Segmented, SelectField, SkeletonPage } from "../../components/kit";
import { PdfButton } from "./TenantDocs";
import { useT } from "../../lib/i18n";

/*
 * Rent statements. Owner: /more/statements, tenant: /statements.
 * One tenancy over a month, a calendar year or an April–March financial year, for the tenant's HRA claim. The
 * screen shows the statement's totals first, then shares the PDF (drawn in the browser from the same data).
 */

type Period = StatementModel["period"];
const PERIODS: { value: Period; label: string }[] = [
  { value: "fy", label: "Financial year" },
  { value: "year", label: "Year" },
  { value: "month", label: "Month" },
];

/** Every YYYY-MM from `from` to `to`, newest first. */
function monthsBetween(from: string, to: string) {
  const out: string[] = [];
  let [y, m] = from.split("-").map(Number);
  const [ty, tm] = to.split("-").map(Number);
  while (y < ty || (y === ty && m <= tm)) {
    out.push(`${y}-${String(m).padStart(2, "0")}`);
    m++;
    if (m > 12) {
      m = 1;
      y++;
    }
    if (out.length > 600) break;
  }
  return out.reverse();
}

/** The values a period can take for one tenancy, newest first, with labels. */
function choices(t: StatementTenancy | undefined, period: Period): { value: string; label: string }[] {
  if (!t?.firstMonth || !t.lastMonth) return [];
  const months = monthsBetween(t.firstMonth, t.lastMonth);
  if (period === "month") return months.map((m) => ({ value: m, label: monthLabel(m, true) }));
  if (period === "year") return [...new Set(months.map((m) => m.slice(0, 4)))].map((y) => ({ value: y, label: y }));
  // Financial years start in April: Jan–Mar belong to the year before.
  const fys = [...new Set(months.map((m) => Number(m.slice(0, 4)) - (Number(m.slice(5, 7)) < 4 ? 1 : 0)))];
  return fys.map((y) => ({ value: String(y), label: `FY ${y}–${String((y + 1) % 100).padStart(2, "0")}` }));
}

export default function Statements() {
  const tx = useT();
  const { me } = useAuth();
  const owner = me?.profile?.role === "owner";
  const { data, error, loading, reload } = useApi<StatementsResponse>("/api/statements");
  const [tenancyId, setTenancyId] = useState<number | null>(null);
  const [period, setPeriod] = useState<Period>("fy");
  const [value, setValue] = useState<string>("");

  const tenancy = data?.tenancies.find((t) => t.tenancyId === tenancyId) ?? data?.tenancies[0];
  const options = useMemo(() => choices(tenancy, period), [tenancy, period]);
  const chosen = options.find((o) => o.value === value)?.value ?? options[0]?.value ?? "";
  const path =
    tenancy && chosen ? `/api/tenancies/${tenancy.tenancyId}/statement.json?period=${period}&value=${chosen}` : null;

  const title = "Rent statements";
  if (loading)
    return (
      <Page title={title} back tabs={false}>
        <SkeletonPage variant="list" />
      </Page>
    );
  if (error || !data)
    return (
      <Page title={title} back tabs={false}>
        <ErrorState error={error ?? { message: "Couldn't load statements." }} retry={reload} />
      </Page>
    );

  if (!data.tenancies.length)
    return (
      <Page title={title} back tabs={false}>
        <Empty
          icon="receipt"
          title="Nothing to put on a statement yet"
          text={
            owner
              ? tx("Statements are made from the rent ledger. Add a tenant to a unit and their months appear here.")
              : tx("Your statement appears here once your owner has set up your rent.")
          }
        />
      </Page>
    );

  return (
    <Page title={title} back tabs={false}>
      <Section
        footer={
          owner
            ? tx(
                "A statement lists each month's rent, every payment received and your PAN, as most employers ask for an HRA claim.",
              )
            : tx(
                "Most employers accept this for an HRA claim. It lists each month's rent, what you paid and your landlord's PAN.",
              )
        }
      >
        <div className="list">
          {data.tenancies.length > 1 && (
            <SelectField
              label={owner ? tx("Tenant") : tx("Home")}
              value={tenancy?.tenancyId ?? 0}
              onChange={(v) => {
                setTenancyId(Number(v));
                setValue("");
              }}
              options={data.tenancies.map((t) => ({
                value: t.tenancyId,
                label: `${owner ? `${t.tenantName} · ` : ""}${t.unitLabel}, ${t.propertyName}${t.status === "active" ? "" : " (ended)"}`,
              }))}
            />
          )}
          {options.length > 0 && (
            <SelectField
              label={period === "fy" ? tx("Financial year") : period === "year" ? tx("Year") : tx("Month")}
              value={chosen}
              onChange={(v) => setValue(String(v))}
              options={options}
            />
          )}
        </div>
      </Section>
      <Section>
        <Segmented
          label="Statement period"
          value={period}
          onChange={(p) => {
            setPeriod(p);
            setValue("");
          }}
          options={PERIODS}
        />
      </Section>
      {path && tenancy ? (
        <Preview key={path} path={path} owner={owner} />
      ) : (
        <Empty icon="calendar" title="No months yet" text="This tenancy has no rent on record yet." />
      )}
    </Page>
  );
}

function Preview({ path, owner }: { path: string; owner: boolean }) {
  const tx = useT();
  const { data, error, loading, reload } = useApi<StatementModel>(path);
  if (loading)
    return (
      <Section>
        <div className="card">
          <div className="sk" style={{ height: 96 }} />
        </div>
      </Section>
    );
  if (error || !data)
    return error?.status === 404 ? (
      <Empty icon="calendar" title="No rent in this period" text={error.message} />
    ) : (
      <ErrorState error={error ?? { message: "Couldn't load this statement." }} retry={reload} />
    );

  const missingPan = !data.ownerPan;
  return (
    <>
      <Section title={`${data.tenantName} · ${data.periodLabel}`}>
        <div className="stats">
          <div className="stat">
            <div className="k">{tx("Rent")}</div>
            <div className="v">{rupees(data.totalRent)}</div>
          </div>
          <div className="stat">
            <div className="k">{tx("Paid")}</div>
            <div className="v">{rupees(data.totalPaid)}</div>
          </div>
          <div className="stat">
            <div className="k">{tx("Balance")}</div>
            <div className="v" style={{ color: data.balance ? "var(--orange-text)" : undefined }}>
              {rupees(data.balance)}
            </div>
          </div>
          <div className="stat">
            <div className="k">{tx("Months · payments")}</div>
            <div className="v">
              {data.months.length} · {data.payments.length}
            </div>
          </div>
        </div>
      </Section>
      {missingPan && (
        <Section>
          <div className="banner orange">
            <div className="grow">
              <b>{tx("No landlord PAN on this statement")}</b>
              <span>
                {owner
                  ? tx(
                      "HRA claims over ₹1 lakh a year need it. Add your PAN in Settings and it prints on every statement.",
                    )
                  : tx("HRA claims over ₹1 lakh a year need your landlord's PAN. Ask them to add it in pOS.")}
              </span>
            </div>
          </div>
        </Section>
      )}
      <Section footer="Opens the share sheet on your phone, or downloads the PDF on a computer.">
        <PdfButton
          path={path}
          filename={data.filename}
          title={tx("Rent statement · {periodLabel}", { periodLabel: data.periodLabel })}
          label="Share statement (PDF)"
          className="btn md"
        />
      </Section>
      {data.months.length > 0 && (
        <Section title="Month by month">
          <div className="list">
            {data.months.map((m) => (
              <div className="row" key={m.month}>
                <span className="grow">
                  <span className="title" style={{ display: "block" }}>
                    {monthLabel(m.month, true)}
                  </span>
                  <span className="sub" style={{ display: "block" }}>
                    {tx("Rent {amount}{value}{value2}", {
                      amount: rupees(m.rent),
                      value: m.utilities ? ` · bills ${rupees(m.utilities)}` : "",
                      value2: m.fees ? ` · late fee ${rupees(m.fees)}` : "",
                    })}
                  </span>
                </span>
                <span className="end">
                  <span className="value">
                    {m.balance ? tx("{amount} due", { amount: rupees(m.balance) }) : tx("Paid")}
                  </span>
                </span>
              </div>
            ))}
          </div>
        </Section>
      )}
    </>
  );
}
