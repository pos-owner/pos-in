import { Icon, type IconName } from "../../../components/icons";
import { LockedPreview } from "./LockedPreview";
import { useT } from "../../../lib/i18n";

const STEPS: { icon: IconName; bg: string; title: string; sub: string }[] = [
  { icon: "gauge", bg: "var(--orange)", title: "Meter reading saved", sub: "Staff scans the meter on the 1st" },
  { icon: "rupee", bg: "var(--green)", title: "Bill added to rent", sub: "186 units × ₹8 = ₹1,491" },
  { icon: "chat", bg: "#25d366", title: "Tenant reminded", sub: "WhatsApp message 2 days before the due date" },
  { icon: "receipt", bg: "var(--teal)", title: "Receipt sent", sub: "PDF goes out as soon as you confirm payment" },
];

export default function Automations() {
  const t = useT();
  return (
    <LockedPreview
      flag="automations"
      title="Automations"
      icon="bolt"
      tone="var(--purple)"
      action="Create automation"
      summary="Connect the steps you repeat every month. A meter reading becomes a bill, the bill joins the rent, a reminder goes out, and a receipt follows the payment."
      points={[
        "Ready-made monthly flows you switch on with one tap",
        "Reminders before and after the due date, on your schedule",
        "Receipts sent automatically when you confirm a payment",
        "A log of everything that ran, so nothing happens silently",
      ]}
    >
      <div className="card">
        <div className="between mb8">
          <span className="t-headline">{t("Monthly rent cycle")}</span>
          <span className="switch" aria-hidden="true">
            <input type="checkbox" checked readOnly tabIndex={-1} />
            <span />
          </span>
        </div>
        <div className="flow mt8">
          {STEPS.map((s, i) => (
            <div key={s.title}>
              {i > 0 && <div className="flow-link" />}
              <div className="flow-step">
                <span className="icon-sq" style={{ background: s.bg }}>
                  <Icon name={s.icon} />
                </span>
                <span>
                  <span className="t-callout w6" style={{ display: "block" }}>
                    {s.title}
                  </span>
                  <span className="t-foot c2" style={{ display: "block" }}>
                    {s.sub}
                  </span>
                </span>
              </div>
            </div>
          ))}
        </div>
      </div>
    </LockedPreview>
  );
}
