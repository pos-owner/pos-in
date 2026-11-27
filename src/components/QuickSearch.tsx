import { useCallback, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { useNavigate } from "react-router-dom";
import { useApi } from "../lib/api";
import { useAuth } from "../lib/auth";
import { features } from "../lib/features";
import { phoneLabel, rupees } from "../lib/format";
import { telLink } from "../lib/links";
import { haptic } from "../lib/perf";
import type { RequestListItem, TenantListItem } from "../lib/types";
import { Icon, I, type IconName } from "./icons";
import "../styles/quicksearch.css";

/*
 * Quick search: one box to jump anywhere. ⌘K / Ctrl+K (or "/") opens it from any screen; owners also get a search
 * button on Home. It finds tenants (by name, unit, property or phone), maintenance requests, screens and common
 * actions, ranks them by how well they match, and remembers the last few things opened on this device.
 */

type Item = {
  id: string;
  group: "Recent" | "Actions" | "Tenants" | "Requests" | "Go to";
  title: string;
  sub?: string;
  icon: IconName;
  tint: string;
  to: string;
  /** Extra words that should match (phone digits, synonyms). */
  keywords?: string;
  /** A trailing quick action (call the tenant). */
  tel?: string;
};

const RECENT_KEY = "pos.recent";
const ORDER: Item["group"][] = ["Recent", "Actions", "Tenants", "Requests", "Go to"];

function readRecent(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(RECENT_KEY) || "[]");
    return Array.isArray(v) ? v.filter((x) => typeof x === "string").slice(0, 5) : [];
  } catch {
    return [];
  }
}
function pushRecent(id: string) {
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify([id, ...readRecent().filter((x) => x !== id)].slice(0, 5)));
  } catch {
    /* storage blocked */
  }
}

const norm = (s: string) => s.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "");

/** 0 = no match. Higher is better: title prefix beats word prefix beats anywhere; every word typed must match. */
function score(item: Pick<Item, "title" | "sub" | "keywords">, query: string): number {
  const words = norm(query).split(/\s+/).filter(Boolean);
  if (!words.length) return 1;
  const title = norm(item.title);
  const hay = `${title} ${norm(item.sub ?? "")} ${norm(item.keywords ?? "")}`;
  let total = 0;
  for (const w of words) {
    const digits = w.replace(/\D/g, "");
    if (title.startsWith(w)) total += 6;
    else if (new RegExp(`(^|[\\s,·(-])${w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`).test(hay)) total += 4;
    else if (hay.includes(w)) total += 2;
    else if (digits.length >= 4 && hay.replace(/\D/g, "").includes(digits)) total += 3;
    else return 0;
  }
  return total;
}

