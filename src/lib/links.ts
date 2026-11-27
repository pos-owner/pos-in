import { monthLabel, rupees } from "./format";

/** upi://pay link understood by GPay, PhonePe, Paytm, BHIM and bank apps. */
export function upiLink(p: { upiId: string; name: string; amount: number; note: string }) {
  const q = new URLSearchParams({ pa: p.upiId, pn: p.name, am: String(p.amount), tn: p.note.slice(0, 50), cu: "INR" });
  return `upi://pay?${q.toString().replace(/\+/g, "%20")}`;
}

function waPhone(phone: string) {
  const d = (phone || "").replace(/\D/g, "");
  if (d.length === 10) return `91${d}`;
  return d.length === 11 && d.startsWith("0") ? `91${d.slice(1)}` : d;
}
/** "5 November" for a YYYY-MM-DD date. UTC, because the date has no time and must not shift with the device's zone. */
const dueLabel = (dueDate: string) =>
  new Date(dueDate).toLocaleDateString("en-IN", { day: "numeric", month: "long", timeZone: "UTC" });
export function whatsappLink(phone: string, text: string) {
  const p = waPhone(phone);
  return `https://wa.me/${p}?text=${encodeURIComponent(text)}`;
}
export function reminderText(
  c: { tenantName: string; month: string; balance: number; dueDate: string; unitLabel: string },
  owner: string,
) {
  const first = c.tenantName.split(/[\s&]/)[0];
  return `Hi ${first}, a gentle reminder that rent for ${c.unitLabel} for ${monthLabel(c.month, true)} (${rupees(c.balance)}) was due on ${dueLabel(c.dueDate)}. You can pay by UPI from the pOS app and tap "I have paid". Thank you! – ${owner}`;
}
export function telLink(phone: string) {
  const d = (phone || "").replace(/[^\d+]/g, "");
  return `tel:${d.length === 12 && d.startsWith("91") ? `+${d}` : d}`;
}
/** Friendly nudge before the due date (the overdue wording lives in `reminderText`). */
export function upcomingReminderText(
  c: { tenantName: string; month: string; balance: number; dueDate: string; unitLabel: string },
  owner: string,
) {
  const first = c.tenantName.split(/[\s&]/)[0];
  return `Hi ${first}, a quick heads-up that rent for ${c.unitLabel} for ${monthLabel(c.month, true)} (${rupees(c.balance)}) is due on ${dueLabel(c.dueDate)}. You can pay by UPI from the pOS app and tap "I have paid". Thank you! – ${owner}`;
}
