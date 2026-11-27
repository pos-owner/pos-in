import { useMemo, useState } from "react";
import { api, ApiError, downloadPdf, invalidate, openPdf, sharePdf, useApi } from "../../lib/api";
import { dateLabel, monthLabel, rupees } from "../../lib/format";
import { whatsappLink } from "../../lib/links";
import type { AgreementItem, ReceiptItem } from "../../lib/types";
import {
  Avatar,
  Empty,
  ErrorState,
  Page,
  Row,
  Section,
  Segmented,
  Sheet,
  Skeleton,
  Spinner,
  useToast,
} from "../../components/kit";
import { I } from "../../components/icons";
import { METHOD } from "../tenant/History";
import { agreementPath, receiptPath } from "./TenantDocs";
import "../../styles/ops.css";
import "../../styles/owner.css";
import "../../styles/tools.css";
import { useT } from "../../lib/i18n";

type Doc = { kind: "receipt"; r: ReceiptItem } | { kind: "agreement"; a: AgreementItem };

/** Owner: every receipt issued, and a rental agreement for each active tenancy. */
export default function Documents() {
  const t = useT();
  const [tab, setTab] = useState<"receipts" | "agreements">("receipts");
  const receipts = useApi<ReceiptItem[]>("/api/receipts");
  const agreements = useApi<AgreementItem[]>("/api/agreements");
  const [open, setOpen] = useState<Doc | null>(null);
  const [q, setQ] = useState("");

  const shown = useMemo(() => {
    const s = q.trim().toLowerCase();
    return (receipts.data ?? []).filter(
      (r) => !s || [r.number, r.tenantName, r.unitLabel].some((x) => x.toLowerCase().includes(s)),
    );
  }, [receipts.data, q]);
  const thisMonth = (receipts.data ?? []).filter((r) => r.paidOn.slice(0, 7) === new Date().toISOString().slice(0, 7));

  return (
    <Page title="Receipts & agreements" back="/more" tabs={false}>
      <div className="pad mb16">
        <Segmented
          label="Documents"
          value={tab}
          onChange={setTab}
          options={[
            { value: "receipts", label: "Receipts" },
            { value: "agreements", label: "Agreements" },
          ]}
        />
      </div>

      {tab === "receipts" ? (
        receipts.loading ? (
          <Section>
            <Skeleton rows={4} />
          </Section>
        ) : receipts.error ? (
          <ErrorState error={receipts.error} retry={receipts.reload} />
        ) : !receipts.data?.length ? (
          <Empty
            icon="receipt"
            title="No receipts yet"
            text="A numbered PDF receipt is issued every time you confirm or record a payment. You can also issue one from any payment in the Rent tab."
          />
        ) : (
          <>
            <Section>
              <div className="stats">
                <div className="stat">
                  <div className="k">{t("Issued")}</div>
                  <div className="v">{receipts.data.length}</div>
                </div>
                <div className="stat">
                  <div className="k">{t("This month")}</div>
                  <div className="v">{rupees(thisMonth.reduce((s, r) => s + r.amount, 0))}</div>
                </div>
              </div>
            </Section>
            {receipts.data.length > 5 && (
              <div className="pad mb16">
                <label className="search">
                  <I.search />
                  <input
                    type="search"
                    value={q}
                    onChange={(e) => setQ(e.target.value)}
                    placeholder={t("Search by tenant, unit or number")}
                    aria-label={t("Search receipts")}
                  />
                </label>
              </div>
            )}
            <Section title="Recent" footer="Tenants see their receipts in the History tab of their app.">
              {shown.length ? (
                <div className="list">
                  {shown.map((r) => (
                    <Row
                      key={r.id}
                      avatar={r.tenantName}
                      title={r.tenantName}
                      sub={`${r.number} · ${receiptSpan(r)} · ${METHOD[r.method]?.label ?? r.method}`}
                      end={
                        <span className="stack">
                          <span className="num w6">{rupees(r.amount)}</span>
                          <span className="t-foot c2">{dateLabel(r.paidOn)}</span>
                        </span>
                      }
                      chevron
                      onClick={() => setOpen({ kind: "receipt", r })}
                    />
                  ))}
                </div>
              ) : (
                <div className="card tight t-sub c2 center-text">{t("Nothing matches “{q}”.", { q })}</div>
              )}
            </Section>
          </>
        )
      ) : agreements.loading ? (
        <Section>
          <Skeleton rows={3} />
        </Section>
      ) : agreements.error ? (
        <ErrorState error={agreements.error} retry={agreements.reload} />
      ) : !agreements.data?.length ? (
        <Empty
          icon="key"
          title="No active tenancies"
          text="Add a tenant to a unit, and pOS fills in a rental agreement from the tenancy details."
        />
      ) : (
        <Section
          title="Active tenancies"
          footer="Agreements are filled in from the unit, rent, deposit, due day and dates. Review, print on stamp paper and sign."
        >
          <div className="list">
            {agreements.data.map((a) => (
              <Row
                key={a.tenancyId}
                avatar={a.tenantName}
                title={a.tenantName}
                sub={`${a.unitLabel} · ${a.propertyName}`}
                end={
                  a.document ? (
                    <span className="pill green">{a.document.number}</span>
                  ) : (
                    <span className="pill gray">{t("Not created")}</span>
                  )
                }
                chevron
                onClick={() => setOpen({ kind: "agreement", a })}
              />
            ))}
          </div>
        </Section>
      )}

      <DocSheet doc={open} onClose={() => setOpen(null)} />
    </Page>
  );
}

