import { degrees, rgb, type PDFFont, type PDFPage, type RGB } from "pdf-lib";
import type { ReceiptModel } from "./models.ts";
import { drawQr } from "./qr.ts";
import {
  BRAND,
  GREEN,
  INK,
  METHOD,
  MUTED,
  ORANGE,
  RED,
  RULE,
  Writer,
  dateLong,
  drawLogo,
  inr,
  monthLong,
  newDoc,
  safe,
} from "./writer.ts";

/*
 * A5 rent receipt in a cut-edge style: every page is a paper slip with torn (zigzag) top and bottom edges on a soft
 * grey sheet, ticket notches at the perforation, and a tear-off verification stub with the QR code. Voided payments
 * keep their receipt; it renders with a VOID stamp and notice.
 */

const A5: [number, number] = [419.53, 595.28];
const SHEET = rgb(0.93, 0.93, 0.95);
const SHADOW = rgb(0.84, 0.84, 0.87);
const PAPER = rgb(1, 1, 1);
const TINT = rgb(0.965, 0.955, 0.99);
/** The slip's left/right edges and the torn edges' top/bottom, in points. */
const SLIP = { left: 30, right: A5[0] - 30, top: A5[1] - 22, bottom: 22 };
const TOOTH = 9; // width of one zigzag tooth
const DEPTH = 4.5; // how far a tooth cuts in

/** A zigzag edge from `x0` to `x1` at height `y`, teeth pointing `dir` (+1 up, -1 down), as SVG commands. */
function zigzag(x0: number, x1: number, y: number, dir: 1 | -1, H: number) {
  const n = Math.max(2, Math.round(Math.abs(x1 - x0) / TOOTH));
  const step = (x1 - x0) / n;
  let d = "";
  for (let i = 0; i < n; i++) {
    const mid = x0 + step * (i + 0.5);
    const end = x0 + step * (i + 1);
    // SVG y runs down from the top of the page.
    d += `L${mid.toFixed(2)} ${(H - (y + dir * DEPTH)).toFixed(2)}L${end.toFixed(2)} ${(H - y).toFixed(2)}`;
  }
  return d;
}

/** The slip outline: torn top edge, straight sides, torn bottom edge. */
function slipPath(H: number) {
  const { left, right, top, bottom } = SLIP;
  return (
    `M${left} ${H - top}` +
    zigzag(left, right, top, 1, H) +
    `L${right} ${H - bottom}` +
    zigzag(right, left, bottom, -1, H) +
    "Z"
  );
}