function useItems(open: boolean) {
  const { me } = useAuth();
  const role = me?.profile?.role ?? "owner";
  const tenants = useApi<TenantListItem[]>(open && role === "owner" ? "/api/tenants" : null);
  const requests = useApi<RequestListItem[]>(open ? "/api/requests" : null);

  return useMemo(() => {
    const items: Item[] = [];
    const go = (title: string, to: string, icon: IconName, tint: string, keywords = "") =>
      items.push({ id: `go:${to}`, group: "Go to", title, to, icon, tint, keywords });
    const act = (title: string, to: string, icon: IconName, tint: string, keywords = "") =>
      items.push({ id: `act:${to}`, group: "Actions", title, to, icon, tint, keywords });

    if (role === "owner") {
      act("Add a tenant", "/tenants?new=1", "userPlus", "var(--green)", "new tenant lease move in");
      act("Raise a maintenance request", "/requests?new=1", "wrench", "var(--orange)", "repair complaint issue new");
      act("Add a property", "/more/properties?new=1", "building", "var(--indigo)", "new unit flat house");
      act("Invite someone", "/more/invites?new=1", "send", "var(--teal)", "staff tenant join link");
      act("Verify a receipt", "/verify", "shield", "var(--purple)", "check qr genuine");
      go("Home", "/", "home", "var(--accent)", "dashboard today");
      go("Rent", "/rent", "rupee", "var(--green)", "ledger due overdue collect payments");
      go("Tenants", "/tenants", "people", "var(--accent)");
      go("Requests", "/requests", "wrench", "var(--orange)", "maintenance");
      go("Properties and units", "/more/properties", "building", "var(--indigo)");
      go("Expenses", "/more/expenses", "wallet", "var(--brown)", "costs bills spend");
      go("Invites", "/more/invites", "send", "var(--teal)");
      go("Receipts and documents", "/more/receipts", "receipt", "var(--purple)", "pdf agreement");
      if (features.meterReadings) go("Meter readings", "/more/meters", "gauge", "var(--yellow)", "electricity water");
      go("Automations", "/more/automations", "bolt", "var(--orange)", "reminders late fee");
      go("Reports", "/more/reports", "chart", "var(--accent)", "income profit tax");
      go("Recurring charges", "/more/recurring", "calendar", "var(--mint)", "maintenance parking");
      go("Statements", "/more/statements", "receipt", "var(--indigo)");
      go("Unit QR codes", "/more/qr", "qr", "var(--label)", "print sticker");
      go("Backup", "/more/backup", "cloudUp", "var(--gray-text)", "export json download");
    } else if (role === "staff") {
      act("Raise a maintenance request", "/requests?new=1", "wrench", "var(--orange)", "repair new");
      go("Today", "/", "home", "var(--accent)");
      go("Requests", "/requests", "wrench", "var(--orange)", "maintenance");
      go("Units", "/units", "building", "var(--indigo)");
      if (features.meterReadings) go("Meter readings", "/meters", "gauge", "var(--yellow)", "electricity water");
      go("Expenses", "/expenses", "wallet", "var(--brown)");
    } else {
      act("Raise a maintenance request", "/requests?new=1", "wrench", "var(--orange)", "repair complaint new");
      go("Home", "/", "home", "var(--accent)", "pay rent due");
      go("Payment history", "/history", "clock", "var(--green)", "receipts paid");
      go("Requests", "/requests", "wrench", "var(--orange)");
      go("My lease", "/lease", "key", "var(--indigo)", "agreement");
      go("Statements", "/statements", "receipt", "var(--purple)");
      go("Profile", "/profile", "person", "var(--accent)");
    }
    go("Notifications", "/notifications", "inbox", "var(--red)");
    go("Settings", "/settings", "gear", "var(--gray-text)", "display theme dark text size contrast language password");

    for (const t of tenants.data ?? []) {
      const bits = [t.unitLabel && `${t.unitLabel}${t.propertyName ? `, ${t.propertyName}` : ""}`];
      if (t.overdue && t.balance) bits.push(`${rupees(t.balance)} overdue`);
      else if (t.awaiting) bits.push("payment to confirm");
      else if (!t.active) bits.push("moved out");
      items.push({
        id: `t:${t.id}`,
        group: "Tenants",
        title: t.fullName,
        sub: bits.filter(Boolean).join(" · ") || phoneLabel(t.phone),
        icon: "person",
        tint: t.overdue ? "var(--red)" : t.awaiting ? "var(--purple)" : "var(--accent)",
        to: `/tenants/${t.id}`,
        keywords: `${t.phone} ${t.propertyName} ${t.unitLabel}`,
        tel: t.phone || undefined,
      });
    }
    for (const r of requests.data ?? []) {
      items.push({
        id: `r:${r.id}`,
        group: "Requests",
        title: r.title,
        sub: [r.unitLabel, r.status.replace(/_/g, " "), r.priority === "high" ? "urgent" : ""]
          .filter(Boolean)
          .join(" · "),
        icon: "wrench",
        tint: r.priority === "high" ? "var(--red)" : "var(--orange)",
        to: `/requests/${r.id}`,
        keywords: `${r.propertyName} ${r.raisedByName} ${r.assignedName} ${r.status}`,
      });
    }
    return { items, loading: tenants.loading || requests.loading };
  }, [role, tenants.data, tenants.loading, requests.data, requests.loading]);
}

/** Opens the quick search from anywhere with ⌘K / Ctrl+K or "/" (when not typing in a field). */
function useQuickSearchHotkey(setOpen: (v: boolean) => void) {
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      const typing = !!el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName));
      if ((e.key === "k" || e.key === "K") && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        setOpen(true);
      } else if (e.key === "/" && !typing && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault();
        setOpen(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [setOpen]);
}

/* A tiny shared open/close store, so the Home button and the global hotkey drive the same dialog. */
let openState = false;
const subs = new Set<(v: boolean) => void>();
export function openQuickSearch(v = true) {
  openState = v;
  subs.forEach((f) => f(v));
}

/** Mounted once per signed-in app (App.tsx). */
export function QuickSearch() {
  const [open, setOpen] = useState(openState);
  useEffect(() => {
    subs.add(setOpen);
    return () => {
      subs.delete(setOpen);
    };
  }, []);
  const set = useCallback((v: boolean) => openQuickSearch(v), []);
  useQuickSearchHotkey(set);
  if (!open) return null;
  return createPortal(<Palette onClose={() => set(false)} />, document.body);
}

