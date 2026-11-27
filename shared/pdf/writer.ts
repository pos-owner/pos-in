/**
 * The small PDF layout kit used for receipts, rental agreements and reports. It runs in the browser: the API sends
 * the document's data as JSON and the phone draws the PDF, so the Worker stays inside the free plan's CPU limit
 * and doesn't ship pdf-lib at all. Loaded on demand (see src/lib/pdf.ts), so it never slows down app start.
 */
import { LineCapStyle, PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from "pdf-lib";

const MONTHS = [
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
export const monthLong = (m: string) => `${MONTHS[Number(m.slice(5, 7)) - 1]} ${m.slice(0, 4)}`;
export const dateLong = (d: string) =>
  `${Number(d.slice(8, 10))} ${MONTHS[Number(d.slice(5, 7)) - 1]} ${d.slice(0, 4)}`;
export const inr = (n: number) => `Rs. ${new Intl.NumberFormat("en-IN").format(n)}`;
export const ordinal = (n: number) => {
  const s = ["th", "st", "nd", "rd"],
    v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
};
export const METHOD: Record<string, string> = { upi: "UPI", cash: "Cash", bank: "Bank transfer" };

/** Standard PDF fonts only cover WinAnsi (Latin-1 plus a few typographic marks). */
const WIN_EXTRA = new Set("–—‘’“”•…€".split(""));
/**
 * Makes text drawable with the standard fonts, on one line: ₹ becomes "Rs.", accents are dropped (José → Jose),
 * line breaks and tabs become spaces, invisible control/format characters are removed and anything else the
 * font can't encode becomes "?". pdf-lib throws on unencodable characters, which would fail the whole PDF.
 */
export function safe(s: string) {
  const flat = String(s ?? "")
    .replace(/₹/g, "Rs.")
    .replace(/[\t\n\v\f\r\u0085\u2028\u2029]+/g, " ")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "");
  return Array.from(flat)
    .map((ch) => {
      const c = ch.codePointAt(0)!;
      if ((c >= 0x20 && c < 0x7f) || (c >= 0xa0 && c < 0x100 && c !== 0xad) || WIN_EXTRA.has(ch)) return ch;
      return /[\p{Cc}\p{Cf}\p{M}]/u.test(ch) ? "" : "?";
    })
    .join("");
}

export const INK = rgb(0.07, 0.07, 0.09);
export const MUTED = rgb(0.42, 0.42, 0.47);
export const ACCENT = rgb(0.04, 0.48, 1);
export const RULE = rgb(0.86, 0.86, 0.89);
/** Brand colours, taken from the app icon (public/icons/icon.svg). */
export const BRAND = rgb(0.294, 0.173, 0.561); // #4b2c8f
const BRAND_INK = rgb(0.227, 0.165, 0.471); // #3a2a78
const CORAL = rgb(1, 0.553, 0.38); // #ff8d61
export const GREEN = rgb(0.098, 0.533, 0.255);
export const RED = rgb(0.8, 0.1, 0.12);
export const ORANGE = rgb(0.75, 0.42, 0.02);

/*
 * The pOS mark drawn as vectors (no image embedding, so it stays sharp when printed and adds no weight): the same
 * house, rupee and "paid" coin as the app icon, on the brand's indigo tile.
 * Paths are in the icon's 512-unit space; pdf-lib flips the y axis for SVG paths.
 */
const LOGO = {
  tile: "M115 0H397A115 115 0 0 1 512 115V397A115 115 0 0 1 397 512H115A115 115 0 0 1 0 397V115A115 115 0 0 1 115 0Z",
  house:
    "M256 104c7.6 0 15 2.7 20.9 7.7l118 100.4c9.9 8.4 15.6 20.7 15.6 33.7V372c0 24.3-19.7 44-44 44H145.5c-24.3 0-44-19.7-44-44V245.8c0-13 5.7-25.3 15.6-33.7l118-100.4c5.9-5 13.3-7.7 20.9-7.7z",
  rupee: "M206 236h100M206 276h100M214 236h22c30 0 48 17 48 40s-18 40-48 40h-22l78 74",
  check: "M352 146l14 14 26-28",
};

/** Draws the pOS mark `size` points wide with its top-left corner at (`x`, `top`). */
export function drawLogo(page: PDFPage, x: number, top: number, size: number) {
  const scale = size / 512;
  const at = { x, y: top, scale };
  page.drawSvgPath(LOGO.tile, { ...at, color: BRAND });
  page.drawSvgPath(LOGO.house, { ...at, color: rgb(1, 1, 1) });
  page.drawSvgPath(LOGO.rupee, {
    ...at,
    borderColor: BRAND_INK,
    borderWidth: 24,
    borderLineCap: LineCapStyle.Round,
  });
  page.drawCircle({
    x: x + 372 * scale,
    y: top - 146 * scale,
    size: 46 * scale,
    color: CORAL,
    borderColor: rgb(1, 1, 1),
    borderWidth: 10 * scale,
  });
  page.drawSvgPath(LOGO.check, {
    ...at,
    borderColor: rgb(1, 1, 1),
    borderWidth: 12,
    borderLineCap: LineCapStyle.Round,
  });
}

export class Writer {
  page!: PDFPage;
  y = 0;
  readonly m = 56;
  doc: PDFDocument;
  font: PDFFont;
  bold: PDFFont;
  size: [number, number];
  /* Plain fields instead of constructor parameter properties, so Node can run this file by stripping types. */
  constructor(doc: PDFDocument, font: PDFFont, bold: PDFFont, size: [number, number] = [595.28, 841.89]) {
    this.doc = doc;
    this.font = font;
    this.bold = bold;
    this.size = size;
    this.newPage();
  }
  get w() {
    return this.size[0] - this.m * 2;
  }
  newPage() {
    this.page = this.doc.addPage(this.size);
    this.y = this.size[1] - this.m;
  }
  ensure(h: number) {
    if (this.y - h < this.m) this.newPage();
  }
  gap(h: number) {
    this.y -= h;
  }
  text(
    s: string,
    o: { size?: number; bold?: boolean; color?: ReturnType<typeof rgb>; x?: number; right?: boolean } = {},
  ) {
    const size = o.size ?? 10;
    const f = o.bold ? this.bold : this.font;
    const t = safe(s);
    this.ensure(size + 4);
    const x = o.right ? this.m + this.w - f.widthOfTextAtSize(t, size) : this.m + (o.x ?? 0);
    this.page.drawText(t, { x, y: this.y - size, size, font: f, color: o.color ?? INK });
  }
  lineDone(size = 10, lead = 1.45) {
    this.y -= size * lead;
  }
  wrap(s: string, size: number, f: PDFFont, width: number) {
    const out: string[] = [];
    for (const raw of String(s ?? "").split(/\r\n|[\n\r\u2028\u2029]/)) {
      const para = safe(raw);
      let line = "";
      for (const word of para.split(/\s+/)) {
        const next = line ? `${line} ${word}` : word;
        if (f.widthOfTextAtSize(next, size) > width && line) {
          out.push(line);
          line = word;
        } else line = next;
      }
      out.push(line);
    }
    return out;
  }
  para(
    s: string,
    o: { size?: number; bold?: boolean; color?: ReturnType<typeof rgb>; indent?: number; after?: number } = {},
  ) {
    const size = o.size ?? 10;
    const f = o.bold ? this.bold : this.font;
    const indent = o.indent ?? 0;
    for (const l of this.wrap(s, size, f, this.w - indent)) {
      this.ensure(size * 1.5);
      this.page.drawText(l, { x: this.m + indent, y: this.y - size, size, font: f, color: o.color ?? INK });
      this.y -= size * 1.5;
    }
    this.y -= o.after ?? 4;
  }
  rule(color = RULE) {
    this.ensure(10);
    this.y -= 6;
    this.page.drawLine({
      start: { x: this.m, y: this.y },
      end: { x: this.m + this.w, y: this.y },
      thickness: 0.8,
      color,
    });
    this.y -= 10;
  }
  pair(label: string, value: string, o: { bold?: boolean; size?: number } = {}) {
    const size = o.size ?? 10;
    const lines = this.wrap(value, size, o.bold ? this.bold : this.font, this.w * 0.6);
    this.ensure(size * 1.6 * lines.length);
    this.page.drawText(safe(label), { x: this.m, y: this.y - size, size, font: this.font, color: MUTED });
    lines.forEach((l, i) => {
      const f = o.bold ? this.bold : this.font;
      this.page.drawText(l, {
        x: this.m + this.w - f.widthOfTextAtSize(l, size),
        y: this.y - size - i * size * 1.4,
        size,
        font: f,
        color: INK,
      });
    });
    this.y -= size * 1.4 * lines.length + size * 0.55;
  }
  /** Header block. `number` is shown as "No. …" unless `sub` replaces that line. */
  brand(title: string, number: string, date: string, sub?: string) {
    const p = this.page;
    drawLogo(p, this.m, this.y, 26);
    p.drawText(safe(title), { x: this.m + 36, y: this.y - 12, size: 15, font: this.bold, color: INK });
    p.drawText(safe(sub ?? `No. ${number}`), {
      x: this.m + 36,
      y: this.y - 25,
      size: 9,
      font: this.font,
      color: MUTED,
    });
    const d = safe(date);
    p.drawText(d, {
      x: this.m + this.w - this.font.widthOfTextAtSize(d, 9),
      y: this.y - 12,
      size: 9,
      font: this.font,
      color: MUTED,
    });
    this.y -= 40;
    this.rule();
  }
  footer(note: string) {
    const pages = this.doc.getPages();
    pages.forEach((pg, i) => {
      const t = safe(`${note}   ·   Page ${i + 1} of ${pages.length}`);
      pg.drawText(t, { x: this.m, y: 28, size: 7.5, font: this.font, color: MUTED });
    });
  }
}

export async function newDoc(title: string) {
  const doc = await PDFDocument.create();
  doc.setTitle(safe(title));
  doc.setProducer("pOS");
  doc.setCreator("pOS rental manager");
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  return { doc, font, bold };
}

/* ---------- Tables (reports, statements) ---------- */

type Cell = string | number;

/**
 * Draws a simple table. The first column is left-aligned and takes the space left over;
 * the rest are right-aligned numeric columns of `numWidth` each. Long first-column text is shortened.
 */
export function table(w: Writer, head: string[], rows: Cell[][], o: { numWidth?: number; total?: Cell[] } = {}) {
  const numWidth = o.numWidth ?? 76;
  const firstWidth = w.w - numWidth * (head.length - 1);
  const fit = (s: string, size: number, width: number, bold: boolean) => {
    const f = bold ? w.bold : w.font;
    let t = safe(s);
    if (f.widthOfTextAtSize(t, size) <= width) return t;
    while (t.length > 1 && f.widthOfTextAtSize(`${t}...`, size) > width) t = t.slice(0, -1);
    return `${t.trimEnd()}...`;
  };
  const line = (cells: Cell[], o2: { size?: number; bold?: boolean; color?: typeof INK } = {}) => {
    const size = o2.size ?? 9;
    const f = o2.bold ? w.bold : w.font;
    w.ensure(size * 1.9);
    cells.forEach((cell, i) => {
      const s = typeof cell === "number" ? inr(cell) : cell;
      if (i === 0) {
        w.page.drawText(fit(s, size, firstWidth - 8, !!o2.bold), {
          x: w.m,
          y: w.y - size,
          size,
          font: f,
          color: o2.color ?? INK,
        });
      } else {
        const t = fit(s, size, numWidth - 6, !!o2.bold);
        const right = w.m + firstWidth + numWidth * i;
        w.page.drawText(t, {
          x: right - f.widthOfTextAtSize(t, size),
          y: w.y - size,
          size,
          font: f,
          color: o2.color ?? INK,
        });
      }
    });
    w.y -= size * 1.75;
  };
  line(head, { size: 8, bold: true, color: MUTED });
  w.page.drawLine({ start: { x: w.m, y: w.y + 4 }, end: { x: w.m + w.w, y: w.y + 4 }, thickness: 0.6, color: RULE });
  w.y -= 2;
  for (const r of rows) line(r);
  if (o.total) {
    w.page.drawLine({ start: { x: w.m, y: w.y + 4 }, end: { x: w.m + w.w, y: w.y + 4 }, thickness: 0.6, color: RULE });
    w.y -= 2;
    line(o.total, { bold: true });
  }
  w.gap(10);
}

export function heading(w: Writer, s: string, note?: string) {
  w.ensure(64);
  w.gap(6);
  w.text(s, { size: 11.5, bold: true });
  w.lineDone(11.5, 1.5);
  if (note) w.para(note, { size: 8.5, color: MUTED, after: 4 });
}
