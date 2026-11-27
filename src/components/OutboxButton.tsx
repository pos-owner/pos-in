import { useNavigate } from "react-router-dom";
import { useT } from "../lib/i18n";
import { useOutbox, type OutboxKind } from "../lib/outbox";
import { haptic } from "../lib/perf";
import { I } from "./icons";

/**
 * Offline outbox shortcuts. Both stay hidden while nothing is waiting, so they only appear on a phone
 * that has entries saved offline.
 */

/** Home-screen button next to the Bell: the number of entries on this phone, red when one needs attention. */
export function OutboxButton() {
  const nav = useNavigate();
  const t = useT();
  const entries = useOutbox();
  if (!entries.length) return null;
  const bad = entries.some((e) => e.state === "attention");
  const n = entries.length;
  return (
    <button
      className="circle-btn glass"
      style={{ position: "relative" }}
      aria-label={
        bad ? t("Waiting to sync, {n} need attention", { n }) : t("Waiting to sync, {n} on this phone", { n })
      }
      onClick={() => {
        haptic();
        nav("/outbox");
      }}
    >
      <I.cloudUp />
      <span className={`bell-badge outbox-badge ${bad ? "bad" : ""}`}>{n > 9 ? "9+" : n}</span>
    </button>
  );
}

const NOTE: Record<OutboxKind, { one: string; many: string }> = {
  meter: { one: "1 reading saved on this phone", many: "{n} readings saved on this phone" },
  request: { one: "1 request saved on this phone", many: "{n} requests saved on this phone" },
  expense: { one: "1 expense saved on this phone", many: "{n} expenses saved on this phone" },
};

/** A tappable note at the top of the meter, request and expense screens about entries of that kind still waiting. */
export function OutboxNote({ kind }: { kind: OutboxKind }) {
  const nav = useNavigate();
  const t = useT();
  const mine = useOutbox().filter((e) => e.kind === kind);
  if (!mine.length) return null;
  const bad = mine.filter((e) => e.state === "attention").length;
  const n = mine.length;
  return (
    <div className="section">
      <button type="button" className={`outbox-note ${bad ? "bad" : ""}`} onClick={() => nav("/outbox")}>
        {bad ? <I.alert /> : <I.cloudUp />}
        <span className="grow">
          <b style={{ display: "block" }}>{n === 1 ? t(NOTE[kind].one) : t(NOTE[kind].many, { n })}</b>
          <span className="c2">
            {bad
              ? t("{n} need your attention before they can be sent", { n: bad })
              : navigator.onLine
                ? t("Sending now")
                : t("Sent by itself when you're back online")}
          </span>
        </span>
        <I.chevR className="chev" />
      </button>
    </div>
  );
}
