import { useEffect, useState } from "react";
import { intlLocale, useLocale, useT } from "../../lib/i18n";
import {
  discardEntry,
  retryAll,
  retryEntry,
  useOutbox,
  type OutboxEntry,
  type OutboxKind,
  type OutboxState,
} from "../../lib/outbox";
import { Empty, Page, Section, Spinner, useToast } from "../../components/kit";
import { Icon, type IconName } from "../../components/icons";

/** "2 minutes ago", "yesterday" in the app's language. */
function ago(ms: number, locale: string) {
  const s = Math.round((ms - Date.now()) / 1000);
  const f = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
  if (s > -60) return f.format(0, "second");
  if (s > -3600) return f.format(Math.round(s / 60), "minute");
  if (s > -86400) return f.format(Math.round(s / 3600), "hour");
  return f.format(Math.round(s / 86400), "day");
}

/*
 * Offline outbox. Route: /outbox
 * Meter readings, requests and expenses saved without a connection wait here until they are sent. Nothing is removed
 * until the server has acknowledged it; an entry the server refused stays until it is fixed or discarded.
 */

const KIND: Record<OutboxKind, { icon: IconName; bg: string }> = {
  meter: { icon: "gauge", bg: "var(--orange)" },
  request: { icon: "wrench", bg: "var(--accent)" },
  expense: { icon: "wallet", bg: "var(--brown)" },
};

const STATE: Record<OutboxState, { label: string; pill: string }> = {
  queued: { label: "Waiting", pill: "gray" },
  syncing: { label: "Sending", pill: "blue" },
  failed: { label: "Will retry", pill: "orange" },
  attention: { label: "Needs attention", pill: "red" },
};

export default function Outbox() {
  const entries = useOutbox();
  const t = useT();
  const toast = useToast();
  const [online, setOnline] = useState(navigator.onLine);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const on = () => setOnline(true),
      off = () => setOnline(false);
    addEventListener("online", on);
    addEventListener("offline", off);
    return () => {
      removeEventListener("online", on);
      removeEventListener("offline", off);
    };
  }, []);

  const attention = entries.filter((e) => e.state === "attention");
  const waiting = entries.filter((e) => e.state !== "attention");

  async function sendNow() {
    setBusy(true);
    try {
      await retryAll();
    } finally {
      setBusy(false);
    }
  }

  return (
    <Page title={t("Waiting to sync")} back tabs={false}>
      {entries.length === 0 ? (
        <Empty
          icon="checkCircle"
          title={t("Everything is sent")}
          text={t("Readings, requests and expenses saved offline wait here and are sent when you're back online.")}
        />
      ) : (
        <>
          <Section
            footer={
              online
                ? t("Entries are sent in the order they were made. Each one is saved only once, even if it's retried.")
                : t("You're offline. These are safe on this phone and go out by themselves when you're back online.")
            }
          >
            <div className="outbox-summary">
              <span className="icon-sq" style={{ background: online ? "var(--accent)" : "var(--label-2)" }}>
                <Icon name={online ? "cloudUp" : "wifiOff"} />
              </span>
              <span className="grow">
                <b>
                  {entries.length === 1
                    ? t("1 entry on this phone")
                    : t("{n} entries on this phone", { n: entries.length })}
                </b>
                <span className="sub">
                  {attention.length
                    ? t("{n} need your attention", { n: attention.length })
                    : online
                      ? t("Sending…")
                      : t("Waiting for a connection")}
                </span>
              </span>
              {waiting.length > 0 && (
                <button className="btn tinted sm auto" onClick={sendNow} disabled={busy || !online}>
                  {busy ? <Spinner size={16} /> : t("Send now")}
                </button>
              )}
            </div>
          </Section>

          {attention.length > 0 && (
            <Section title={t("Needs attention")}>
              <div className="list">
                {attention.map((e) => (
                  <EntryRow key={e.key} e={e} toast={toast} />
                ))}
              </div>
            </Section>
          )}
          {waiting.length > 0 && (
            <Section title={t("Waiting to send")}>
              <div className="list">
                {waiting.map((e) => (
                  <EntryRow key={e.key} e={e} toast={toast} />
                ))}
              </div>
            </Section>
          )}
        </>
      )}
    </Page>
  );
}

function EntryRow({ e, toast }: { e: OutboxEntry; toast: ReturnType<typeof useToast> }) {
  const t = useT();
  const locale = intlLocale(useLocale());
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const k = KIND[e.kind];
  const s = STATE[e.state];

  async function run(f: () => Promise<void>) {
    setBusy(true);
    try {
      await f();
    } catch {
      toast(t("Couldn't update this entry. Try again."), "alert");
    } finally {
      setBusy(false);
    }
  }

  async function discard() {
    if (!confirm) return setConfirm(true);
    await run(async () => {
      await discardEntry(e.key);
      toast(t("Entry discarded"));
    });
  }

  const photos = e.photos.length + e.photoKeys.length;
  const photoLabel = photos ? t(photos === 1 ? "1 photo" : "{n} photos", { n: photos }) : "";
  return (
    <div className="row outbox-row">
      <span className="icon-sq" style={{ background: k.bg }}>
        <Icon name={k.icon} />
      </span>
      <span className="grow">
        <span className="title" style={{ display: "block" }}>
          {e.title}
        </span>
        <span className="sub" style={{ display: "block", whiteSpace: "normal" }}>
          {[e.detail, photoLabel, ago(e.createdAt, locale)].filter(Boolean).join(" · ")}
        </span>
        {e.error && (
          <span className={`outbox-err ${e.state === "attention" ? "bad" : ""}`} role="status">
            {t(e.error)}
          </span>
        )}
        {e.state === "attention" && (
          <span className="outbox-actions">
            {e.kind === "meter" && e.code === "unusual" && (
              <button
                className="btn tinted sm auto"
                disabled={busy}
                onClick={() => run(() => retryEntry(e.key, { confirmUnusual: true }))}
              >
                {t("Save anyway")}
              </button>
            )}
            {e.kind === "meter" && e.code === "lower" && (
              <button
                className="btn tinted sm auto"
                disabled={busy}
                onClick={() => run(() => retryEntry(e.key, { reset: true }))}
              >
                {t("It's a new meter")}
              </button>
            )}
            <button className="btn gray sm auto" disabled={busy} onClick={() => run(() => retryEntry(e.key))}>
              {t("Try again")}
            </button>
            <button className="btn plain sm auto outbox-discard" disabled={busy} onClick={discard}>
              {confirm ? t("Tap again to discard") : t("Discard")}
            </button>
          </span>
        )}
      </span>
      <span className="end">
        {e.state === "syncing" ? <Spinner size={16} /> : <span className={`pill ${s.pill}`}>{t(s.label)}</span>}
      </span>
    </div>
  );
}
