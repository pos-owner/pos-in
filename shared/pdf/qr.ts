import qrcode from "qrcode-generator";
import { INK, type Writer } from "./writer.ts";

/**
 * Draws `text` as a QR code on the current page, `size` points wide, with its top-left corner at (`x`, `top`) in
 * page coordinates. Plain filled squares, so it prints crisply and needs no image embedding.
 */
export function drawQr(w: Writer, text: string, x: number, top: number, size: number) {
  const q = qrcode(0, "M");
  q.addData(text);
  q.make();
  const n = q.getModuleCount();
  const cell = size / n;
  for (let r = 0; r < n; r++)
    for (let c = 0; c < n; c++)
      if (q.isDark(r, c))
        // A hair wider than the cell so neighbouring squares don't leave hairline gaps in some viewers.
        w.page.drawRectangle({
          x: x + c * cell,
          y: top - (r + 1) * cell,
          width: cell + 0.05,
          height: cell + 0.05,
          color: INK,
        });
}
