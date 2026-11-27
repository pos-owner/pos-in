const inr = new Intl.NumberFormat("en-IN", { maximumFractionDigits: 0 });
export const rupees = (n: number | undefined | null) => `₹${inr.format(n ?? 0)}`;

/** Parse a rent or deposit field without silently turning mistyped amounts into zero. */
export function parseRentAmount(input: string, minimum = 0): number | null {
  const text = input.replace(/[,\s]/g, "");
  if (!text && !input.trim() && minimum === 0) return 0;
  if (!/^\d+(?:\.\d+)?$/.test(text)) return null;
  const rounded = Math.round(Number(text));
  return rounded >= minimum && rounded <= 100_000_000 ? rounded : null;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const MONTHS_LONG = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];
export function monthLabel(m: string, long = false) {
  const [y, mm] = m.split("-").map(Number);
  return `${(long ? MONTHS_LONG : MONTHS)[mm - 1]} ${y}`;
}
export function monthName(m: string) {
  return MONTHS_LONG[Number(m.split("-")[1]) - 1];
}
export function dateLabel(d: string | null | undefined, withYear = false) {
  if (!d) return "";
  const [y, m, day] = d.slice(0, 10).split("-").map(Number);
  return `${day} ${MONTHS[m - 1]}${withYear ? ` ${y}` : ""}`;
}
export function todayISO() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date());
}
export function daysFromToday(d: string) {
  return Math.round((Date.parse(d) - Date.parse(todayISO())) / 86400000);
}
export function relTime(iso: string | Date) {
  const t = typeof iso === "string" ? Date.parse(iso) : iso.getTime();
  const s = Math.max(0, (Date.now() - t) / 1000);
  if (s < 60) return "Just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 86400 * 7) return `${Math.floor(s / 86400)}d ago`;
  return dateLabel(new Date(t).toISOString(), true);
}
/**
 * How recently someone in the workspace used pOS, for the owner's people list: "Active 3h ago",
 * "Active 12 Nov 2025 · signed out" when no device is signed in any more, "Not signed in" when never seen.
 */
export function activityLabel(lastActiveAt: string | null | undefined, devices: number) {
  if (!lastActiveAt) return devices ? "Signed in" : "Not signed in";
  const r = relTime(lastActiveAt);
  const when = r === "Just now" ? "Active just now" : /ago$/.test(r) ? `Active ${r}` : `Last active ${r}`;
  return devices ? when : `${when} · signed out`;
}
export function greeting() {
  const h = Number(
    new Intl.DateTimeFormat("en-GB", { hour: "numeric", hourCycle: "h23", timeZone: "Asia/Kolkata" }).format(
      new Date(),
    ),
  );
  return h < 12 ? "Good morning" : h < 17 ? "Good afternoon" : "Good evening";
}
export function longToday() {
  return new Intl.DateTimeFormat("en-IN", {
    weekday: "long",
    day: "numeric",
    month: "long",
    timeZone: "Asia/Kolkata",
  }).format(new Date());
}
export function firstName(n: string) {
  return (n || "").split(/[\s&]/)[0];
}
export function initials(n: string) {
  const parts = (n || "?").replace(/&/g, " ").split(/\s+/).filter(Boolean);
  return ((parts[0]?.[0] ?? "") + (parts.length > 1 ? parts[parts.length - 1][0] : "")).toUpperCase();
}
const AV = ["#ff9f0a", "#30b0c7", "#5856d6", "#34c759", "#ff2d55", "#af52de", "#007aff", "#a2845e", "#00c7be"];
export function avatarColor(n: string) {
  let h = 0;
  for (const ch of n) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return AV[h % AV.length];
}
export function ordinal(n: number) {
  const s = ["th", "st", "nd", "rd"],
    v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

/** Shows an Indian mobile number the way people read it: "+91 98450 12376". Other numbers are left as entered. */
export function phoneLabel(p: string | null | undefined) {
  const raw = (p ?? "").trim();
  const d = raw.replace(/\D/g, "");
  const local =
    d.length === 12 && d.startsWith("91") ? d.slice(2) : d.length === 11 && d.startsWith("0") ? d.slice(1) : d;
  return local.length === 10 ? `+91 ${local.slice(0, 5)} ${local.slice(5)}` : raw;
}

/** "Part of ₹30,000 · Nov 2026 – Jan 2027": one month's share of a multi-month payment. */
export function batchNote(b: { amount: number; months: number; from: string; to: string } | null | undefined) {
  if (!b || b.months < 2) return "";
  const span =
    b.from && b.to ? (b.from === b.to ? monthLabel(b.from) : `${monthLabel(b.from)} – ${monthLabel(b.to)}`) : "";
  return `Part of ${rupees(b.amount)} for ${b.months} months${span ? ` · ${span}` : ""}`;
}

/** Next rent due date (YYYY-MM-DD) after `today`, for a tenancy due on `dueDay` each month. */
export function nextDueDate(today: string, dueDay: number): string {
  const [y, m] = today.split("-").map(Number);
  const make = (yy: number, mm: number) => {
    const last = new Date(Date.UTC(yy, mm, 0)).getUTCDate();
    return `${yy}-${String(mm).padStart(2, "0")}-${String(Math.min(dueDay, last)).padStart(2, "0")}`;
  };
  // Only used when nothing is outstanding, so this month is settled and the next charge is next month.
  return m === 12 ? make(y + 1, 1) : make(y, m + 1);
}