class ReceiptWriter extends Writer {
  newPage() {
    super.newPage();
    const H = this.size[1];
    const p = this.page;
    p.drawRectangle({ x: 0, y: 0, width: this.size[0], height: H, color: SHEET });
    // A soft drop shadow, then the paper itself.
    p.drawSvgPath(slipPath(H), { x: 1.2, y: H - 1.8, color: SHADOW });
    p.drawSvgPath(slipPath(H), { x: 0, y: H, color: PAPER });
    this.y = H - 40;
  }
  /** The slip's footer sits just above the torn edge, so content may run lower than the letter-style margin. */
  ensure(h: number) {
    if (this.y - h < SLIP.bottom + 30) this.newPage();
  }
  /** Dashed perforation across the slip, with a half-circle ticket notch cut into each side. */
  perforation(label?: string) {
    this.ensure(26);
    this.y -= 10;
    const y = this.y;
    this.page.drawLine({
      start: { x: SLIP.left + 12, y },
      end: { x: SLIP.right - 12, y },
      thickness: 0.8,
      color: rgb(0.7, 0.7, 0.75),
      dashArray: [3.5, 3],
    });
    this.page.drawCircle({ x: SLIP.left, y, size: 7, color: SHEET });
    this.page.drawCircle({ x: SLIP.right, y, size: 7, color: SHEET });
    if (label) {
      const t = safe(label);
      const size = 6.5;
      const tw = this.font.widthOfTextAtSize(t, size);
      const cx = (SLIP.left + SLIP.right) / 2;
      this.page.drawRectangle({ x: cx - tw / 2 - 6, y: y - 4, width: tw + 12, height: 8, color: PAPER });
      this.page.drawText(t, { x: cx - tw / 2, y: y - 2.3, size, font: this.font, color: MUTED });
    }
    this.y -= 14;
  }
  /** Label on the left, value on the right; tighter leading than the letter-style pairs elsewhere. */
  pair(label: string, value: string, o: { bold?: boolean; size?: number } = {}) {
    const size = o.size ?? 9;
    const f = o.bold ? this.bold : this.font;
    const vals = this.wrap(value, size, f, this.w * 0.7);
    this.ensure(size * 1.3 * vals.length + 6);
    this.page.drawText(safe(label), { x: this.m, y: this.y - size, size, font: this.font, color: MUTED });
    vals.forEach((l, i) => {
      this.page.drawText(l, {
        x: this.m + this.w - f.widthOfTextAtSize(l, size),
        y: this.y - size - i * size * 1.3,
        size,
        font: f,
        color: INK,
      });
    });
    this.y -= size * 1.3 * vals.length + size * 0.45;
  }
  /** A thin dotted rule, lighter than a perforation, between groups of lines. */
  dots() {
    this.ensure(10);
    this.y -= 5;
    this.page.drawLine({
      start: { x: this.m, y: this.y },
      end: { x: this.m + this.w, y: this.y },
      thickness: 0.6,
      color: RULE,
      dashArray: [1, 2.2],
    });
    this.y -= 9;
  }
  centered(s: string, o: { size?: number; bold?: boolean; color?: RGB } = {}) {
    const size = o.size ?? 10;
    const f = o.bold ? this.bold : this.font;
    this.ensure(size + 4);
    const t = safe(s);
    const x = (this.size[0] - f.widthOfTextAtSize(t, size)) / 2;
    this.page.drawText(t, { x, y: this.y - size, size, font: f, color: o.color ?? INK });
  }
}

/** A rounded "pill" label (PAID IN FULL, PART PAID, VOID) centred on `cx`. */
function pill(page: PDFPage, bold: PDFFont, text: string, cx: number, top: number, color: RGB) {
  const size = 7.5;
  const t = safe(text);
  const w = bold.widthOfTextAtSize(t, size) + 16;
  const h = 15;
  const x = cx - w / 2;
  const r = h / 2;
  const H = page.getHeight();
  const y0 = H - top;
  page.drawSvgPath(
    `M${x + r} ${y0}H${x + w - r}A${r} ${r} 0 0 1 ${x + w - r} ${y0 + h}H${x + r}A${r} ${r} 0 0 1 ${x + r} ${y0}Z`,
    { x: 0, y: H, color, opacity: 0.12, borderColor: color, borderWidth: 0.8, borderOpacity: 0.6 },
  );
  page.drawText(t, { x: x + 8, y: top - h + 4.6, size, font: bold, color });
}

/** Label/value lines on the slip are a touch smaller than in letters and reports, so a month fits on one A5. */
const PAIR = 9;

