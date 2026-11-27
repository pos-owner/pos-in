import { useState } from "react";
import { ApiError, sharePdf, useApi } from "../../lib/api";
import { dateLabel } from "../../lib/format";
import { features } from "../../lib/features";
import type { TenantDocuments } from "../../lib/types";
import { Row, Section, Spinner, useToast } from "../../components/kit";
import { I } from "../../components/icons";
import { useT } from "../../lib/i18n";

/* Tenant-side receipts and agreements. Kept apart from the owner's Documents screen so tenants load less code. */

export const receiptPath = (paymentId: number) => `/api/payments/${paymentId}/receipt.json`;
export const agreementPath = (tenancyId: number) => `/api/tenancies/${tenancyId}/agreement.json`;

/** The tenant's issued receipts and shared agreements (null key when the feature is off). */
export function useTenantDocuments() {
  return useApi<TenantDocuments>(features.receipts ? "/api/tenant/documents" : null);
}

/** Opens the phone's share sheet with the PDF, or downloads it where sharing files isn't supported. */
export function PdfButton({
  path,
  filename,
  title,
  label,
  className = "btn gray md",
}: {
  path: string;
  filename: string;
  title: string;
  label: string;
  className?: string;
}) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  return (
    <button
      type="button"
      className={className}
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        try {
          const r = await sharePdf(path, filename, title);
          if (r === "downloaded") toast("PDF downloaded");
        } catch (e) {
          toast(e instanceof ApiError ? e.message : "Couldn't open the PDF.", "alert");
        } finally {
          setBusy(false);
        }
      }}
    >
      {busy ? (
        <Spinner />
      ) : (
        <>
          <I.receipt /> {label}
        </>
      )}
    </button>
  );
}

/** Profile tab: rental agreements the owner has created for this tenant. */
export function TenantAgreements() {
  const t = useT();
  const docs = useTenantDocuments();
  if (!features.receipts || !docs.data) return null;
  const { agreements, receipts } = docs.data;
  return (
    <Section
      title="Documents"
      footer={
        receipts.length
          ? t("Rent receipts ({n}) are in the History tab, under each month.", { n: receipts.length })
          : t("Rent receipts appear in the History tab once your owner confirms a payment.")
      }
    >
      {agreements.length ? (
        <div className="list icons">
          {agreements.map((a) => (
            <Row
              key={a.id}
              icon="key"
              iconBg="var(--indigo)"
              title="Rental agreement"
              sub={`${a.number} · ${dateLabel(a.createdAt.slice(0, 10), true)}`}
              end={
                <PdfButton
                  path={agreementPath(a.tenancyId)}
                  filename={`Rental-agreement-${a.number}.pdf`}
                  title="Rental agreement"
                  label="Open"
                  className="pill-btn"
                />
              }
            />
          ))}
        </div>
      ) : (
        <div className="card tight t-sub c2 center-text">{t("Your owner hasn't shared a rental agreement yet.")}</div>
      )}
    </Section>
  );
}
