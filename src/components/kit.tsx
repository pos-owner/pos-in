import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
  type CSSProperties,
} from "react";
import { createPortal } from "react-dom";
import { NavLink, useNavigate } from "react-router-dom";
import { I, Icon, type IconName } from "./icons";
import { avatarColor, initials } from "../lib/format";
import { haptic } from "../lib/perf";
import { tr, trNode, useLocale, useT } from "../lib/i18n";

/* ---------- Page with collapsing large title ---------- */

export function Page({
  title,
  eyebrow,
  back,
  left,
  right,
  children,
  tabs = true,
  push = false,
  hideLarge = false,
}: {
  title: string;
  eyebrow?: ReactNode;
  back?: boolean | string;
  left?: ReactNode;
  right?: ReactNode;
  children: ReactNode;
  tabs?: boolean;
  push?: boolean;
  hideLarge?: boolean;
}) {
  const sentinel = useRef<HTMLDivElement>(null);
  const [scrolled, setScrolled] = useState(false);
  const nav = useNavigate();
  const t = useT();
  const heading = t(title);
  useEffect(() => {
    const el = sentinel.current;
    if (!el) return;
    // IntersectionObserver instead of scroll listeners: no work on the main thread while scrolling.
    const io = new IntersectionObserver(([e]) => setScrolled(!e.isIntersecting), { rootMargin: "-56px 0px 0px 0px" });
    io.observe(el);
    return () => io.disconnect();
  }, []);
  useEffect(() => {
    document.title = `${heading} · pOS`;
  }, [heading]);
  return (
    <main className={`page ${push ? "push" : "fade"} ${tabs ? "" : "no-tabs"} ${hideLarge ? "hide-large" : ""}`}>
      <header className={`navbar ${scrolled ? "scrolled" : ""} ${hideLarge ? "always" : ""}`}>
        <div className="nav-left">
          {back && (
            <button
              className="circle-btn glass"
              aria-label={t("Back")}
              onClick={() => (typeof back === "string" ? nav(back) : history.length > 1 ? nav(-1) : nav("/"))}
            >
              <I.back />
            </button>
          )}
          {left}
        </div>
        <div className="nav-title">{heading}</div>
        <div className="nav-right">{right}</div>
      </header>
      {!hideLarge && (
        <div className="large-title">
          {eyebrow && <div className="eyebrow">{trNode(eyebrow)}</div>}
          <h1 className="t-large" style={{ margin: 0 }}>
            {heading}
          </h1>
        </div>
      )}
      <div ref={sentinel} style={{ height: 1, marginTop: -1 }} />
      {children}
    </main>
  );
}

export function NavButton({
  icon,
  label,
  onClick,
  accent,
}: {
  icon: IconName;
  label: string;
  onClick: () => void;
  accent?: boolean;
}) {
  const t = useT();
  return (
    <button
      className={`circle-btn ${accent ? "accent" : "glass"}`}
      type="button"
      aria-label={t(label)}
      title={t(label)}
      onClick={() => {
        haptic();
        onClick();
      }}
    >
      <Icon name={icon} />
    </button>
  );
}

/* ---------- Tab bar ---------- */

export interface Tab {
  to: string;
  label: string;
  icon: IconName;
  badge?: number;
  end?: boolean;
}
export function TabBar({ tabs }: { tabs: Tab[] }) {
  const tl = useT();
  return (
    <nav className="tabbar glass" aria-label={tl("Main")}>
      {tabs.map((t) => (
        <NavLink key={t.to} to={t.to} end={t.end} className="tab" onClick={() => haptic()}>
          <Icon name={t.icon} />
          <span>{tl(t.label)}</span>
          {!!t.badge && <span className="badge">{t.badge > 9 ? "9+" : t.badge}</span>}
        </NavLink>
      ))}
    </nav>
  );
}

/* ---------- Lists ---------- */

