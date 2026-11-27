import { I } from "../../../components/icons";
import { LockedPreview } from "./LockedPreview";
import { useT } from "../../../lib/i18n";

export default function Receipts() {
  const t = useT();
  return (
    <LockedPreview
      flag="receipts"
      title="Receipts & agreements"
      icon="receipt"
      tone="var(--teal)"
      action="Generate receipt"
      summary="Every confirmed payment becomes a clean PDF rent receipt, and rental agreements are filled in from the tenancy details, ready to share on WhatsApp."
      points={[
        "A numbered PDF receipt for every confirmed payment, cash, bank or UPI",
        "Rent receipts tenants can download for HRA claims",
        "Rental agreements filled in from unit, rent, deposit and dates",
        "Share by WhatsApp or download, all stored privately",
      ]}
    >
      <div className="receipt">
        <div className="between">
          <div>
            <div className="t-headline">{t("Rent receipt")}</div>
            <div className="t-foot c2">{t("No. R-2026-11-004")}</div>
          </div>
          <span className="pill green">{t("Paid")}</span>
        </div>
        <hr />
        <div className="rc-line">
          <span>{t("Received from")}</span>
          <span>{t("Ananya Raghavan")}</span>
        </div>
        <div className="rc-line">
          <span>{t("Property")}</span>
          <span>{t("Lakshmi Nilaya, Ground floor")}</span>
        </div>
        <div className="rc-line">
          <span>{t("Period")}</span>
          <span>{t("November 2026")}</span>
        </div>
        <div className="rc-line">
          <span>{t("Paid by")}</span>
          <span>{t("UPI · UTR 533120984467")}</span>
        </div>
        <hr />
        <div className="rc-line">
          <span className="w6" style={{ color: "var(--label)" }}>
            {t("Amount")}
          </span>
          <span className="amount-sm">₹26,500</span>
        </div>
        <div className="t-foot c2 mt8">{t("Rupees twenty-six thousand five hundred only. Received with thanks.")}</div>
      </div>
      <div className="list mt12">
        <div className="row">
          <span className="icon-sq" style={{ background: "var(--indigo)" }}>
            <I.receipt />
          </span>
          <span className="grow">
            <span className="title" style={{ display: "block" }}>
              {t("Rental agreement · 11 months")}
            </span>
            <span className="sub" style={{ display: "block" }}>
              {t("Farhan Qureshi · First floor")}
            </span>
          </span>
          <span className="pill gray">{t("Draft")}</span>
        </div>
      </div>
    </LockedPreview>
  );
}
