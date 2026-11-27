import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { api, ApiError, invalidate, useApi } from "../../lib/api";
import { relTime } from "../../lib/format";
import type { NotificationItem, NotificationsResponse } from "../../lib/types";
import { Empty, ErrorState, Page, Section, SkeletonPage, Spinner, useToast } from "../../components/kit";
import { Icon, type IconName } from "../../components/icons";
import { UNREAD_KEY } from "../../components/Bell";
import { useT } from "../../lib/i18n";

/*
 * In-app inbox, all roles. Route: /notifications
 * Payment claims and confirmations, requests, lease alerts, settlements, late fees and recurring bills land here;
 * the same rows are sent as Web Push when it's turned on in Settings.
 */

const KIND: Record<string, { icon: IconName; bg: string }> = {
  payment_claim: { icon: "rupee", bg: "var(--purple)" },
  payment_confirmed: { icon: "checkCircle", bg: "var(--green)" },
  payment_rejected: { icon: "alert", bg: "var(--red)" },
  request_new: { icon: "wrench", bg: "var(--orange)" },
  request_urgent: { icon: "alert", bg: "var(--red)" },
  request_assigned: { icon: "wrench", bg: "var(--accent)" },
  request_update: { icon: "chat", bg: "var(--teal)" },
  lease_expiry: { icon: "calendar", bg: "var(--orange)" },
  lease_holdover: { icon: "key", bg: "var(--red)" },
  lease_renewed: { icon: "key", bg: "var(--green)" },
  settlement: { icon: "wallet", bg: "var(--indigo)" },
  late_fee: { icon: "clock", bg: "var(--red)" },
  rent_due: { icon: "rupee", bg: "var(--orange)" },
  expense_pending: { icon: "wallet", bg: "var(--brown)" },
  meter_pending: { icon: "gauge", bg: "var(--orange)" },
  recurring_expense: { icon: "calendar", bg: "var(--indigo)" },
  push_test: { icon: "sparkle", bg: "var(--accent)" },
};

export default function Notifications() {
  const t = useT();
  const { data, error, loading, reload } = useApi<NotificationsResponse>("/api/notifications");
  const toast = useToast();
  const nav = useNavigate();
  const [older, setOlder] = useState<NotificationItem[]>([]);
  const [more, setMore] = useState<boolean | null>(null);
  const [busy, setBusy] = useState<"" | "all" | "more">("");
  const [readLocal, setReadLocal] = useState<Set<number>>(new Set());

  const items = [...(data?.items ?? []), ...older.filter((o) => !data?.items.some((x) => x.id === o.id))];
  const hasMore = more ?? data?.more ?? false;
  const unread = items.filter((n) => !n.read && !readLocal.has(n.id)).length;

  async function markRead(ids?: number[]) {
    await api("/api/notifications/read", { body: ids ? { ids } : {} });
    invalidate(UNREAD_KEY, "/api/notifications");
  }

  async function open(n: NotificationItem) {
    if (!n.read && !readLocal.has(n.id)) {
      setReadLocal((s) => new Set(s).add(n.id));
      markRead([n.id]).catch(() => undefined);
    }
    if (n.url && n.url !== "/notifications") nav(n.url);
  }

  async function readAll() {
    setBusy("all");
    try {
      await markRead();
      setReadLocal(new Set(items.map((n) => n.id)));
    } catch (e) {
      toast(e instanceof ApiError ? e.message : "Couldn't mark them as read.", "alert");
    } finally {
      setBusy("");
    }
  }

  async function loadMore() {
    const last = items[items.length - 1];
    if (!last) return;
    setBusy("more");
    try {
      const r = await api<NotificationsResponse>(`/api/notifications?before=${last.id}`);
      setOlder((o) => [...o, ...r.items]);
      setMore(r.more);
    } catch (e) {
      toast(e instanceof ApiError ? e.message : "Couldn't load more.", "alert");
    } finally {
      setBusy("");
    }
  }

  const right =
    unread > 0 ? (
      <button className="btn plain sm" onClick={readAll} disabled={!!busy}>
        {busy === "all" ? <Spinner size={16} /> : t("Read all")}
      </button>
    ) : undefined;

  if (loading)
    return (
      <Page title="Notifications" back tabs={false}>
        <SkeletonPage variant="list" />
      </Page>
    );
  if (error || !data)
    return (
      <Page title="Notifications" back tabs={false}>
        <ErrorState error={error ?? { message: "Couldn't load notifications." }} retry={reload} />
      </Page>
    );

  return (
    <Page title="Notifications" back tabs={false} right={right}>
      {!items.length ? (
        <Empty
          icon="inbox"
          title="All caught up"
          text="Payments, requests, lease reminders and settlements show up here. Turn on push in Settings to get them on your phone."
        />
      ) : (
        <Section footer={hasMore ? undefined : t("Older notifications are kept for your records.")}>
          <div className="list icons">
            {items.map((n) => {
              const k = KIND[n.kind] ?? { icon: "inbox" as IconName, bg: "var(--accent)" };
              const isRead = n.read || readLocal.has(n.id);
              return (
                <button type="button" className="row" key={n.id} onClick={() => open(n)}>
                  <span className="icon-sq" style={{ background: k.bg }}>
                    <Icon name={k.icon} />
                  </span>
                  <span className="grow">
                    <span className="title" style={{ display: "block", fontWeight: isRead ? undefined : 600 }}>
                      {n.title}
                    </span>
                    {n.body && (
                      <span className="sub" style={{ display: "block", whiteSpace: "normal" }}>
                        {n.body}
                      </span>
                    )}
                    <span className="t-foot c2" style={{ display: "block", marginTop: 2 }}>
                      {relTime(n.createdAt)}
                    </span>
                  </span>
                  <span className="end">{!isRead && <span className="unread-dot" aria-label={t("Unread")} />}</span>
                </button>
              );
            })}
          </div>
          {hasMore && (
            <button className="btn tinted md mt12" onClick={loadMore} disabled={!!busy}>
              {busy === "more" ? <Spinner /> : t("Show older")}
            </button>
          )}
        </Section>
      )}
    </Page>
  );
}