export function Section({
  title,
  action,
  footer,
  children,
  style,
}: {
  title?: ReactNode;
  action?: ReactNode;
  footer?: ReactNode;
  children: ReactNode;
  style?: CSSProperties;
}) {
  const l = useLocale();
  return (
    <section className="section" style={style}>
      {(title || action) && (
        <div className="section-head">
          {title ? <h2>{trNode(title, l)}</h2> : <span />}
          {action}
        </div>
      )}
      {children}
      {footer && <div className="section-foot">{trNode(footer, l)}</div>}
    </section>
  );
}

export function Row({
  icon,
  iconBg,
  avatar,
  title,
  sub,
  value,
  end,
  chevron,
  onClick,
  to,
  danger,
  center,
  className = "",
}: {
  icon?: IconName;
  iconBg?: string;
  avatar?: string;
  title: ReactNode;
  sub?: ReactNode;
  value?: ReactNode;
  end?: ReactNode;
  chevron?: boolean;
  onClick?: () => void;
  to?: string;
  danger?: boolean;
  center?: boolean;
  className?: string;
}) {
  const nav = useNavigate();
  const l = useLocale();
  const inner = (
    <>
      {icon && (
        <span className="icon-sq" style={{ background: iconBg ?? "var(--accent)" }}>
          <Icon name={icon} />
        </span>
      )}
      {avatar !== undefined && <Avatar name={avatar} />}
      <span className="grow">
        <span className="title" style={{ display: "block" }}>
          {trNode(title, l)}
        </span>
        {sub && (
          <span className="sub" style={{ display: "block" }}>
            {trNode(sub, l)}
          </span>
        )}
      </span>
      {(value !== undefined || end || chevron) && (
        <span className="end">
          {value !== undefined && <span className="value">{value}</span>}
          {end}
          {chevron && <I.chevR className="chev" />}
        </span>
      )}
    </>
  );
  const cls = `row ${danger ? "danger" : ""} ${center ? "center" : ""} ${className}`;
  if (onClick || to) {
    return (
      <button type="button" className={cls} onClick={() => (to ? nav(to) : onClick?.())}>
        {inner}
      </button>
    );
  }
  return <div className={cls}>{inner}</div>;
}

export function Avatar({ name, size }: { name: string; size?: "lg" }) {
  return (
    <span
      className={`avatar ${size ?? ""}`}
      style={{
        background: `linear-gradient(160deg, color-mix(in srgb, ${avatarColor(name)} 80%, white), ${avatarColor(name)})`,
      }}
    >
      {initials(name)}
    </span>
  );
}

/* ---------- Status ---------- */

/**
 * One status language everywhere (Home, Rent, tenant detail, history): the same colour, icon and label for a state.
 * Overdue is the loudest (solid red); "To confirm" is purple so a tenant's claim never looks like a confirmed payment.
 */
const STATUS: Record<string, { label: string; cls: string; icon?: IconName }> = {
  paid: { label: "Paid", cls: "green", icon: "check" },
  due: { label: "Due", cls: "orange", icon: "calendar" },
  upcoming: { label: "Upcoming", cls: "gray" },
  partial: { label: "Partly paid", cls: "orange", icon: "rupee" },
  awaiting: { label: "To confirm", cls: "purple", icon: "clock" },
  overdue: { label: "Overdue", cls: "red solid", icon: "alert" },
  open: { label: "Open", cls: "orange" },
  in_progress: { label: "In progress", cls: "blue" },
  done: { label: "Done", cls: "green", icon: "check" },
  pending: { label: "Pending", cls: "purple", icon: "clock" },
  confirmed: { label: "Confirmed", cls: "green", icon: "check" },
  rejected: { label: "Rejected", cls: "red" },
};
export function StatusPill({ status, label, plain }: { status: string; label?: string; plain?: boolean }) {
  const s = STATUS[status] ?? { label: status, cls: "gray" };
  const t = useT();
  return (
    <span className={`pill ${s.cls}`}>
      {!plain && s.icon && <Icon name={s.icon} />}
      {t(label ?? s.label)}
    </span>
  );
}
export const PRIORITY_COLOR: Record<string, string> = {
  high: "var(--red)",
  medium: "var(--orange)",
  low: "var(--green)",
};
/** Text colours for priority labels: readable on the page and on cards (the bright PRIORITY_COLOR is for dots). */
export const PRIORITY_TEXT: Record<string, string> = {
  high: "var(--red-text)",
  medium: "var(--orange-text)",
  low: "var(--green-text)",
};
const PRIORITY: Record<string, { short: string; long: string; cls: string }> = {
  high: { short: "Urgent", long: "Urgent", cls: "red" },
  medium: { short: "Medium", long: "Medium priority", cls: "orange" },
  low: { short: "Low", long: "Low priority", cls: "green" },
};
/** One wording for priority everywhere ("Urgent", not "High"), in English or Hindi. */
export function priorityLabel(priority: string, long = false): string {
  const p = PRIORITY[priority] ?? PRIORITY.medium;
  return tr(long ? p.long : p.short);
}
export function PriorityPill({ priority }: { priority: string }) {
  useT();
  return <span className={`pill ${(PRIORITY[priority] ?? PRIORITY.medium).cls}`}>{priorityLabel(priority)}</span>;
}