export async function renderReceipt(m: ReceiptModel): Promise<Uint8Array> {
  const { doc, font, bold } = await newDoc(`Rent receipt ${m.number}`);
  const w = new ReceiptWriter(doc, font, bold, A5);
  const first = w.page;
  const lines = m.lines ?? [];
  const status = m.voided
    ? { label: "VOID", color: RED }
    : m.balance > 0
      ? { label: "PART PAID", color: ORANGE }
      : { label: "PAID IN FULL", color: GREEN };

  /* ---- Header: logo, wordmark, number and date ---- */
  const top = w.y;
  drawLogo(first, w.m, top, 30);
  first.drawText("pOS", { x: w.m + 38, y: top - 13, size: 14, font: bold, color: BRAND });
  first.drawText("RENT RECEIPT", { x: w.m + 38, y: top - 25, size: 7.5, font: bold, color: MUTED });
  const no = safe(`No. ${m.number}`);
  first.drawText(no, {
    x: w.m + w.w - bold.widthOfTextAtSize(no, 9.5),
    y: top - 11,
    size: 9.5,
    font: bold,
    color: INK,
  });
  const issued = safe(`Issued ${dateLong(m.issuedOn)}`);
  first.drawText(issued, {
    x: w.m + w.w - font.widthOfTextAtSize(issued, 8),
    y: top - 24,
    size: 8,
    font,
    color: MUTED,
  });
  w.y = top - 36;
  w.perforation();

  /* ---- Amount ---- */
  w.centered("AMOUNT RECEIVED", { size: 7.5, bold: true, color: MUTED });
  w.lineDone(7.5, 1.9);
  w.centered(inr(m.amount), { size: 26, bold: true, color: m.voided ? MUTED : INK });
  w.lineDone(26, 1.18);
  for (const l of w.wrap(m.amountWords, 8.5, font, w.w)) {
    w.centered(l, { size: 8.5, color: MUTED });
    w.lineDone(8.5, 1.45);
  }
  w.gap(3);
  pill(w.page, bold, status.label, A5[0] / 2, w.y, status.color);
  w.y -= 17;

  if (m.voided) {
    w.gap(6);
    const when = m.voidedOn ? dateLong(m.voidedOn) : "";
    w.para(
      `VOID: this payment was voided by the landlord${when ? ` on ${when}` : ""}${m.voidReason ? ` (${m.voidReason})` : ""}. It no longer counts toward the rent.`,
      { size: 8.5, bold: true, color: RED, after: 2 },
    );
  }
  w.perforation();

  /* ---- Who, what, where ---- */
  w.pair("Received from", m.tenantName, { bold: true, size: PAIR });
  w.pair(
    "For",
    lines.length > 1 && m.monthTo
      ? m.month.slice(0, 4) === m.monthTo.slice(0, 4)
        ? `Rent, ${monthLong(m.month).split(" ")[0]} to ${monthLong(m.monthTo)} (${lines.length} months)`
        : `Rent, ${monthLong(m.month)} to ${monthLong(m.monthTo)} (${lines.length} months)`
      : `Rent for ${monthLong(m.month)}`,
    { size: PAIR },
  );
  w.pair("Premises", `${m.unitLabel}, ${m.propertyName}`, { size: PAIR });
  if (m.address) w.pair("Address", m.address, { size: PAIR });
  w.dots();
  w.pair("Paid on", `${dateLong(m.paidOn)} · ${METHOD[m.method] ?? m.method}`, { size: PAIR });
  if (m.utr) w.pair("Reference / UTR", m.utr, { size: PAIR });
  if (m.note) w.pair("Note", m.note, { size: PAIR });
  w.dots();

  /* ---- Breakdown ---- */
  if (lines.length) {
    w.text("MONTH-WISE BREAKDOWN", { size: 7.5, bold: true, color: MUTED });
    w.lineDone(7.5, 1.9);
    for (const l of lines) {
      const of =
        l.extra > 0 ? ` of ${inr(l.chargeAmount)} (incl. ${inr(l.extra)} meter)` : ` of ${inr(l.chargeAmount)}`;
      w.pair(monthLong(l.month), `${inr(l.applied)}${of}${l.balance ? ` · ${inr(l.balance)} left` : " · paid"}`, {
        size: 8.5,
      });
    }
    w.dots();
  } else {
    if (m.extra > 0) {
      w.pair("Rent", inr(m.chargeAmount - m.extra), { size: PAIR });
      w.pair("Utilities (meter)", inr(m.extra), { size: PAIR });
    }
    w.pair(`Total for ${monthLong(m.month)}`, inr(m.chargeAmount), { size: PAIR });
    // Only worth a line when earlier payments also went toward the month.
    if (m.paidTotal !== m.amount) w.pair("Paid so far", inr(m.paidTotal), { size: PAIR });
    w.dots();
  }

  // Totals band, tinted like the till total on a shop receipt.
  w.ensure(44);
  const bandTop = w.y + 2;
  const band = lines.length ? 36 : 22;
  w.page.drawRectangle({ x: w.m - 8, y: bandTop - band, width: w.w + 16, height: band, color: TINT });
  w.y -= 5;
  if (lines.length) w.pair("Total received", inr(m.amount), { bold: true, size: 9.5 });
  w.pair(lines.length ? "Balance on these months" : "Balance", m.balance ? inr(m.balance) : "Nil · paid in full", {
    bold: true,
    size: 9.5,
  });
  w.y = Math.min(w.y, bandTop - band - 4);

  /* ---- Signature, then the tear-off verification stub ---- */
  const QR = 54;
  /** Where the stub's perforation sits when the stub is anchored to the foot of the slip. */
  const stubLine = SLIP.bottom + 30 + QR + 16;
  const contact = `Landlord${m.ownerPhone ? ` · ${m.ownerPhone}` : ""}${m.ownerUpi ? ` · UPI ${m.ownerUpi}` : ""}`;
  const signatureH = 44;
  // A long receipt (several months, a void notice) has no room for the stub: the QR then sits beside the signature,
  // so the receipt still prints on one slip.
  const inline = !!m.verifyUrl && w.y - signatureH - 12 < stubLine;
  w.gap(6);
  if (inline) w.ensure(QR + 8);
  const sigTop = w.y;
  const textW = inline ? w.w - QR - 14 : w.w;
  w.text("Received with thanks.", { size: 8.5, color: MUTED });
  w.lineDone(8.5, 1.7);
  w.text(m.ownerName || "Landlord", { bold: true, size: 10.5 });
  w.lineDone(10.5, 1.4);
  for (const l of w.wrap(contact, 8, font, textW)) {
    w.text(l, { size: 8, color: MUTED });
    w.lineDone(8, 1.4);
  }

  if (m.verifyUrl && inline) {
    drawQr(w, m.verifyUrl, w.m + w.w - QR, sigTop, QR);
    const cap = "Scan to verify";
    w.page.drawText(cap, {
      x: w.m + w.w - QR / 2 - bold.widthOfTextAtSize(cap, 7) / 2,
      y: sigTop - QR - 10,
      size: 7,
      font: bold,
      color: BRAND,
    });
    w.y = Math.min(w.y, sigTop - QR - 14);
  } else if (m.verifyUrl) {
    // Anyone holding the paper can scan this to see that pOS issued it, and whether it was later voided.
    w.y = stubLine + 10;
    w.perforation("VERIFICATION STUB");
    const stubTop = w.y;
    drawQr(w, m.verifyUrl, w.m + w.w - QR, stubTop, QR);
    w.text("Scan to verify this receipt", { size: 9.5, bold: true, color: BRAND });
    w.lineDone(9.5, 1.6);
    for (const l of w.wrap(
      `Opens the pOS verification page for receipt ${m.number}: it shows the amount, the date and whether the receipt is still valid.`,
      7.8,
      font,
      w.w - QR - 14,
    )) {
      w.text(l, { size: 7.8, color: MUTED });
      w.lineDone(7.8, 1.45);
    }
  }

  /* ---- VOID stamp across the first slip ---- */
  if (m.voided) {
    first.drawText("VOID", {
      x: 112,
      y: 250,
      size: 96,
      font: bold,
      color: RED,
      opacity: 0.1,
      rotate: degrees(28),
    });
  }

  /* ---- Footer inside each slip, above the torn bottom edge ---- */
  const pages = doc.getPages();
  pages.forEach((pg, i) => {
    const t = safe(
      `Computer-generated receipt from the pOS rent ledger${pages.length > 1 ? ` · Page ${i + 1} of ${pages.length}` : ""}`,
    );
    pg.drawText(t, {
      x: (A5[0] - font.widthOfTextAtSize(t, 6.5)) / 2,
      y: SLIP.bottom + 16,
      size: 6.5,
      font,
      color: MUTED,
    });
  });
  return doc.save();
}