function DocSheet({ doc, onClose }: { doc: Doc | null; onClose: () => void }) {
  const t = useT();
  const [last, setLast] = useState<Doc | null>(doc);
  if (doc && doc !== last) setLast(doc);
  const d = doc ?? last;
  return (
    <Sheet open={!!doc} onClose={onClose} title={d?.kind === "agreement" ? t("Rental agreement") : t("Rent receipt")}>
      {d?.kind === "receipt" && <ReceiptActions r={d.r} />}
      {d?.kind === "agreement" && <AgreementActions a={d.a} />}
    </Sheet>
  );
}

/** Share / download / open buttons for a PDF. */
function PdfActions({
  path,
  filename,
  title,
  phone,
  waText,
  onBeforeOpen,
}: {
  path: string;
  filename: string;
  title: string;
  phone?: string;
  waText?: string;
  onBeforeOpen?: () => Promise<void>;
}) {
  const t = useT();
  const toast = useToast();
  const [busy, setBusy] = useState("");
  async function run(tag: string, fn: () => Promise<unknown>) {
    setBusy(tag);
    try {
      await onBeforeOpen?.();
      await fn();
    } catch (e) {
      toast(e instanceof ApiError ? e.message : "Couldn't prepare the PDF.", "alert");
    } finally {
      setBusy("");
    }
  }
  return (
    <div className="stack-8">
      <button
        className="btn"
        disabled={!!busy}
        onClick={() =>
          run("share", async () => {
            const r = await sharePdf(path, filename, title);
            if (r === "downloaded") toast("PDF downloaded");
          })
        }
      >
        {busy === "share" ? (
          <Spinner />
        ) : (
          <>
            <I.share /> {t("Share PDF")}
          </>
        )}
      </button>
      <div className="btn-row">
        <button
          className="btn gray md"
          disabled={!!busy}
          onClick={() =>
            run("dl", async () => {
              await downloadPdf(path, filename);
              toast("PDF downloaded");
            })
          }
        >
          {busy === "dl" ? (
            <Spinner />
          ) : (
            <>
              <I.inbox /> {t("Download")}
            </>
          )}
        </button>
        <button
          className="btn gray md"
          disabled={!!busy}
          onClick={() => {
            // Opened now, inside the tap, so the browser allows it; the PDF loads into it once fetched.
            const tab = window.open("", "_blank");
            if (tab) tab.opener = null;
            let opened = false;
            run("open", async () => {
              if ((await openPdf(path, filename, tab)) === "downloaded") toast("PDF downloaded");
              opened = true;
            }).finally(() => {
              if (!opened) tab?.close();
            });
          }}
        >
          {busy === "open" ? (
            <Spinner />
          ) : (
            <>
              <I.receipt /> {t("Open")}
            </>
          )}
        </button>
      </div>
      {phone && waText && (
        <a className="btn whatsapp md" href={whatsappLink(phone, waText)} target="_blank" rel="noopener noreferrer">
          <I.chat /> {t("Tell them on WhatsApp")}
        </a>
      )}
    </div>
  );
}