/* ---------- Feedback ---------- */

export function Skeleton({ rows = 3, avatar = true }: { rows?: number; avatar?: boolean }) {
  const t = useT();
  return (
    <div className="list" aria-busy="true" aria-label={t("Loading")}>
      {Array.from({ length: rows }, (_, i) => (
        <div className="sk-row" key={i}>
          {avatar && <div className="sk" style={{ width: 40, height: 40, borderRadius: 20 }} />}
          <div style={{ flex: 1 }}>
            <div className="sk" style={{ height: 14, width: `${60 - i * 7}%` }} />
            <div className="sk" style={{ height: 12, width: `${38 + i * 5}%`, marginTop: 8 }} />
          </div>
          <div className="sk" style={{ height: 22, width: 64, borderRadius: 11 }} />
        </div>
      ))}
    </div>
  );
}
/** Loading placeholder shaped like the screen it stands in for, so nothing jumps when the data arrives. */
export function SkeletonPage({ variant = "home" }: { variant?: "home" | "list" | "detail" }) {
  if (variant === "list")
    return (
      <div className="section stack-12">
        <div className="sk" style={{ height: 36, borderRadius: 18 }} />
        <Skeleton rows={6} />
      </div>
    );
  if (variant === "detail")
    return (
      <div className="section stack-12">
        <div className="sk" style={{ height: 120, borderRadius: 26 }} />
        <div className="sk" style={{ height: 50, borderRadius: 25 }} />
        <Skeleton rows={3} avatar={false} />
      </div>
    );
  return (
    <div className="section stack-12">
      <div className="sk" style={{ height: 96, borderRadius: 26 }} />
      <div className="sk" style={{ height: 150, borderRadius: 28 }} />
      <Skeleton rows={3} />
    </div>
  );
}

export function Empty({
  icon,
  title,
  text,
  action,
}: {
  icon: IconName;
  title: string;
  text: string;
  action?: ReactNode;
}) {
  const t = useT();
  return (
    <div className="empty">
      <div className="em-ic">
        <Icon name={icon} />
      </div>
      <h2>{t(title)}</h2>
      <p>{t(text)}</p>
      {action}
    </div>
  );
}

export function ErrorState({ error, retry }: { error: { message: string; status?: number }; retry?: () => void }) {
  const offline = typeof navigator !== "undefined" && !navigator.onLine;
  const t = useT();
  return (
    <Empty
      icon={offline ? "wifiOff" : "alert"}
      title={offline ? "You're offline" : "Couldn't load this"}
      text={
        offline
          ? "pOS needs a connection to show the latest rent and requests. We'll be ready when you're back online."
          : error.message
      }
      action={
        retry && (
          <button className="btn tinted md auto" onClick={retry}>
            {t("Try again")}
          </button>
        )
      }
    />
  );
}

/* ---------- Toasts ---------- */

