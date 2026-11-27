/**
 * Draws receipts, agreements, reports, settlement statements and rent statements in the browser from the data the
 * API sends (shared/pdf/). pdf-lib and the layouts load only when someone first opens a PDF, so they never slow down
 * app start.
 */
import type { DocumentModel } from "../../shared/pdf/models";

export async function renderPdf(model: DocumentModel): Promise<Blob> {
  let bytes: Uint8Array;
  if (model.kind === "receipt") bytes = await (await import("../../shared/pdf/receipt")).renderReceipt(model);
  else if (model.kind === "agreement")
    bytes = await (await import("../../shared/pdf/agreement")).renderAgreement(model);
  else if (model.kind === "settlement")
    bytes = await (await import("../../shared/pdf/settlement")).renderSettlement(model);
  else if (model.kind === "statement")
    bytes = await (await import("../../shared/pdf/statement")).renderStatement(model);
  else bytes = await (await import("../../shared/pdf/report")).renderReport(model);
  return new Blob([bytes as BlobPart], { type: "application/pdf" });
}
