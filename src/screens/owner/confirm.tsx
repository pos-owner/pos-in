import { useCallback, useState } from "react";
import { api, ApiError, invalidate, sharePdf } from "../../lib/api";
import { features } from "../../lib/features";
import { dateLabel, monthLabel, rupees } from "../../lib/format";
import { haptic } from "../../lib/perf";
import type { LedgerRow, Payment } from "../../lib/types";
import { Avatar, Spinner, useToast } from "../../components/kit";
import { I } from "../../components/icons";
import { METHOD } from "../tenant/History";
import { refreshRent } from "./ChargeSheet";
import "../../styles/owner.css";
import { useT } from "../../lib/i18n";

/**
 * The daily heartbeat of pOS: a tenant taps "I have paid", the owner confirms. Everything that confirms or rejects a
 * payment goes through here so the feedback is the same everywhere: a success haptic, a toast, and (when receipts are
 * on) a one-tap "Share receipt" follow-up.
 */

/** Issues the receipt if needed (idempotent), then opens the share sheet so it can go to the tenant on WhatsApp. */
export async function shareReceipt(paymentId: number): Promise<"shared" | "downloaded" | "cancelled"> {
  const r = await api<{ number: string; created: boolean }>(`/api/payments/${paymentId}/receipt`, { method: "POST" });
  if (r.created) invalidate("/api/receipts");
  return sharePdf(`/api/payments/${paymentId}/receipt.json`, `${r.number}.pdf`, `Rent receipt ${r.number}`);
}

/** The tenant's "I have paid" claims on a charge that still wait for the owner. */
export const pendingOf = (r: Pick<LedgerRow, "payments">) => r.payments.filter((p) => p.status === "pending");

export function usePaymentDecisions() {
  const toast = useToast();
  const [busy, setBusy] = useState<string>("");

  const offerReceipt = useCallback(
    (paymentId: number) =>
      features.receipts
        ? {
            label: "Share receipt",
            run: () =>
              void shareReceipt(paymentId)
                .then((res) => res === "downloaded" && toast("Receipt downloaded", "receipt"))
                .catch((e) => toast(e instanceof ApiError ? e.message : "Couldn't prepare the receipt.", "alert")),
          }
        : undefined,
    [toast],
  );

  /** Confirms one payment. Returns true when the ledger changed. */
  const confirm = useCallback(
    async (
      p: Pick<Payment, "id" | "amount"> & Pick<Partial<Payment>, "batch">,
      who: string,
      opts: { quiet?: boolean; settle?: boolean } = {},
    ) => {
      setBusy(`ok${p.id}`);
      try {
        await api(`/api/payments/${p.id}/confirm`, { method: "POST" });
        if (!opts.quiet) {
          haptic("success");
          // `settle` lets a card play its confirmed state before the refreshed ledger moves it away.
          if (opts.settle) setTimeout(refreshRent, 900);
          else refreshRent();
          // A multi-month payment is confirmed as a whole: say what was confirmed, not one month's share.
          const b = p.batch && p.batch.months > 1 ? p.batch : null;
          toast(
            `${rupees(b ? b.amount : p.amount)} from ${who.split(/[\s&]/)[0]} confirmed${b ? ` · ${b.months} months` : ""}`,
            "checkCircle",
            offerReceipt(p.id),
          );
        }
        return true;
      } catch (e) {
        if (!opts.quiet) {
          haptic("warn");
          toast(e instanceof ApiError ? e.message : "Couldn't confirm that payment.", "alert");
        }
        return false;
      } finally {
        setBusy("");
      }
    },
    [toast, offerReceipt],
  );

  const reject = useCallback(
    async (p: Pick<Payment, "id">, opts: { settle?: boolean } = {}) => {
      setBusy(`rej${p.id}`);
      try {
        await api(`/api/payments/${p.id}/reject`, { method: "POST" });
        haptic("warn");
        if (opts.settle) setTimeout(refreshRent, 900);
        else refreshRent();
        toast("Marked as not received");
        return true;
      } catch (e) {
        toast(e instanceof ApiError ? e.message : "That didn't work. Please try again.", "alert");
        return false;
      } finally {
        setBusy("");
      }
    },
    [toast],
  );

  /** Confirms several payments one after another (the API keeps each confirmation atomic). */
  const confirmMany = useCallback(
    async (items: { payment: Pick<Payment, "id" | "amount"> & Pick<Partial<Payment>, "batch">; who: string }[]) => {
      setBusy("many");
      // Months of one multi-month payment are confirmed together by the first one, so each batch is sent once.
      const seen = new Set<number>();
      const unique = items.filter((it) => {
        const id = it.payment.batch?.id;
        if (id == null) return true;
        if (seen.has(id)) return false;
        seen.add(id);
        return true;
      });
      let ok = 0,
        total = 0;
      for (const it of unique) {
        if (await confirm(it.payment, it.who, { quiet: true })) {
          ok++;
          total += it.payment.batch?.amount ?? it.payment.amount;
        }
      }
      setBusy("");
      refreshRent();
      if (ok) haptic("success");
      else haptic("warn");
      toast(
        ok === unique.length
          ? `${ok} ${ok === 1 ? "payment" : "payments"} confirmed · ${rupees(total)}`
          : `${ok} of ${unique.length} confirmed. Open the others to check them.`,
        ok ? "checkCircle" : "alert",
      );
      return ok;
    },
    [confirm, toast],
  );

  return { busy, confirm, reject, confirmMany };
}

