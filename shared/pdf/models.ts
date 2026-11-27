/**
 * What the API sends for each printable document. The Worker gathers and formats the facts (it owns the ledger);
 * the browser turns them into a PDF with the renderers in this folder.
 */
import type { buildReport } from "../../worker/server/domain/reports.ts";

/** One month of a multi-month payment, as printed on its receipt. */
export interface ReceiptLine {
  /** YYYY-MM */
  month: string;
  rent: number;
  /** Meter bills for the month. */
  extra: number;
  /** rent + extra */
  chargeAmount: number;
  /** What this payment put toward the month. */
  applied: number;
  /** Still due on the month after every confirmed payment. */
  balance: number;
}

export interface ReceiptModel {
  kind: "receipt";
  /** The receipt's `documents` row. */
  documentId: number;
  filename: string;
  number: string;
  /** YYYY-MM-DD */
  issuedOn: string;
  voided: boolean;
  /** YYYY-MM-DD, when voided. */
  voidedOn: string | null;
  voidReason: string;
  amount: number;
  amountWords: string;
  tenantName: string;
  /** YYYY-MM (the first month, when the payment covers several). */
  month: string;
  /** YYYY-MM, last month covered. Only set for a multi-month payment. */
  monthTo?: string;
  /** Month-wise breakdown. Only set for a multi-month payment. */
  lines?: ReceiptLine[];
  unitLabel: string;
  propertyName: string;
  address: string;
  /** YYYY-MM-DD */
  paidOn: string;
  method: string;
  utr: string;
  note: string;
  /** The month's total (rent plus meter bills). */
  chargeAmount: number;
  /** Meter bills included in `chargeAmount`. */
  extra: number;
  paidTotal: number;
  balance: number;
  ownerName: string;
  ownerPhone: string;
  ownerUpi: string;
  /** Signed `/verify/<code>` link, printed as a QR code so the receipt can be checked. */
  verifyUrl?: string;
}

export interface AgreementModel {
  kind: "agreement";
  filename: string;
  number: string;
  /** YYYY-MM-DD, India time. */
  today: string;
  place: string;
  landlord: string;
  ownerPhone: string;
  ownerUpi: string;
  tenantName: string;
  tenantPhone: string;
  tenantIdNote: string;
  unitLabel: string;
  unitType: string;
  propertyName: string;
  address: string;
  startDate: string;
  endDate: string;
  months: number;
  rent: number;
  rentWords: string;
  dueDay: number;
  deposit: number;
  depositWords: string;
  /** Rupees per unit (0 when not set). */
  electricityRate: number;
  waterRate: number;
}

export type ReportData = Awaited<ReturnType<typeof buildReport>>;

export interface ReportModel {
  kind: "report";
  filename: string;
  ownerName: string;
  scope: string;
  report: ReportData;
}

/** Move-out and deposit settlement statement (`/api/tenancies/:id/settlement.json`), drawn by `settlement.ts`. */
export interface SettlementModel {
  kind: "settlement";
  filename: string;
  number: string;
  final: boolean;
  issuedOn: string;
  tenantName: string;
  tenantPhone: string;
  unitLabel: string;
  propertyName: string;
  address: string;
  startDate: string;
  moveOutDate: string;
  depositHeld: number;
  outstandingRent: number;
  pendingUtilities: number;
  advanceUnused: number;
  deductions: { kind: string; description: string; amount: number }[];
  deductionTotal: number;
  refundAmount: number;
  refundStatus: string;
  refundMethod: string;
  refundRef: string;
  refundPaidOn: string | null;
  note: string;
  ownerName: string;
  ownerPhone: string;
  ownerPan: string;
}

/**
 * Rent statement for one tenancy over a period (a month, a calendar year or an April–March financial year), for the
 * tenant's HRA claim (`/api/tenancies/:id/statement.json`), drawn by `statement.ts`.
 */
export interface StatementModel {
  kind: "statement";
  filename: string;
  period: "month" | "year" | "fy";
  /** "April 2026", "2026", "FY 2026-27". */
  periodLabel: string;
  /** YYYY-MM, first and last month covered. */
  from: string;
  to: string;
  /** YYYY-MM-DD */
  issuedOn: string;
  tenantName: string;
  tenantPhone: string;
  tenantPan: string;
  unitLabel: string;
  propertyName: string;
  address: string;
  ownerName: string;
  ownerPhone: string;
  ownerPan: string;
  /** One line per month in the period that has a charge. */
  months: {
    month: string;
    rent: number;
    utilities: number;
    fees: number;
    charged: number;
    paid: number;
    balance: number;
  }[];
  /** Confirmed payments received in the period, oldest first. */
  payments: { paidOn: string; amount: number; method: string; utr: string; receipt: string; months: string }[];
  totalRent: number;
  totalCharged: number;
  totalPaid: number;
  balance: number;
}

export type DocumentModel = ReceiptModel | AgreementModel | ReportModel | SettlementModel | StatementModel;
