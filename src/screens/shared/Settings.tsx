import { useEffect, useState } from "react";
import { useAuth } from "../../lib/auth";
import { api, ApiError, invalidate, useApi } from "../../lib/api";
import { loginKey } from "../../../shared/loginKey";
import { deviceInfo, deviceLabel } from "../../lib/device";
import { relTime } from "../../lib/format";
import { useInstall } from "../../lib/install";
import { getPerfPref, setPerfPref, type PerfPref } from "../../lib/perf";
import {
  Avatar,
  Field,
  FormError,
  Page,
  Row,
  Section,
  Segmented,
  Sheet,
  Spinner,
  useToast,
} from "../../components/kit";
import { I } from "../../components/icons";
import PanSection from "./settings/PanSection";
import NotificationSection from "./settings/NotificationSection";
import LanguageSection from "./settings/LanguageSection";
import DisplaySection from "./settings/DisplaySection";
import { useT } from "../../lib/i18n";

const ROLE_LABEL = { owner: "Owner", staff: "Staff", tenant: "Tenant" } as const;

export default function Settings() {
  const tx = useT();
  const { me, refresh, signOut } = useAuth();
  const toast = useToast();
  const t = useT();
  const profile = me?.profile;
  const role = profile?.role ?? "owner";
  const [fullName, setFullName] = useState(profile?.fullName ?? "");
  const [phone, setPhone] = useState(profile?.phone ?? "");
  const [upiId, setUpiId] = useState(profile?.upiId ?? "");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [perf, setPerf] = useState<PerfPref>(getPerfPref());
  const [signingOut, setSigningOut] = useState(false);
  const [pwOpen, setPwOpen] = useState(false);
  const [everywhere, setEverywhere] = useState(false);
  const install = useInstall();

  useEffect(() => {
    setFullName(profile?.fullName ?? "");
    setPhone(profile?.phone ?? "");
    setUpiId(profile?.upiId ?? "");
  }, [profile?.fullName, profile?.phone, profile?.upiId]);

  const dirty =
    fullName.trim() !== (profile?.fullName ?? "") ||
    phone.trim() !== (profile?.phone ?? "") ||
    (role === "owner" && upiId.trim() !== (profile?.upiId ?? ""));

  const upiValid = !upiId.trim() || /^[\w.-]{2,}@[a-zA-Z][\w.-]*$/.test(upiId.trim());

  async function save() {
    if (!fullName.trim()) return setErr("Enter your name.");
    if (role === "owner" && !upiValid) return setErr("That UPI ID doesn't look right. It should look like name@bank.");
    setErr("");
    setBusy(true);
    try {
      await api("/api/profile", {
        method: "PATCH",
        body: { fullName: fullName.trim(), phone: phone.trim(), ...(role === "owner" ? { upiId: upiId.trim() } : {}) },
      });
      await refresh();
      toast("Profile saved");
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : "Couldn't save your profile.");
    } finally {
      setBusy(false);
    }
  }

  async function doSignOut() {
    setSigningOut(true);
    try {
      await signOut();
    } finally {
      setSigningOut(false);
    }
  }

  /** Ends every session for this account, this device included. Asks for a second tap first. */
  async function signOutEverywhere() {
    if (!everywhere) return setEverywhere(true);
    setSigningOut(true);
    try {
      await api("/api/account/signout-all", { method: "POST" });
      await signOut();
    } catch (e) {
      toast(e instanceof ApiError ? e.message : "Couldn't sign out your devices.", "alert");
      setSigningOut(false);
      setEverywhere(false);
    }
  }

  const name = profile?.fullName || me?.user.name || me?.user.email || "You";

  return (
    <Page title="Settings" back tabs={false}>
      <div className="center-text" style={{ padding: "4px 20px 24px" }}>
        <div style={{ display: "inline-block" }}>
          <Avatar name={name} size="lg" />
        </div>
        <div className="t-title2 mt12">{name}</div>
        <div className="t-sub c2" style={{ marginTop: 2 }}>
          {profile?.email || me?.user.email}
        </div>
        <span className={`pill ${role === "owner" ? "blue" : role === "staff" ? "orange" : "green"} mt8`}>
          {t(ROLE_LABEL[role])}
        </span>
      </div>

      <Section
        title="Profile"
        footer={
          role === "owner"
            ? tx("Tenants pay rent to this UPI ID. It appears in their Pay screen as a UPI link and QR code.")
            : undefined
        }
      >
        <div className="list">
          <Field label="Name" value={fullName} onChange={setFullName} autoComplete="name" maxLength={80} />
          <Field
            label="Phone"
            value={phone}
            onChange={setPhone}
            type="tel"
            inputMode="tel"
            placeholder="98450 12345"
            autoComplete="tel"
            maxLength={20}
          />
          {role === "owner" && (
            <Field
              label="UPI ID"
              value={upiId}
              onChange={setUpiId}
              placeholder="yourname@okhdfcbank"
              autoComplete="off"
              maxLength={80}
            />
          )}
        </div>
        <FormError text={err} />
        {dirty && (
          <button className="btn mt12" onClick={save} disabled={busy}>
            {busy ? <Spinner /> : t("Save changes")}
          </button>
        )}
      </Section>

      <Section
        title="Security"
        footer={
          everywhere
            ? tx("Tap again to sign out on every phone and computer, including this one.")
            : tx("Signing out everywhere helps if you lost a phone or signed in on someone else's.")
        }
      >
        <div className="list icons">
          <Row icon="key" iconBg="var(--orange)" title="Change password" chevron onClick={() => setPwOpen(true)} />
          <Row
            icon="lock"
            iconBg="var(--red)"
            title={everywhere ? tx("Tap again to confirm") : tx("Sign out everywhere")}
            danger={everywhere}
            onClick={signOutEverywhere}
          />
        </div>
      </Section>

      <DevicesSection />

      <NotificationSection />
      <LanguageSection />
      <DisplaySection />
      <PanSection />

      <Section
        title="Performance"
        footer="Lite mode turns off the frosted-glass blur for smoother scrolling on older phones. Auto picks it for you."
      >
        <div>
          <Segmented
            label="Performance"
            value={perf}
            onChange={(v) => {
              setPerf(v);
              setPerfPref(v);
            }}
            options={[
              { value: "auto", label: "Auto" },
              { value: "lite", label: "Lite" },
              { value: "full", label: "Full" },
            ]}
          />
        </div>
      </Section>

      <Section title="Install">
        <div className="list icons">
          {install.standalone ? (
            <Row icon="checkCircle" iconBg="var(--green)" title="Installed" sub="pOS is on your Home Screen" />
          ) : install.ios ? (
            <div className="row">
              <span className="icon-sq" style={{ background: "var(--accent)" }}>
                <I.install />
              </span>
              <span className="grow">
                <span className="title" style={{ display: "block" }}>
                  {t("Add to Home Screen")}
                </span>
                <span className="sub" style={{ display: "block", whiteSpace: "normal" }}>
                  {tx("In Safari, tap")}{" "}
                  <I.share style={{ width: 15, height: 15, verticalAlign: "-2px", color: "var(--accent)" }} />{" "}
                  {tx("Share, then")} <b>{tx("Add to Home Screen")}</b>.
                </span>
              </span>
            </div>
          ) : install.canPrompt ? (
            <Row
              icon="install"
              title="Install pOS"
              sub="Opens full screen, no app store needed"
              chevron
              onClick={() => install.prompt()}
            />
          ) : (
            <div className="row">
              <span className="icon-sq" style={{ background: "var(--accent)" }}>
                <I.install />
              </span>
              <span className="grow">
                <span className="title" style={{ display: "block" }}>
                  {t("Install pOS")}
                </span>
                <span className="sub" style={{ display: "block", whiteSpace: "normal" }}>
                  {tx("In Chrome, open the ⋮ menu and choose")} <b>{tx("Install app")}</b> {tx("or")}{" "}
                  <b>{tx("Add to Home screen")}</b>.
                </span>
              </span>
            </div>
          )}
        </div>
      </Section>

      <Section title="About">
        <div className="list icons">
          <Row icon="tag" iconBg="var(--teal)" title="pOS" value={`v${__APP_VERSION__}`} />
          <Row icon="lock" iconBg="var(--label-2)" title="Your data" sub="Only people in your workspace can see it" />
        </div>
      </Section>

      <Section>
        <button className="btn danger" onClick={doSignOut} disabled={signingOut}>
          {signingOut ? (
            <Spinner />
          ) : (
            <>
              <I.out /> {t("Sign out")}
            </>
          )}
        </button>
      </Section>
      <PasswordSheet open={pwOpen} onClose={() => setPwOpen(false)} />
    </Page>
  );
}

