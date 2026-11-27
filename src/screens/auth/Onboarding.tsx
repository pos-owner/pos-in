import { useState } from "react";
import { api } from "../../lib/api";
import { useAuth } from "../../lib/auth";
import { Field, FormError, Section, Spinner } from "../../components/kit";
import { I } from "../../components/icons";
import "../../styles/auth.css";
import { useT } from "../../lib/i18n";

/** First run for a new owner: name, UPI ID, and whether to start with demo data. */
export default function Onboarding() {
  const t = useT();
  const { me, refresh, signOut } = useAuth();
  const [fullName, setFullName] = useState(me?.user.name ?? "");
  const [phone, setPhone] = useState("");
  const [upiId, setUpiId] = useState("");
  const [seed, setSeed] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const submit = async () => {
    setError("");
    if (!fullName.trim()) return setError("Enter your name.");
    if (upiId && !/^[\w.-]{2,}@[a-zA-Z][\w.-]*$/.test(upiId.trim()))
      return setError("That UPI ID doesn't look right. It's usually like name@okhdfcbank.");
    setBusy(true);
    try {
      await api("/api/onboard", {
        body: { fullName: fullName.trim(), phone: phone.trim(), upiId: upiId.trim(), seed },
      });
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't set up your account.");
      setBusy(false);
    }
  };

  return (
    <main
      className="page fade no-tabs"
      style={{ paddingTop: "calc(var(--safe-t) + 28px)", maxWidth: 520, margin: "0 auto" }}
    >
      <div className="large-title">
        <div className="eyebrow">{t("Welcome to pOS")}</div>
        <h1 className="t-large" style={{ margin: 0 }}>
          {t("Set up your workspace")}
        </h1>
        <p className="t-sub c2" style={{ margin: "6px 0 0" }}>
          {t("You'll be the owner. You can invite tenants and a caretaker next.")}
        </p>
      </div>
      <Section title="About you" footer="Tenants pay rent to this UPI ID. You can change it any time in Settings.">
        <div className="list">
          <Field
            label="Name"
            value={fullName}
            onChange={setFullName}
            placeholder="Your full name"
            autoComplete="name"
          />
          <Field
            label="Phone"
            type="tel"
            inputMode="tel"
            value={phone}
            onChange={setPhone}
            placeholder="98450 12345"
            autoComplete="tel"
          />
          <Field label="UPI ID" value={upiId} onChange={setUpiId} placeholder="name@okhdfcbank" autoComplete="off" />
        </div>
      </Section>
      <Section title="How do you want to start?">
        <div className="stack-8">
          <button type="button" className="choice" aria-pressed={seed} onClick={() => setSeed(true)}>
            <span className="icon-sq" style={{ background: "var(--indigo)" }}>
              <I.sparkle />
            </span>
            <span className="grow">
              <b>{t("Explore with sample data")}</b>
              <span>
                {t(
                  "Two properties, six tenants, rent in every state and a few requests. Edit or delete anything later.",
                )}
              </span>
            </span>
            <span className="radio">{seed && <I.check />}</span>
          </button>
          <button type="button" className="choice" aria-pressed={!seed} onClick={() => setSeed(false)}>
            <span className="icon-sq" style={{ background: "var(--green)" }}>
              <I.building />
            </span>
            <span className="grow">
              <b>{t("Start empty")}</b>
              <span>{t("Add your own properties, units and tenants.")}</span>
            </span>
            <span className="radio">{!seed && <I.check />}</span>
          </button>
        </div>
      </Section>
      <FormError text={error} />
      <div className="pad mt16">
        <button className="btn" onClick={submit} disabled={busy}>
          {busy ? <Spinner /> : t("Continue")}
        </button>
        <button className="btn gray mt12" onClick={signOut} type="button">
          {t("Use a different account")}
        </button>
        <p className="legal">
          {t("Here to pay rent or help as staff? Open the invite link the owner sent you instead.")}
        </p>
      </div>
    </main>
  );
}
