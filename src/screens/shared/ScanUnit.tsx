import { useParams } from "react-router-dom";
import { useApi } from "../../lib/api";
import { useAuth } from "../../lib/auth";
import { dateLabel } from "../../lib/format";
import { features } from "../../lib/features";
import type { ScanResponse } from "../../lib/types";
import {
  Empty,
  ErrorState,
  Page,
  PRIORITY_TEXT,
  priorityLabel,
  Row,
  Section,
  SkeletonPage,
  StatusPill,
} from "../../components/kit";
import { I } from "../../components/icons";
import { useT } from "../../lib/i18n";

/*
 * Landing page for a scanned unit QR code. Route: /u/:code
 * What it shows depends on who scanned it: owner and staff see the tenant, open requests and the last meter
 * readings, with shortcuts to log a reading or a request; the tenant who lives there can report a problem; anyone
 * else signed in learns only which unit it is. Signed out, it asks the person to sign in first.
 */

const METER: Record<string, string> = { electricity: "Electricity", water: "Water" };

export default function ScanUnit() {
  const t = useT();
  const { code = "" } = useParams();
  const { status, me } = useAuth();
  const signedIn = status === "ready" && !!me?.profile;
  const { data, error, loading, reload } = useApi<ScanResponse>(signedIn ? `/api/u/${encodeURIComponent(code)}` : null);

  if (!signedIn)
    return (
      <Page title="Unit" tabs={false}>
        <Empty
          icon="qr"
          title="Sign in to open this unit"
          text="This code belongs to a unit managed in pOS. Sign in with the account your owner invited you to, then scan it again."
          action={
            <a className="btn md auto" href="/">
              {t("Sign in")}
            </a>
          }
        />
      </Page>
    );

  if (loading)
    return (
      <Page title="Unit" back tabs={false}>
        <SkeletonPage variant="detail" />
      </Page>
    );
  if (error || !data)
    return (
      <Page title="Unit" back tabs={false}>
        {error?.status === 404 ? (
          <Empty icon="qr" title="Not one of your units" text={error.message} />
        ) : (
          <ErrorState error={error ?? { message: "Couldn't open this unit." }} retry={reload} />
        )}
      </Page>
    );

  const team = data.role === "owner" || data.role === "staff";
  const { unit, tenancy } = data;
  const canReport = team || data.mine;
  const metersPath = data.role === "owner" ? "/more/meters" : "/meters";
  const reportPath = `/requests?new=1${team ? `&unit=${unit.id}` : ""}`;

  return (
    <Page title={unit.label} eyebrow={unit.propertyName} back tabs={false}>
      <Section>
        <div className="list icons">
          <Row
            icon="building"
            title={`${unit.label}${unit.type ? ` · ${unit.type}` : ""}`}
            sub={unit.address || unit.propertyName}
          />
          {team &&
            (tenancy ? (
              <Row
                avatar={tenancy.tenantName}
                title={tenancy.tenantName}
                sub={
                  tenancy.endDate
                    ? t("Lease ends {date}", { date: dateLabel(tenancy.endDate, true) })
                    : t("Current tenant")
                }
                to={`/tenants/${tenancy.tenantId}`}
                chevron
              />
            ) : (
              <Row icon="key" iconBg="var(--label-2)" title="Vacant" sub="No one lives here right now" />
            ))}
          {data.mine && <Row icon="home" iconBg="var(--green)" title="Your home" sub="You rent this unit" />}
        </div>
      </Section>

      {canReport || team ? (
        <Section title="Quick actions">
          <div className="list icons">
            {canReport && (
              <Row
                icon="wrench"
                iconBg="var(--orange)"
                title="Report a problem"
                sub="Leak, power, appliance…"
                to={reportPath}
                chevron
              />
            )}
            {team && features.meterReadings && (
              <Row icon="gauge" title="Log a meter reading" to={`${metersPath}?unit=${unit.id}`} chevron />
            )}
            {data.role === "owner" && tenancy && (
              <Row
                icon="rupee"
                iconBg="var(--green)"
                title="Rent and payments"
                to={`/tenants/${tenancy.tenantId}`}
                chevron
              />
            )}
          </div>
        </Section>
      ) : (
        <Section>
          <div className="banner blue">
            <I.lock />
            <div className="grow">
              <b>{t("Nothing more to show")}</b>
              <span>
                {t("Details of this unit are only for its owner, their staff and the tenant who lives here.")}
              </span>
            </div>
          </div>
        </Section>
      )}

      {(team || data.mine) && (
        <Section title="Open requests">
          {data.openRequests.length ? (
            <div className="list">
              {data.openRequests.map((r) => (
                <Row
                  key={r.id}
                  title={r.title}
                  sub={<span style={{ color: PRIORITY_TEXT[r.priority] }}>{priorityLabel(r.priority, true)}</span>}
                  end={<StatusPill status={r.status} />}
                  to={`/requests/${r.id}`}
                  chevron
                />
              ))}
            </div>
          ) : (
            <div className="card tight t-sub c2 center-text">{t("No open requests for this unit.")}</div>
          )}
        </Section>
      )}

      {team && data.lastReadings.length > 0 && (
        <Section title="Last meter readings">
          <div className="list">
            {data.lastReadings.map((r) => (
              <Row
                key={r.kind}
                title={METER[r.kind] ?? r.kind}
                sub={r.readOn ? dateLabel(r.readOn, true) : undefined}
                value={<span className="num">{r.reading ?? "—"}</span>}
              />
            ))}
          </div>
        </Section>
      )}
    </Page>
  );
}
