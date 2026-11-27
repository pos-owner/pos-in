import { useState } from "react";
import { useAuth } from "../../../lib/auth";
import { api, ApiError } from "../../../lib/api";
import { getLocale, LOCALES, setLocale, useLocale, useT, type Locale } from "../../../lib/i18n";
import { Section, Segmented, useToast } from "../../../components/kit";

/**
 * App language. The switch applies at once on this phone and is saved to the account
 * (`PATCH /api/profile { locale }`), so the same language follows the person to another phone. If it can't be
 * saved (offline), the change is undone rather than left to be overwritten by the account's value on next launch.
 */
export default function LanguageSection() {
  const { me, refresh } = useAuth();
  const locale = useLocale();
  const t = useT();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  if (!me?.profile) return null;

  async function choose(next: Locale) {
    const before = getLocale();
    if (next === before || busy) return;
    setLocale(next);
    setBusy(true);
    try {
      await api("/api/profile", { method: "PATCH", body: { locale: next } });
      await refresh();
    } catch (e) {
      setLocale(before);
      toast(
        e instanceof ApiError && e.status === 0
          ? "You're offline. Try again when you're back online."
          : "Couldn't change the language. Try again.",
        "alert",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <Section
      title={t("Language")}
      footer={t("Screens, buttons and messages use this language. Receipts and statements stay in English.")}
    >
      <Segmented label={t("Language")} value={locale} onChange={choose} options={LOCALES} />
    </Section>
  );
}