type ToastAction = { label: string; run: () => void };
type ToastT = { id: number; text: string; icon: IconName; out?: boolean; action?: ToastAction };
type ToastFn = (text: string, icon?: IconName, action?: ToastAction) => void;
const ToastCtx = createContext<ToastFn>(() => {});
export const useToast = () => useContext(ToastCtx);
export function ToastProvider({ children }: { children: ReactNode }) {
  const [toast, setToast] = useState<ToastT | null>(null);
  const timer = useRef<number>(0);
  const hide = useCallback((id: number) => {
    setToast((t) => (t && t.id === id ? { ...t, out: true } : t));
    timer.current = window.setTimeout(() => setToast((t) => (t && t.id === id ? null : t)), 260);
  }, []);
  const show = useCallback<ToastFn>(
    (text, icon = "checkCircle", action) => {
      clearTimeout(timer.current);
      const id = Date.now();
      setToast({ id, text, icon, action });
      // A toast with a follow-up action (e.g. "Share receipt") stays long enough to reach it.
      timer.current = window.setTimeout(() => hide(id), action ? 5200 : 2400);
    },
    [hide],
  );
  const l = useLocale();
  return (
    <ToastCtx.Provider value={show}>
      {children}
      {toast && (
        <div className={`toast-wrap ${toast.action ? "has-action" : ""}`} role="status" aria-live="polite">
          <div key={toast.id} className={`toast ${toast.out ? "out" : ""}`}>
            <Icon
              name={toast.icon}
              className={toast.icon === "checkCircle" ? "toast-pop" : undefined}
              style={{ color: toast.icon === "alert" ? "#ff6961" : "#30d158" }}
            />
            <span className="toast-text">{trNode(toast.text, l)}</span>
            {toast.action && (
              <button
                type="button"
                className="toast-action"
                onClick={() => {
                  haptic();
                  toast.action?.run();
                  clearTimeout(timer.current);
                  hide(toast.id);
                }}
              >
                {trNode(toast.action.label, l)}
              </button>
            )}
          </div>
        </div>
      )}
    </ToastCtx.Provider>
  );
}

/* ---------- Bottom sheet ---------- */

