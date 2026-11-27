import { useState } from "react";
import { api, ApiError } from "../../lib/api";
import { loginKey } from "../../../shared/loginKey";
import { useAuth } from "../../lib/auth";
import { Field, FormError, Section, Spinner, useToast } from "../../components/kit";
import "../../styles/auth.css";
import { useT } from "../../lib/i18n";

/** Shown after opening a password-reset link: the person is signed in and must choose a new password. */
export default function ResetPassword() {
  const t = useT();
  const { clearRecovery, signedIn, recovery } = useAuth();
  const toast = useToast();
  const [pw, setPw] = useState("");
  const [pw2, setPw2] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const save = async () => {
    setError("");
    if (pw.length < 8) return setError("Use at least 8 characters.");
    if (pw !== pw2) return setError("The two passwords don't match.");
    setBusy(true);
    try {
      // The login key is salted with the account's email, which the reset link knows.
      const { email } = await api<{ email: string }>(`/api/auth/reset/${encodeURIComponent(recovery)}`);
      await api("/api/auth/reset", { body: { token: recovery, key: await loginKey(email, pw) } });
      toast("Password updated");
      clearRecovery();
      await signedIn();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Couldn't update your password. Try again.");
      setBusy(false);
    }
  };

  return (
    <main
      className="page fade no-tabs"
      style={{ paddingTop: "calc(var(--safe-t) + 28px)", maxWidth: 520, margin: "0 auto" }}
    >
      <div className="large-title">
        <h1 className="t-large" style={{ margin: 0 }}>
          {t("New password")}
        </h1>
        <p className="t-sub c2" style={{ margin: "6px 0 0" }}>
          {t("Choose a new password for your pOS account.")}
        </p>
      </div>
      <Section>
        <div className="list">
          <Field
            label="Password"
            type="password"
            value={pw}
            onChange={setPw}
            placeholder="8+ characters"
            autoComplete="new-password"
            autoFocus
          />
          <Field
            label="Confirm"
            type="password"
            value={pw2}
            onChange={setPw2}
            placeholder="Type it again"
            autoComplete="new-password"
          />
        </div>
      </Section>
      <FormError text={error} />
      <div className="pad mt8">
        <button className="btn" onClick={save} disabled={busy}>
          {busy ? <Spinner /> : t("Save password")}
        </button>
      </div>
    </main>
  );
}
