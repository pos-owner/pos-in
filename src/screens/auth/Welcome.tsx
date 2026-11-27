import { useEffect } from "react";
import { useAuth } from "../../lib/auth";
import { Icon, type IconName } from "../../components/icons";
import AuthForm from "./AuthForm";
import "../../styles/auth.css";
import { useT } from "../../lib/i18n";

const PERKS: { icon: IconName; bg: string; title: string; text: string }[] = [
  {
    icon: "rupee",
    bg: "var(--green)",
    title: "Rent that tracks itself",
    text: "Monthly charges, part payments and overdue alerts, without a spreadsheet.",
  },
  {
    icon: "qr",
    bg: "var(--accent)",
    title: "UPI in one tap",
    text: "Tenants pay from any UPI app. You confirm it, and the ledger updates.",
  },
  {
    icon: "wrench",
    bg: "var(--orange)",
    title: "Repairs with photos",
    text: "Tenants report problems. Your caretaker updates them as work happens.",
  },
];

export default function Welcome() {
  const t = useT();
  const { notice } = useAuth();
  useEffect(() => {
    document.title = "pOS · Rent, tenants and requests";
  }, []);
  return (
    <main className="welcome page fade" style={{ paddingTop: "calc(var(--safe-t) + 36px)" }}>
      <div className="welcome-hero">
        <img
          className="welcome-art"
          src="/img/welcome-hero.svg"
          alt={t("An apartment building beside a phone showing rent paid by UPI")}
          width={640}
          height={440}
          fetchPriority="high"
        />
        <img className="app-icon" src="/icons/icon.svg" alt="" width={64} height={64} />
        <h1 className="wordmark">
          p<i>{t("OS")}</i>
        </h1>
        <p className="t-callout c2">{t("Your rental properties, rent and tenants, all in one calm place.")}</p>
      </div>
      <div className="perks">
        {PERKS.map((p) => (
          <div className="perk" key={p.title}>
            <span className="icon-sq" style={{ background: p.bg }}>
              <Icon name={p.icon} />
            </span>
            <div>
              <b>{p.title}</b>
              <span>{p.text}</span>
            </div>
          </div>
        ))}
      </div>
      {notice && (
        <div className="banner blue notice" role="status">
          <span className="grow" style={{ fontSize: 15 }}>
            {notice}
          </span>
        </div>
      )}
      <AuthForm />
      <p className="legal">{t("Tenants and staff: open the invite link the owner sent you, then enter your PIN.")}</p>
    </main>
  );
}