function Palette({ onClose }: { onClose: () => void }) {
  const nav = useNavigate();
  const { items, loading } = useItems(true);
  const [q, setQ] = useState("");
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const returnTo = useRef<Element | null>(document.activeElement);
  const id = useId();

  useEffect(() => {
    input.current?.focus();
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const back = returnTo.current;
    return () => {
      document.body.style.overflow = prev;
      if (back instanceof HTMLElement) back.focus();
    };
  }, []);

  const results = useMemo(() => {
    const query = q.trim();
    if (!query) {
      const recent = readRecent()
        .map((rid) => items.find((i) => i.id === rid))
        .filter((i): i is Item => !!i)
        .map((i) => ({ ...i, group: "Recent" as const }));
      const shown = new Set(recent.map((r) => r.id));
      return [
        ...recent,
        ...items.filter((i) => i.group === "Actions" && !shown.has(i.id)),
        ...items.filter((i) => i.group === "Go to" && !shown.has(i.id)).slice(0, 6),
      ];
    }
    return items
      .map((i) => ({ i, s: score(i, query) }))
      .filter((x) => x.s > 0)
      .sort((a, b) => ORDER.indexOf(a.i.group) - ORDER.indexOf(b.i.group) || b.s - a.s)
      .reduce<Item[]>((acc, x) => {
        // At most 6 per group keeps the list scannable.
        if (acc.filter((y) => y.group === x.i.group).length < 6) acc.push(x.i);
        return acc;
      }, []);
  }, [q, items]);

  useEffect(() => setActive(0), [q]);
  useEffect(() => {
    list.current?.querySelector<HTMLElement>(`[data-i="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active]);

  const choose = (item: Item | undefined) => {
    if (!item) return;
    haptic();
    pushRecent(item.id);
    onClose();
    nav(item.to);
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((a) => Math.min(results.length - 1, a + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => Math.max(0, a - 1));
    } else if (e.key === "Home" && results.length) {
      setActive(0);
    } else if (e.key === "End" && results.length) {
      setActive(results.length - 1);
    } else if (e.key === "Enter") {
      e.preventDefault();
      choose(results[active]);
    } else if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    } else if (e.key === "Tab") {
      // Keep focus inside the dialog: the input is the only stop, the list is driven by the arrows.
      e.preventDefault();
    }
  };

  let lastGroup = "";
  return (
    <div className="qs-root" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="qs" role="dialog" aria-modal="true" aria-label="Quick search">
        <div className="qs-bar">
          <I.search aria-hidden="true" />
          <input
            ref={input}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Search tenants, requests, screens…"
            role="combobox"
            aria-expanded="true"
            aria-controls={`${id}-list`}
            aria-activedescendant={results[active] ? `${id}-${active}` : undefined}
            aria-autocomplete="list"
            autoComplete="off"
            spellCheck={false}
            enterKeyHint="go"
          />
          <button className="qs-close" onClick={onClose} aria-label="Close search">
            <span aria-hidden="true">Esc</span>
          </button>
        </div>
        <div className="qs-list" id={`${id}-list`} role="listbox" aria-label="Results" ref={list}>
          {results.map((r, i) => {
            const head = r.group !== lastGroup ? r.group : "";
            lastGroup = r.group;
            return (
              <div key={`${r.group}-${r.id}`} role="presentation">
                {head && (
                  <div className="qs-group" role="presentation">
                    {head}
                  </div>
                )}
                <div
                  id={`${id}-${i}`}
                  data-i={i}
                  role="option"
                  aria-selected={i === active}
                  className={`qs-item ${i === active ? "on" : ""}`}
                  onMouseMove={() => i !== active && setActive(i)}
                  onClick={() => choose(r)}
                >
                  <span className="qs-ic" style={{ background: r.tint }}>
                    <Icon name={r.icon} />
                  </span>
                  <span className="qs-text">
                    <span className="qs-title">{r.title}</span>
                    {r.sub && <span className="qs-sub">{r.sub}</span>}
                  </span>
                  {r.tel && (
                    <a
                      className="qs-call"
                      href={telLink(r.tel)}
                      onClick={(e) => e.stopPropagation()}
                      aria-label={`Call ${r.title}`}
                      tabIndex={-1}
                    >
                      <I.phone aria-hidden="true" />
                    </a>
                  )}
                  {i === active && (
                    <span className="qs-enter" aria-hidden="true">
                      ↵
                    </span>
                  )}
                </div>
              </div>
            );
          })}
          {!results.length && (
            <div className="qs-empty" role="status">
              {loading ? "Searching…" : `Nothing matches “${q.trim()}”. Try a name, unit, phone number or screen.`}
            </div>
          )}
        </div>
        <div className="qs-foot" aria-hidden="true">
          <span>
            <kbd>↑</kbd>
            <kbd>↓</kbd> move
          </span>
          <span>
            <kbd>↵</kbd> open
          </span>
          <span>
            <kbd>Esc</kbd> close
          </span>
          <span className="qs-tip">
            <kbd>/</kbd> or <kbd>Ctrl K</kbd> anywhere
          </span>
        </div>
      </div>
    </div>
  );
}
