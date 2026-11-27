import { LockedPreview } from "./LockedPreview";
import { useT } from "../../../lib/i18n";

export default function Meters() {
  const t = useT();
  return (
    <LockedPreview
      flag="meterReadings"
      title="Meter readings"
      icon="gauge"
      tone="var(--orange)"
      action="Scan a meter"
      summary="Take a photo of the electricity or water meter. pOS reads the number from the photo, works out the units used since last month and adds the bill to the tenant's rent."
      points={[
        "Reads the meter number from a photo, and you can correct it",
        "Keeps every reading with its photo as proof",
        "Works out units used and the bill at your rate per unit",
        "Adds the bill to the month's rent charge automatically",
      ]}
    >
      <div className="meter-face">
        <div className="t-foot" style={{ opacity: 0.7 }}>
          {t("Ground floor · Electricity")}
        </div>
        <div className="digits mt8">
          0421<b>7</b>.6
        </div>
        <div className="scan" />
        <div className="t-foot mt8" style={{ opacity: 0.7 }}>
          {t("Read from photo · 98% sure")}
        </div>
      </div>
      <div className="list mt12">
        <div className="row">
          <span className="grow title">{t("Last month")}</span>
          <span className="value num">{t("4,031.2 kWh")}</span>
        </div>
        <div className="row">
          <span className="grow title">{t("This month")}</span>
          <span className="value num">{t("4,217.6 kWh")}</span>
        </div>
        <div className="row">
          <span className="grow title">{t("Units used")}</span>
          <span className="value num">186.4</span>
        </div>
        <div className="row">
          <span className="grow title">{t("Rate")}</span>
          <span className="value num">{t("₹8 per unit")}</span>
        </div>
        <div className="row">
          <span className="grow title w6">{t("Electricity bill")}</span>
          <span className="value num w6" style={{ color: "var(--label)" }}>
            ₹1,491
          </span>
        </div>
      </div>
    </LockedPreview>
  );
}
