import { useState } from "react";
import { useApi } from "../../lib/api";
import type { QrResponse } from "../../lib/types";
import { Empty, ErrorState, NavButton, Page, QR, Section, SkeletonPage } from "../../components/kit";
import { useT } from "../../lib/i18n";

/*
 * Printable smart QR codes, one per unit. Route: /more/qr
 * Each code opens /u/<code>, which shows whoever scans it the right thing: the owner and staff get the unit's tenant,
 * open requests and meter readings; the tenant living there can report a problem; anyone else learns nothing. Codes
 * are signed by the server, so one printed code can't be used to guess another unit's.
 */

export const unitLink = (code: string) => `${location.origin}/u/${code}`;

export default function QrCodes() {
  const t = useT();
  const { data, error, loading, reload } = useApi<QrResponse>("/api/qr");
  const [property, setProperty] = useState<string>("");

  const title = "QR codes";
  if (loading)
    return (
      <Page title={title} back tabs={false}>
        <SkeletonPage variant="list" />
      </Page>
    );
  if (error || !data)
    return (
      <Page title={title} back tabs={false}>
        <ErrorState error={error ?? { message: "Couldn't load the QR codes." }} retry={reload} />
      </Page>
    );

  const properties = [...new Set(data.units.map((u) => u.propertyName))];
  const shown = data.units.filter((u) => !property || u.propertyName === property);
  const print = data.units.length ? (
    <NavButton icon="share" label="Print" accent onClick={() => window.print()} />
  ) : undefined;

  return (
    <Page title={title} back tabs={false} right={print}>
      {!data.units.length ? (
        <Empty
          icon="qr"
          title="No units yet"
          text="Add a property and its units, then print a code for each door or meter board."
        />
      ) : (
        <>
          <Section footer="Stick a code on each door or meter board. Scanning it opens that unit in pOS: you and your staff see the tenant, open requests and the last meter readings; the tenant who lives there can report a problem. Anyone else sees nothing.">
            {properties.length > 1 && (
              <div className="chips no-print" role="group" aria-label={t("Property")}>
                <button className="chip" aria-pressed={!property} onClick={() => setProperty("")}>
                  {t("All")}
                </button>
                {properties.map((p) => (
                  <button key={p} className="chip" aria-pressed={property === p} onClick={() => setProperty(p)}>
                    {p}
                  </button>
                ))}
              </div>
            )}
          </Section>
          <Section>
            <div className="qr-grid">
              {shown.map((u) => (
                <div className="qr-card" key={u.unitId}>
                  <QR text={unitLink(u.code)} label={t("QR code for {label}", { label: u.label })} />
                  <div className="title" style={{ fontWeight: 700 }}>
                    {u.label}
                  </div>
                  <div className="t-sub c2">{u.propertyName}</div>
                  <div className="t-sub c2 no-print">{u.tenantName || t("Vacant")}</div>
                </div>
              ))}
            </div>
          </Section>
        </>
      )}
    </Page>
  );
}