interface DeviceSession {
  id: string;
  current: boolean;
  userAgent: string;
  /** Rough place the device signed in from ("Pune, India"); empty when unknown. */
  location: string;
  createdAt: string;
  seenAt: string;
}

const SESSIONS_KEY = "/api/account/sessions";
/** relTime for mid-sentence use: "just now", "3h ago", "12 Nov 2025". */
const ago = (t: string) => {
  const r = relTime(t);
  return r === "Just now" ? "just now" : r;
};

/** Every phone and computer signed in to this account. Another device signs out after a second tap. */
function DevicesSection() {
  const tx = useT();
  const toast = useToast();
  const { data, error, loading } = useApi<DeviceSession[]>(SESSIONS_KEY);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const others = data?.filter((d) => !d.current).length ?? 0;

  async function signOutDevice(d: DeviceSession) {
    if (confirming !== d.id) return setConfirming(d.id);
    setBusy(d.id);
    try {
      await api(`${SESSIONS_KEY}/${encodeURIComponent(d.id)}`, { method: "DELETE" });
      toast(`Signed out ${deviceInfo(d.userAgent).device}`);
      invalidate(SESSIONS_KEY);
    } catch (e) {
      toast(e instanceof ApiError ? e.message : "Couldn't sign out that device.", "alert");
    } finally {
      setBusy(null);
      setConfirming(null);
    }
  }

  return (
    <Section
      title="Signed-in devices"
      footer={
        confirming
          ? tx("Tap the device again to sign it out. It will need your password to get back in.")
          : others
            ? tx("Don't recognise a device? Sign it out, then change your password.")
            : undefined
      }
    >
      <div className="list icons">
        {loading ? (
          <div className="row center">
            <Spinner />
          </div>
        ) : error || !data ? (
          <Row icon="alert" iconBg="var(--label-2)" title="Couldn't load your devices" sub={error?.message} />
        ) : (
          data.map((d) => {
            const info = deviceInfo(d.userAgent);
            const when = d.current ? "This device" : `Last active ${ago(d.seenAt)}`;
            return (
              <Row
                key={d.id}
                icon={info.mobile ? "device" : "laptop"}
                iconBg={d.current ? "var(--green)" : "var(--label-2)"}
                title={confirming === d.id ? tx("Tap again to sign out") : deviceLabel(d.userAgent)}
                sub={[when, d.location, `signed in ${ago(d.createdAt)}`].filter(Boolean).join(" · ")}
                danger={confirming === d.id}
                end={busy === d.id ? <Spinner /> : undefined}
                onClick={d.current || busy ? undefined : () => signOutDevice(d)}
              />
            );
          })
        )}
      </div>
    </Section>
  );
}