export function Sheet({
  open,
  onClose,
  title,
  children,
  onDone,
  doneLabel = "Done",
  doneDisabled,
  busy,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  onDone?: () => void;
  doneLabel?: string;
  doneDisabled?: boolean;
  busy?: boolean;
}) {
  const [mounted, setMounted] = useState(false);
  const [closing, setClosing] = useState(false);
  const sheet = useRef<HTMLDivElement>(null);
  const opener = useRef<HTMLElement | null>(null);
  const closeRef = useRef(onClose);
  useLayoutEffect(() => {
    closeRef.current = onClose;
  }, [onClose]);
  const drag = useRef<{ y: number; t: number; dy: number } | null>(null);
  const tl = useT();

  useEffect(() => {
    if (open) {
      if (!mounted && document.activeElement instanceof HTMLElement) opener.current = document.activeElement;
      setMounted(true);
      setClosing(false);
    } else if (mounted) {
      setClosing(true);
      const t = setTimeout(() => {
        setMounted(false);
        setClosing(false);
      }, 270);
      return () => clearTimeout(t);
    }
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  useLayoutEffect(() => {
    const panel = sheet.current;
    if (!mounted || !panel) return;
    const previous = opener.current;
    if (!panel.contains(document.activeElement)) panel.focus();
    const onKey = (e: KeyboardEvent) => {
      const roots = document.querySelectorAll(".sheet-root");
      if (roots[roots.length - 1] !== panel.parentElement || e.defaultPrevented) return;
      if (e.key === "Escape") {
        e.preventDefault();
        closeRef.current();
      } else if (e.key === "Tab") {
        const items = [
          ...panel.querySelectorAll<HTMLElement>("button, a[href], input, select, textarea, [tabindex]"),
        ].filter(
          (item) =>
            item.tabIndex >= 0 &&
            !item.matches(":disabled") &&
            !item.closest("[inert]") &&
            item.getClientRects().length > 0 &&
            getComputedStyle(item).visibility === "visible",
        );
        const first = items[0];
        const last = items.at(-1);
        const active = document.activeElement;
        if (!first || !panel.contains(active) || active === panel || active === (e.shiftKey ? first : last)) {
          e.preventDefault();
          ((e.shiftKey ? last : first) ?? panel).focus();
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      const active = document.activeElement;
      if ((active === document.body || panel.contains(active)) && previous?.isConnected) previous.focus();
    };
  }, [mounted]);

  if (!mounted) return null;

  const onDown = (e: React.PointerEvent) => {
    if ((e.target as HTMLElement).closest("button")) return;
    drag.current = { y: e.clientY, t: performance.now(), dy: 0 };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };
  const onMove = (e: React.PointerEvent) => {
    if (!drag.current || !sheet.current) return;
    const dy = Math.max(0, e.clientY - drag.current.y);
    drag.current.dy = dy;
    sheet.current.style.transform = `translate3d(0, ${dy}px, 0)`;
    sheet.current.style.animation = "none";
  };
  const onUp = () => {
    const d = drag.current;
    drag.current = null;
    if (!d || !sheet.current) return;
    const v = d.dy / Math.max(1, performance.now() - d.t);
    if (d.dy > 120 || v > 0.6) {
      sheet.current.style.transition = "transform 0.25s var(--ease)";
      sheet.current.style.transform = "translate3d(0, 105%, 0)";
      setTimeout(onClose, 200);
    } else {
      sheet.current.style.transition = "transform 0.4s var(--spring)";
      sheet.current.style.transform = "";
    }
  };

  return createPortal(
    <div className={`sheet-root ${closing ? "closing" : ""}`} role="dialog" aria-modal="true" aria-label={tl(title)}>
      <div className="scrim" onClick={onClose} />
      <div ref={sheet} tabIndex={-1} className={`sheet ${closing ? "closing" : ""}`}>
        <div
          className="sheet-head"
          onPointerDown={onDown}
          onPointerMove={onMove}
          onPointerUp={onUp}
          onPointerCancel={onUp}
        >
          <button className="circle-btn plain" aria-label={tl("Close")} onClick={onClose}>
            <I.x />
          </button>
          <h3>{tl(title)}</h3>
          {onDone ? (
            <button
              className="circle-btn accent"
              aria-label={tl(doneLabel)}
              disabled={doneDisabled || busy}
              style={{ opacity: doneDisabled ? 0.35 : 1 }}
              onClick={() => {
                haptic();
                onDone();
              }}
            >
              {busy ? <Spinner /> : <I.check />}
            </button>
          ) : (
            <span />
          )}
        </div>
        <div className="sheet-body">{children}</div>
      </div>
    </div>,
    document.body,
  );
}

export function Spinner({ size = 20 }: { size?: number }) {
  const t = useT();
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      aria-label={t("Working")}
      style={{ animation: "spin 0.8s linear infinite" }}
    >
      <style>{"@keyframes spin{to{transform:rotate(360deg)}}"}</style>
      <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" strokeOpacity=".25" strokeWidth="3" />
      <path d="M21 12a9 9 0 0 0-9-9" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}

/* ---------- Form controls ---------- */

export function Field({
  label,
  value,
  onChange,
  type = "text",
  placeholder,
  stack,
  inputMode,
  prefix,
  big,
  autoFocus,
  maxLength,
  autoComplete,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  type?: string;
  placeholder?: string;
  stack?: boolean;
  inputMode?: "numeric" | "tel" | "email" | "text" | "decimal";
  prefix?: string;
  big?: boolean;
  autoFocus?: boolean;
  maxLength?: number;
  autoComplete?: string;
}) {
  const id = useRef(`f${Math.random().toString(36).slice(2, 8)}`).current;
  const t = useT();
  placeholder = placeholder && t(placeholder);
  return (
    <div className={`field ${stack || big ? "stack" : ""} ${big ? "big" : ""}`}>
      <label htmlFor={id}>{t(label)}</label>
      <div className="hstack" style={{ flex: 1, gap: 4 }}>
        {prefix && <span className="prefix">{prefix}</span>}
        {type === "textarea" ? (
          <textarea
            id={id}
            value={value}
            placeholder={placeholder}
            onChange={(e) => onChange(e.target.value)}
            maxLength={maxLength}
          />
        ) : (
          <input
            id={id}
            type={type}
            value={value}
            placeholder={placeholder}
            inputMode={inputMode}
            autoFocus={autoFocus}
            maxLength={maxLength}
            autoComplete={autoComplete}
            onChange={(e) => onChange(e.target.value)}
          />
        )}
      </div>
    </div>
  );
}

export function SelectField<T extends string | number>({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: T;
  onChange: (v: T) => void;
  options: { value: T; label: string }[];
}) {
  const id = useRef(`s${Math.random().toString(36).slice(2, 8)}`).current;
  const t = useT();
  return (
    <div className="field">
      <label htmlFor={id}>{t(label)}</label>
      <select
        id={id}
        value={String(value)}
        onChange={(e) => {
          const o = options.find((x) => String(x.value) === e.target.value);
          if (o) onChange(o.value);
        }}
      >
        {options.map((o) => (
          <option key={String(o.value)} value={String(o.value)}>
            {t(o.label)}
          </option>
        ))}
      </select>
    </div>
  );
}

export function Toggle({
  label,
  sub,
  checked,
  onChange,
  disabled = false,
}: {
  label: string;
  sub?: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
}) {
  const t = useT();
  return (
    <label className={`row${disabled ? " is-disabled" : ""}`} style={{ cursor: disabled ? "default" : "pointer" }}>
      <span className="grow">
        <span className="title" style={{ display: "block" }}>
          {t(label)}
        </span>
        {sub && (
          <span className="sub" style={{ display: "block", whiteSpace: "normal" }}>
            {t(sub)}
          </span>
        )}
      </span>
      <span className="switch">
        <input
          type="checkbox"
          role="switch"
          aria-label={t(label)}
          checked={checked}
          disabled={disabled}
          onChange={(e) => {
            haptic();
            onChange(e.target.checked);
          }}
        />
        <span />
      </span>
    </label>
  );
}

export function Segmented<T extends string>({
  value,
  onChange,
  options,
  label,
}: {
  value: T;
  onChange: (v: T) => void;
  options: { value: T; label: string }[];
  label: string;
}) {
  const i = Math.max(
    0,
    options.findIndex((o) => o.value === value),
  );
  const t = useT();
  return (
    <div
      className="seg"
      role="group"
      aria-label={t(label)}
      style={{ "--n": options.length, "--i": i } as CSSProperties}
    >
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          aria-pressed={o.value === value}
          onClick={() => {
            haptic();
            onChange(o.value);
          }}
        >
          {t(o.label)}
        </button>
      ))}
    </div>
  );
}

export function FormError({ text }: { text: string }) {
  const t = useT();
  return text ? (
    <div className="form-error" role="alert">
      {t(text)}
    </div>
  ) : null;
}

/* ---------- QR (generator is loaded on demand) ---------- */

export function QR({ text, label }: { text: string; label: string }) {
  const [svg, setSvg] = useState("");
  useEffect(() => {
    let alive = true;
    import("qrcode-generator").then(({ default: qrcode }) => {
      const q = qrcode(0, "M");
      q.addData(text);
      q.make();
      const n = q.getModuleCount();
      let d = "";
      for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (q.isDark(r, c)) d += `M${c} ${r}h1v1h-1z`;
      if (alive)
        setSvg(
          `<svg xmlns="http://www.w3.org/2000/svg" viewBox="-2 -2 ${n + 4} ${n + 4}" shape-rendering="crispEdges"><path fill="#0b0b0f" d="${d}"/></svg>`,
        );
    });
    return () => {
      alive = false;
    };
  }, [text]);
  return (
    <div className="qr" role="img" aria-label={label}>
      {svg ? <div dangerouslySetInnerHTML={{ __html: svg }} /> : <div className="sk" style={{ aspectRatio: "1" }} />}
    </div>
  );
}

export async function copyText(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

export function Lightbox({ src, onClose }: { src: string | null; onClose: () => void }) {
  if (!src) return null;
  return createPortal(
    <div className="lightbox" onClick={onClose} role="dialog" aria-label="Photo">
      <img src={src} alt="" />
      <button
        className="circle-btn glass"
        style={{ position: "absolute", top: "calc(var(--safe-t) + 12px)", right: 16, color: "#fff" }}
        aria-label="Close"
      >
        <I.x />
      </button>
    </div>,
    document.body,
  );
}