/**
 * A high-contrast card for a payment the tenant says they made: who, how much, the UTR to match in the bank app, and
 * one-tap Confirm / Not received. "Details" opens the full charge (partial amounts, cash, history).
 */
export function AwaitingCard({
  row,
  onOpen,
  showMonth = true,
  selectable,
  selected,
  onSelect,
}: {
  row: LedgerRow;
  onOpen: () => void;
  showMonth?: boolean;
  selectable?: boolean;
  selected?: boolean;
  onSelect?: () => void;
}) {
  const t = useT();
  const { busy, confirm, reject } = usePaymentDecisions();
  const pending = pendingOf(row);
  const p = pending[0];
  const [done, setDone] = useState<"" | "ok" | "no">("");
  if (!p) return null;
  const method = METHOD[p.method]?.label ?? p.method;
  // The API allows one open "I have paid" per charge, so the first pending payment is the claim.
  const claimed = p.amount;
  const partial = claimed < row.balance;

  return (
    <div className={`await-card ${done ? `is-${done}` : ""} ${selected ? "is-selected" : ""}`}>
      <div className="await-top">
        {selectable ? (
          <button
            type="button"
            className="select-box"
            role="checkbox"
            aria-checked={!!selected}
            aria-label={t("Select {tenantName}", { tenantName: row.tenantName })}
            onClick={() => {
              haptic();
              onSelect?.();
            }}
          >
            {selected && <I.check />}
          </button>
        ) : (
          <Avatar name={row.tenantName} />
        )}
        <button type="button" className="await-who" onClick={onOpen}>
          <span className="title">{row.tenantName}</span>
          <span className="sub">
            {row.unitLabel}
            {showMonth ? t(" · {value} rent", { value: monthLabel(row.month) }) : ""}
          </span>
        </button>
        <span className="await-tag">
          <I.clock /> {t("Tenant says paid")}
        </span>
      </div>

      <div className="await-amount">
        <span className="money">{rupees(claimed)}</span>
        <span className="t-sub c2">
          {method} · {dateLabel(p.paidOn)}
          {partial ? t(" · {amount} still due after this", { amount: rupees(row.balance - claimed) }) : ""}
        </span>
      </div>

      <div className={`utr-box ${p.utr ? "has-utr" : ""}`}>
        {p.utr ? (
          <>
            {t("Match UTR")} <b className="num">{p.utr}</b> {t("in your bank app")}
          </>
        ) : (
          <>{t("No UTR given. Look for {amount} in your bank or UPI app.", { amount: rupees(p.amount) })}</>
        )}
      </div>

      {done ? (
        <div className={`await-done ${done}`} role="status">
          {done === "ok" ? (
            <>
              <span className="await-tick">
                <I.check />
              </span>
              {t("Confirmed · added to the ledger")}
            </>
          ) : (
            <>{t("Marked as not received")}</>
          )}
        </div>
      ) : (
        <div className="await-actions">
          <button
            className="btn gray md"
            disabled={!!busy}
            onClick={() => reject(p, { settle: true }).then((ok) => ok && setDone("no"))}
          >
            {busy === `rej${p.id}` ? <Spinner /> : t("Not received")}
          </button>
          <button className="btn gray md icon-only" aria-label={t("Details")} disabled={!!busy} onClick={onOpen}>
            <I.more />
          </button>
          <button
            className="btn green md grow-2"
            disabled={!!busy}
            onClick={() => confirm(p, row.tenantName, { settle: true }).then((ok) => ok && setDone("ok"))}
          >
            {busy === `ok${p.id}` ? (
              <Spinner />
            ) : (
              <>
                <I.check /> {t("Confirm")}
              </>
            )}
          </button>
        </div>
      )}
    </div>
  );
}
