import { useEffect, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { api, clearCache, useApi } from "../../lib/api";
import { useAuth } from "../../lib/auth";
import { clearPendingInvite, readPendingInvite, savePendingInvite } from "../../lib/invite";
import type { InviteInfo } from "../../lib/types";
import { Empty, FormError, Spinner } from "../../components/kit";
import { I } from "../../components/icons";
import AuthForm from "./AuthForm";
import "../../styles/auth.css";
import { useT } from "../../lib/i18n";

/** Invite link: check the PIN, sign in (or create an account), then claim the invite. */
export default function Join() {
  const t = useT();
  const { token = "" } = useParams();
  const nav = useNavigate();
  const { status, me, refresh, signOut } = useAuth();
  const info = useApi<InviteInfo>(`/api/invites/${encodeURIComponent(token)}/info`);
  const pending = readPendingInvite();
  const [pin, setPin] = useState(pending?.token === token ? pending.pin : "");
  const [unlocked, setUnlocked] = useState(pending?.token === token);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const claiming = useRef(false);

  const signedIn = status === "setup" || status === "ready";

  useEffect(() => {
    document.title = "Join · pOS";
  }, []);

  // Once the PIN is verified and the person is signed in, claim the invite.
  useEffect(() => {
    if (!unlocked || !signedIn || claiming.current) return;
    claiming.current = true;
    setBusy(true);
    setError("");
    api<{ ok: true; role: string }>(`/api/invites/${encodeURIComponent(token)}/claim`, {
      body: { pin, fullName: info.data?.name ?? "" },
    })
      .then(async () => {
        clearPendingInvite();
        clearCache();
        await refresh();
        nav("/", { replace: true });
      })
      .catch((e: Error) => {
        clearPendingInvite();
        setError(e.message);
        setBusy(false);
      });
  }, [unlocked, signedIn]); // eslint-disable-line react-hooks/exhaustive-deps

  const check = async () => {
    setError("");
    const p = pin.replace(/\D/g, "");
    if (p.length !== 6) return setError("Enter the 6-digit PIN the owner gave you.");
    setBusy(true);
    try {
      await api(`/api/invites/${encodeURIComponent(token)}/check`, { body: { pin: p } });
      savePendingInvite(token, p);
      setPin(p);
      setUnlocked(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't check the PIN.");
    } finally {
      setBusy(false);
    }
  };

  const inv = info.data;
  const roleText =
    inv?.role === "staff"
      ? "as staff"
      : inv?.unitLabel
        ? `for ${inv.unitLabel}${inv.propertyName ? `, ${inv.propertyName}` : ""}`
        : "as a tenant";

  let body;
  if (info.loading) {
    body = (
      <div className="center-text mt24">
        <Spinner size={28} />
      </div>
    );
  } else if (info.error || !inv) {
    body = (
      <Empty
        icon="link"
        title="This link isn't valid"
        text={info.error?.message ?? t("Check that you opened the full link the owner sent you.")}
      />
    );
  } else if (inv.state !== "valid" && !(signedIn && unlocked)) {
    const copy = {
      claimed: ["Already used", "This invite has been accepted. If that was you, just sign in."],
      expired: ["This invite has expired", "Invites last 7 days. Ask the owner to send you a new one."],
      locked: ["Too many wrong PINs", "For your safety this invite is locked. Ask the owner for a new one."],
      valid: ["", ""],
    }[inv.state];
    body = (
      <Empty
        icon="lock"
        title={copy[0]}
        text={copy[1]}
        action={
          <button className="btn md auto" onClick={() => nav("/", { replace: true })}>
            {t("Go to sign in")}
          </button>
        }
      />
    );
  } else if (!unlocked) {
    body = (
      <div className="stack-12">
        <input
          className="input-solo pin"
          aria-label={t("6-digit PIN")}
          inputMode="numeric"
          autoComplete="one-time-code"
          maxLength={6}
          placeholder="••••••"
          value={pin}
          onChange={(e) => setPin(e.target.value.replace(/\D/g, "").slice(0, 6))}
          onKeyDown={(e) => e.key === "Enter" && check()}
          autoFocus
          style={{ height: 72 }}
        />
        <FormError text={error} />
        <button className="btn" onClick={check} disabled={busy || pin.length !== 6}>
          {busy ? <Spinner /> : t("Continue")}
        </button>
        <p className="legal" style={{ marginTop: 8 }}>
          {t("The owner shares the PIN separately from the link, by phone or in person.")}
        </p>
      </div>
    );
  } else if (!signedIn) {
    body = (
      <AuthForm
        initialMode="signup"
        defaultName={inv.name}
        hint="PIN accepted. Now create your account, or sign in if you already have one."
      />
    );
  } else {
    body = (
      <div className="stack-12 center-text">
        {busy ? (
          <>
            <Spinner size={28} />
            <p className="t-sub c2">{t("Setting up your account…")}</p>
          </>
        ) : (
          <>
            <FormError text={error} />
            {me?.profile && <p className="t-sub c2">{t("You're signed in as {email}.", { email: me.user.email })}</p>}
            <button className="btn gray" onClick={signOut}>
              {t("Sign in with a different account")}
            </button>
            {me?.profile && (
              <button className="btn tinted" onClick={() => nav("/", { replace: true })}>
                {t("Back to pOS")}
              </button>
            )}
          </>
        )}
      </div>
    );
  }

  return (
    <main className="welcome page fade" style={{ paddingTop: "calc(var(--safe-t) + 40px)" }}>
      <div className="welcome-hero" style={{ paddingBottom: 22 }}>
        <img
          className="app-icon"
          src="/icons/icon.svg"
          alt=""
          width={76}
          height={76}
          style={{ width: 76, height: 76 }}
        />
        <h1 className="t-title1" style={{ margin: 0 }}>
          {inv?.name ? t("Hi {value}", { value: inv.name.split(/[\s&]/)[0] }) : t("You're invited")}
        </h1>
        {inv && (
          <p className="t-callout c2">
            {t("{value} invited you to pOS {roleText}.", { value: inv.ownerName || "The owner", roleText })}
          </p>
        )}
      </div>
      {inv && !unlocked && inv.state === "valid" && (
        <div className="hstack mb16" style={{ justifyContent: "center", color: "var(--label-2)" }}>
          <I.lock width={16} height={16} />
          <span className="t-foot">{t("Enter your invite PIN")}</span>
        </div>
      )}
      {body}
    </main>
  );
}
