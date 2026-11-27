import { useEffect, useState } from "react";
import { api, ApiError } from "../../../lib/api";
import { disablePush, enablePush, needsInstallForPush, pushState, type PushState } from "../../../lib/push";
import { Row, Section, Spinner, Toggle, useToast } from "../../../components/kit";
import { useT } from "../../../lib/i18n";

/** Web Push on this device, plus the way into the in-app inbox. */
export default function NotificationSection() {
  const t = useT();
  const toast = useToast();
  const [state, setState] = useState<PushState | null>(null);
  const [busy, setBusy] = useState<"" | "toggle" | "test">("");

  useEffect(() => {
    let alive = true;
    pushState().then((s) => alive && setState(s));
    return () => {
      alive = false;
    };
  }, []);

  async function toggle(on: boolean) {
    setBusy("toggle");
    try {
      const s = on ? await enablePush() : await disablePush();
      setState(s);
      if (on && s === "on") toast("Notifications are on for this device");
      else if (on && s === "denied") toast("Notifications are blocked in this browser's settings.", "alert");
      else if (!on) toast("Notifications are off for this device");
    } catch (e) {
      toast(e instanceof ApiError || e instanceof Error ? e.message : "Couldn't change notifications.", "alert");
    } finally {
      setBusy("");
    }
  }

  async function test() {
    setBusy("test");
    try {
      const r = await api<{ devices: number; sent: number }>("/api/push/test", { method: "POST" });
      toast(
        r.sent ? "Test sent. It should arrive in a moment." : "Added to your inbox. Push isn't on for any device yet.",
      );
    } catch (e) {
      toast(e instanceof ApiError ? e.message : "Couldn't send a test.", "alert");
    } finally {
      setBusy("");
    }
  }

  const footer =
    state === "unsupported"
      ? needsInstallForPush()
        ? "On iPhone and iPad, add pOS to your Home Screen first (Share → Add to Home Screen), then turn notifications on from there."
        : "This browser can't show push notifications. Everything still arrives in your inbox."
      : state === "denied"
        ? "Notifications are blocked for pOS in this browser. Allow them in the browser's site settings, then come back."
        : "Payments, requests, lease reminders and settlements. Each device you turn this on for gets them.";

  return (
    <Section title="Notifications" footer={footer}>
      <div className="list icons">
        <Row icon="inbox" iconBg="var(--accent)" title="Inbox" chevron to="/notifications" />
      </div>
      <div className="list mt12">
        {state === null ? (
          <div className="row">
            <span className="grow">
              <span className="title">{t("Push on this device")}</span>
            </span>
            <span className="end">
              <Spinner size={18} />
            </span>
          </div>
        ) : (
          <Toggle
            label="Push on this device"
            sub={
              busy === "toggle"
                ? t("Working…")
                : state === "on"
                  ? t("On")
                  : state === "denied"
                    ? t("Blocked")
                    : state === "unsupported"
                      ? t("Not available")
                      : t("Off")
            }
            checked={state === "on"}
            disabled={busy === "toggle" || state === "unsupported" || state === "denied"}
            onChange={(v) => {
              if (busy || state === "unsupported" || state === "denied") return;
              void toggle(v);
            }}
          />
        )}
        {state === "on" && (
          <button type="button" className="row" onClick={test} disabled={!!busy}>
            <span className="grow">
              <span className="title" style={{ color: "var(--accent-press)" }}>
                {t("Send a test notification")}
              </span>
            </span>
            <span className="end">{busy === "test" && <Spinner size={18} />}</span>
          </button>
        )}
      </div>
    </Section>
  );
}
