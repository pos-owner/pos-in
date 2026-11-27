import { useNavigate } from "react-router-dom";
import { useApi } from "../lib/api";
import { haptic } from "../lib/perf";
import { useT } from "../lib/i18n";
import { I } from "./icons";

export const UNREAD_KEY = "/api/notifications/unread";

/** The inbox button on each role's first screen, with the unread count. */
export function Bell() {
  const nav = useNavigate();
  const t = useT();
  const { data } = useApi<{ count: number }>(UNREAD_KEY);
  const n = data?.count ?? 0;
  return (
    <button
      className="circle-btn glass"
      style={{ position: "relative" }}
      aria-label={n ? t("Notifications, {n} unread", { n }) : t("Notifications")}
      onClick={() => {
        haptic();
        nav("/notifications");
      }}
    >
      <I.inbox />
      {n > 0 && <span className="bell-badge">{n > 9 ? "9+" : n}</span>}
    </button>
  );
}