function ReceiptActions({ r }: { r: ReceiptItem }) {
  const t = useT();
  return (
    <>
      <div className="center-text" style={{ padding: "4px 20px 16px" }}>
        <div style={{ display: "inline-block" }}>
          <Avatar name={r.tenantName} />
        </div>
        <div className="t-headline mt8">{r.tenantName}</div>
        <div className="t-sub c2">
          {r.unitLabel} · {receiptSpan(r, true)}
        </div>
        <div className="amount-lg mt12">{rupees(r.amount)}</div>
        <div className="t-sub c2" style={{ marginTop: 4 }}>
          {r.number} · {METHOD[r.method]?.label ?? r.method} · {dateLabel(r.paidOn, true)}
        </div>
      </div>
      <Section>
        <PdfActions
          path={receiptPath(r.paymentId)}
          filename={`${r.number}.pdf`}
          title={t("Rent receipt {number}", { number: r.number })}
          phone={r.tenantPhone}
          waText={`Hi ${r.tenantName.split(/[\s&]/)[0]}, your rent receipt ${r.number} for ${receiptSpan(r, true)} (${rupees(r.amount)}) is ready in the pOS app under History. Thank you!`}
        />
      </Section>
    </>
  );
}

function AgreementActions({ a }: { a: AgreementItem }) {
  const t = useT();
  const [doc, setDoc] = useState(a.document);
  async function ensure() {
    if (doc) return;
    const d = await api<{ id: number; number: string }>(`/api/tenancies/${a.tenancyId}/agreement`, { method: "POST" });
    setDoc({ ...d, createdAt: new Date().toISOString() });
    invalidate("/api/agreements");
  }
  return (
    <>
      <div className="center-text" style={{ padding: "4px 20px 16px" }}>
        <div style={{ display: "inline-block" }}>
          <Avatar name={a.tenantName} />
        </div>
        <div className="t-headline mt8">{a.tenantName}</div>
        <div className="t-sub c2">
          {a.unitLabel} · {a.propertyName}
        </div>
      </div>
      <Section>
        <div className="list">
          <Row title="Monthly rent" value={<span className="num">{rupees(a.rent)}</span>} />
          <Row title="Starts" value={dateLabel(a.startDate, true)} />
          <Row title="Ends" value={a.endDate ? dateLabel(a.endDate, true) : "11 months from start"} />
          <Row title="Number" value={doc?.number ?? "Assigned when created"} />
        </div>
      </Section>
      <Section
        footer={
          doc
            ? t("Sharing makes it visible to the tenant in their Profile tab.")
            : t("Creating the agreement also makes it available to the tenant in their app.")
        }
      >
        <PdfActions
          path={agreementPath(a.tenancyId)}
          filename={`Rental-agreement-${a.unitLabel.replace(/\W+/g, "-")}.pdf`}
          title="Rental agreement"
          onBeforeOpen={ensure}
          phone={a.tenantPhone}
          waText={`Hi ${a.tenantName.split(/[\s&]/)[0]}, the rental agreement for ${a.unitLabel} is ready in the pOS app under Profile. Please review it and let me know a good time to sign.`}
        />
      </Section>
    </>
  );
}

/** "Nov 2026" or "Nov 2026 – Jan 2027" for a receipt that covers several months. */
function receiptSpan(r: { month: string; monthTo?: string | null }, long = false) {
  return r.monthTo ? `${monthLabel(r.month, long)} – ${monthLabel(r.monthTo, long)}` : monthLabel(r.month, long);
}
