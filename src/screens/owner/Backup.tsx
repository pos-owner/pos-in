import { useState } from "react";
import { api, ApiError } from "../../lib/api";
import { buildCsv, EXPORTS, saveText, type BackupDoc, type ExportKind } from "../../lib/export";
import { dateLabel } from "../../lib/format";
import { Page, Row, Section, Spinner, useToast } from "../../components/kit";
import { I } from "../../components/icons";
import { useT } from "../../lib/i18n";

/*
 * Exports (CSV) and the workspace backup (JSON), owner only. Route: /more/backup
 * Everything comes from one read of `GET /api/backup.json`, kept for the visit, so each CSV after the first is
 * instant and works even if the connection drops.
 */

export default function Backup() {
  const t = useT();
  const toast = useToast();
  const [doc, setDoc] = useState<BackupDoc | null>(null);
  const [busy, setBusy] = useState<"" | "backup" | ExportKind>("");

  async function load(): Promise<BackupDoc> {
    if (doc) return doc;
    const d = await api<BackupDoc>("/api/backup.json");
    setDoc(d);
    return d;
  }

  async function run(what: "backup" | ExportKind) {
    setBusy(what);
    try {
      const d = await load();
      if (what === "backup") {
        await saveText(JSON.stringify(d, null, 1), `pOS-backup-${d.exportedOn}.json`, "application/json");
        toast("Backup downloaded");
      } else {
        const { csv, filename } = buildCsv(d, what);
        const r = await saveText(csv, filename, "text/csv", true);
        if (r === "downloaded") toast("CSV downloaded");
      }
    } catch (e) {
      toast(e instanceof ApiError ? e.message : "Couldn't prepare the file. Try again.", "alert");
    } finally {
      setBusy("");
    }
  }

  return (
    <Page title="Export & backup" back tabs={false}>
      <Section
        title="Backup"
        footer={
          doc
            ? t("Last read {date}: {n} properties, {n2} tenants, {n3} payments, {n4} expenses.", {
                date: dateLabel(doc.exportedOn, true),
                n: doc.properties.length,
                n2: doc.tenants.length,
                n3: doc.payments.length,
                n4: doc.expenses.length,
              })
            : t(
                "One file with everything in your account: properties, tenants, leases, rent, payments, receipts, expenses, requests, meter readings and settlements. It doesn't include passwords or photos.",
              )
        }
      >
        <div className="list icons">
          <Row
            icon="lock"
            iconBg="var(--accent)"
            title="Download full backup"
            sub="JSON file · keep it somewhere private"
            onClick={() => !busy && run("backup")}
            end={busy === "backup" ? <Spinner size={18} /> : <I.chevR className="chev" />}
          />
        </div>
      </Section>

      <Section
        title="Export to a spreadsheet"
        footer="CSV files open in Excel, Google Sheets or your accountant's software. Amounts are in rupees."
      >
        <div className="list icons">
          {EXPORTS.map((x) => (
            <Row
              key={x.kind}
              icon="share"
              iconBg="var(--green)"
              title={x.title}
              sub={doc ? t("{n} rows · {sub}", { n: x.count(doc), sub: x.sub }) : x.sub}
              onClick={() => !busy && run(x.kind)}
              end={busy === x.kind ? <Spinner size={18} /> : <I.chevR className="chev" />}
            />
          ))}
        </div>
      </Section>

      <Section>
        <div className="banner blue">
          <I.alert />
          <div className="grow">
            <b>{t("These files hold personal details")}</b>
            <span>
              {t(
                "Tenants' phone numbers, PANs and payment references are inside. Share them only with people you trust, like your CA.",
              )}
            </span>
          </div>
        </div>
      </Section>
    </Page>
  );
}
