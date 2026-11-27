import { useApi } from "../../lib/api";
import { useAuth } from "../../lib/auth";
import { dateLabel, ordinal, phoneLabel, rupees } from "../../lib/format";
import { telLink, whatsappLink } from "../../lib/links";
import type { TenantHome } from "../../lib/types";
import { Avatar, ErrorState, Page, Row, Section, SkeletonPage } from "../../components/kit";
import { I } from "../../components/icons";
import { TenantAgreements } from "../tools/TenantDocs";
import { useT } from "../../lib/i18n";

export default function Profile() {
  const tx = useT();
  const { me } = useAuth();
  const { data, error, loading, reload } = useApi<TenantHome>("/api/tenant/home");

  if (loading)
    return (
      <Page title="Profile">
        <SkeletonPage />
      </Page>
    );
  if (error || !data)
    return (
      <Page title="Profile">
        <ErrorState error={error ?? { message: "Couldn't load your profile." }} retry={reload} />
      </Page>
    );

  const t = data.tenant;
  const tn = data.tenancy;
  const name = t?.fullName || me?.profile?.fullName || "You";
  const ownerName = data.payee.name || me?.ownerName || "Owner";

  return (
    <Page title="Profile" hideLarge>
      <div className="center-text" style={{ padding: "8px 20px 24px" }}>
        <div style={{ display: "inline-block" }}>
          <Avatar name={name} size="lg" />
        </div>
        <h1 className="t-title1" style={{ margin: "12px 0 0" }}>
          {name}
        </h1>
        <div className="t-sub c2" style={{ marginTop: 2 }}>
          {[data.unit?.label, data.property?.name].filter(Boolean).join(" · ") || tx("Tenant")}
        </div>
      </div>

      <Section title="Your details" footer="To change these, ask your owner. They keep your tenant record up to date.">
        <div className="list">
          <Row title="Phone" value={t?.phone ? phoneLabel(t.phone) : "—"} />
          <Row
            title="Email"
            value={
              <span className="ellipsis" style={{ maxWidth: 200, display: "inline-block", verticalAlign: "bottom" }}>
                {t?.email || me?.user.email || "—"}
              </span>
            }
          />
          <Row title="Emergency contact" sub={t?.emergencyContact || tx("Not added")} />
          <Row title="Moved in" value={t?.moveInDate ? dateLabel(t.moveInDate, true) : "—"} />
        </div>
      </Section>

      {tn && (
        <Section title="Tenancy">
          <div className="list">
            <Row
              title={data.unit?.label ?? tx("Unit")}
              sub={data.property?.address || data.property?.name}
              value={data.unit?.type}
            />
            <Row title="Monthly rent" value={<span className="num">{rupees(tn.rent)}</span>} />
            <Row title="Due day" value={`${ordinal(tn.dueDay)} of each month`} />
            <Row title="Deposit" value={<span className="num">{rupees(tn.deposit)}</span>} />
            <Row title="Started" value={dateLabel(tn.startDate, true)} />
            <Row title="Ends" value={tn.endDate ? dateLabel(tn.endDate, true) : "Ongoing"} />
          </div>
        </Section>
      )}

      <TenantAgreements />

      <Section title="Owner">
        <div className="list">
          <Row
            avatar={ownerName}
            title={ownerName}
            sub={data.payee.upiId ? tx("UPI {upiId}", { upiId: data.payee.upiId }) : tx("Owner")}
            end={
              data.payee.phone ? (
                <span className="hstack">
                  <a
                    className="circle-btn plain"
                    href={whatsappLink(data.payee.phone, `Hi ${ownerName.split(" ")[0]}, `)}
                    target="_blank"
                    rel="noopener noreferrer"
                    aria-label={tx("WhatsApp {ownerName}", { ownerName })}
                    style={{ color: "var(--accent)" }}
                  >
                    <I.chat />
                  </a>
                  <a
                    className="circle-btn plain"
                    href={telLink(data.payee.phone)}
                    aria-label={tx("Call {ownerName}", { ownerName })}
                    style={{ color: "var(--accent)" }}
                  >
                    <I.phone />
                  </a>
                </span>
              ) : undefined
            }
          />
        </div>
      </Section>

      <Section>
        <div className="list icons">
          {tn && (
            <Row
              icon="key"
              iconBg="var(--indigo, #5856d6)"
              title="Lease"
              sub="Terms, renewals and move-out"
              to="/lease"
              chevron
            />
          )}
          <Row
            icon="receipt"
            iconBg="var(--green)"
            title="Rent statements"
            sub="Monthly, yearly or FY statement for HRA"
            to="/statements"
            chevron
          />
          <Row icon="gear" iconBg="var(--label-2)" title="Settings & sign out" to="/settings" chevron />
        </div>
      </Section>
    </Page>
  );
}