const MIN_PASSWORD = 8;

/** Change password: needs the current one. Other devices are signed out; this one stays signed in. */
function PasswordSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const tx = useT();
  const toast = useToast();
  const t = useT();
  const { me } = useAuth();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  function close() {
    onClose();
    setTimeout(() => {
      setCurrent("");
      setNext("");
      setConfirm("");
      setErr("");
    }, 300);
  }

  async function save() {
    if (!current) return setErr("Enter your current password.");
    if (next.length < MIN_PASSWORD) return setErr(`Use a new password with at least ${MIN_PASSWORD} characters.`);
    if (next !== confirm) return setErr("The new passwords don't match.");
    setErr("");
    setBusy(true);
    try {
      // Both passwords are stretched in the browser (see shared/loginKey.ts); neither is sent as typed.
      const email = me?.user.email ?? "";
      const [currentKey, key] = await Promise.all([loginKey(email, current), loginKey(email, next)]);
      await api("/api/account/password", { method: "POST", body: { currentKey, key } });
      toast("Password changed. Other devices were signed out.");
      invalidate(SESSIONS_KEY);
      close();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : "Couldn't change your password.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Sheet open={open} onClose={close} title="Change password" onDone={save} doneLabel="Save" busy={busy}>
      <Section footer="Changing your password signs you out on every other device.">
        <div className="list">
          <Field
            label="Current"
            value={current}
            onChange={setCurrent}
            type="password"
            autoComplete="current-password"
            maxLength={256}
            autoFocus
          />
          <Field
            label="New"
            value={next}
            onChange={setNext}
            type="password"
            autoComplete="new-password"
            placeholder={tx("At least {MIN_PASSWORD} characters", { MIN_PASSWORD })}
            maxLength={256}
          />
          <Field
            label="Confirm"
            value={confirm}
            onChange={setConfirm}
            type="password"
            autoComplete="new-password"
            maxLength={256}
          />
        </div>
        <FormError text={err} />
        <button className="btn mt12" onClick={save} disabled={busy}>
          {busy ? <Spinner /> : t("Change password")}
        </button>
      </Section>
    </Sheet>
  );
}
