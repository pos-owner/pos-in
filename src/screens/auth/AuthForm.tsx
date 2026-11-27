import { useEffect, useState, type FormEvent } from "react";
import { useAuth } from "../../lib/auth";
import { api, ApiError } from "../../lib/api";
import { loginKey } from "../../../shared/loginKey";
import type { AuthConfig } from "../../lib/session";
import { Field, FormError, Segmented, Spinner } from "../../components/kit";
import { useT } from "../../lib/i18n";

type Mode = "signin" | "signup";

function message(e: unknown): string {
  if (e instanceof ApiError) return e.message || "Something went wrong. Please try again.";
  return "Couldn't reach pOS. Check your connection.";
}

/** Email + Google sign-in. Used on the welcome screen and when accepting an invite. */
export default function AuthForm({
  initialMode = "signin",
  defaultName = "",
  hint,
}: {
  initialMode?: Mode;
  defaultName?: string;
  hint?: string;
}) {
  const t = useT();
  const { signedIn } = useAuth();
  const [mode, setMode] = useState<Mode>(initialMode);
  const [name, setName] = useState(defaultName);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [info, setInfo] = useState("");
  const [cfg, setCfg] = useState<AuthConfig | null>(null);

  useEffect(() => {
    api<AuthConfig>("/api/auth/config")
      .then(setCfg)
      .catch(() => setCfg(null));
  }, []);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError("");
    setInfo("");
    if (!email.includes("@")) return setError("Enter your email address.");
    if (password.length < (mode === "signup" ? 8 : 1))
      return setError(mode === "signup" ? "Use a password with at least 8 characters." : "Enter your password.");
    if (mode === "signup" && !name.trim()) return setError("Enter your name.");
    setBusy(true);
    try {
      const invite = window.location.pathname.startsWith("/join/") ? window.location.pathname.split("/")[2] : "";
      // The password is stretched here, in the browser, so the server's share of the work stays tiny.
      const key = await loginKey(email, password);
      if (mode === "signin") await api("/api/auth/signin", { body: { email: email.trim(), key } });
      else await api("/api/auth/signup", { body: { email: email.trim(), key, name: name.trim(), invite } });
      await signedIn();
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(false);
    }
  };

  const forgot = async () => {
    setError("");
    if (!email.includes("@")) return setError("Enter your email above, then tap Forgot password.");
    try {
      await api("/api/auth/forgot", { body: { email: email.trim() } });
      setInfo("If that email has a pOS account, a reset link is on its way.");
    } catch (err) {
      setError(message(err));
    }
  };

  return (
    <form onSubmit={submit} noValidate className="stack-12">
      {hint && (
        <p className="t-sub c2 center-text" style={{ margin: "0 0 4px" }}>
          {hint}
        </p>
      )}
      <Segmented
        label="Sign in or create account"
        value={mode}
        onChange={(m) => {
          setMode(m);
          setError("");
          setInfo("");
        }}
        options={[
          { value: "signin", label: "Sign in" },
          { value: "signup", label: "Create account" },
        ]}
      />
      <div className="list">
        {mode === "signup" && (
          <Field label="Name" value={name} onChange={setName} placeholder="Your full name" autoComplete="name" />
        )}
        <Field
          label="Email"
          type="email"
          inputMode="email"
          value={email}
          onChange={setEmail}
          placeholder="you@example.com"
          autoComplete="email"
        />
        <Field
          label="Password"
          type="password"
          value={password}
          onChange={setPassword}
          placeholder={mode === "signup" ? t("8+ characters") : t("Required")}
          autoComplete={mode === "signup" ? "new-password" : "current-password"}
        />
      </div>
      <FormError text={error} />
      {info && (
        <div className="banner blue" role="status">
          <span className="grow" style={{ fontSize: 15 }}>
            {info}
          </span>
        </div>
      )}
      <button className="btn" type="submit" disabled={busy}>
        {busy ? <Spinner /> : mode === "signin" ? t("Sign in") : t("Create account")}
      </button>
      {mode === "signin" && cfg?.email && (
        <button
          type="button"
          className="t-sub c-accent"
          style={{ display: "block", margin: "14px auto 0", minHeight: 44 }}
          onClick={forgot}
        >
          {t("Forgot password?")}
        </button>
      )}
    </form>
  );
}
