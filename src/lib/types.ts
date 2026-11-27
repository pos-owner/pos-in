/** Shapes returned by the pOS API (`server/routes.ts`). Keep in sync when an endpoint changes. */

export type ChargeStatus = "upcoming" | "due" | "partial" | "awaiting" | "paid" | "overdue";

export interface Payment {
  id: number;
  amount: number;
  method: "upi" | "cash" | "bank" | string;
  utr: string;
  status: "pending" | "confirmed" | "rejected" | "void" | string;
  paidOn: string;
  note: string;
  createdAt: string;
  /** Set when the owner voided a confirmed payment (it no longer counts; its receipt is kept). */
  voidReason?: string;
  voidedAt?: string | null;
  /** Set when this month is one part of a multi-month payment. */
  batchId?: number | null;
  batch?: PaymentBatchInfo | null;
}

/** One money transfer that covers several months ("₹30,000 for Nov 2026 – Jan 2027"). */
export interface PaymentBatchInfo {
  id: number;
  amount: number;
  months: number;
  /** YYYY-MM, first and last month covered. */
  from: string;
  to: string;
  status: "pending" | "confirmed" | "rejected" | "void" | string;
}

/** A month that can take money (`GET /api/tenancies/:id/pay-plan`). Upcoming months have no charge yet. */
export interface PayPlanMonth {
  chargeId: number | null;
  month: string;
  dueDate: string;
  amount: number;
  extra: number;
  paid: number;
  balance: number;
  /** After the current month: rent paid ahead. */
  advance: boolean;
}
export interface PayPlanLine extends PayPlanMonth {
  applied: number;
  balanceAfter: number;
}
export interface PayPlanResponse {
  tenancyId: number;
  current: string;
  maxMonthsAhead: number;
  months: PayPlanMonth[];
  /** The most this tenancy can take right now (everything due plus every month that can be paid ahead). */
  max: number;
  /** Months that already have a claim waiting for the owner. */
  awaiting: number;
  plan: { lines: PayPlanLine[]; total: number } | null;
  error: string | null;
  payee: { name: string; upiId: string; phone: string } | null;
}
export interface RecordPaymentResult {
  ok: true;
  batchId: number;
  paymentId: number;
  paymentIds: number[];
  amount: number;
  months: number;
  status: string;
  duplicate: boolean;
  lines?: { month: string; applied: number; balanceAfter: number; advance: boolean }[];
}

export interface LedgerRow {
  id: number;
  month: string;
  amount: number;
  dueDate: string;
  status: ChargeStatus;
  /** Utility bills (meter readings) included in `amount`. */
  extra?: number;
  /** Late fees (not waived) included in `amount`. */
  fees?: number;
  /** The rent part of `amount` when the month is pro-rated (null for full rent). */
  rentPart?: number | null;
  /** Days billed in a pro-rated month. */
  proratedDays?: number | null;
  paid: number;
  pending: number;
  balance: number;
  overdue: boolean;
  tenancyId: number;
  tenantId: number;
  tenantName: string;
  tenantPhone: string;
  unitId: number;
  unitLabel: string;
  propertyId: number;
  propertyName: string;
  payments: Payment[];
}

/** Compact charge used on the dashboard (`slimCharge`). */
export interface SlimCharge {
  id: number;
  month: string;
  amount: number;
  balance: number;
  pending: number;
  status: ChargeStatus;
  dueDate: string;
  tenantId: number;
  tenantName: string;
  tenantPhone: string;
  unitLabel: string;
  propertyName: string;
}

export interface Dashboard {
  month: string;
  today: string;
  due: number;
  collected: number;
  outstanding: number;
  occupied: number;
  totalUnits: number;
  overdue: SlimCharge[];
  awaiting: SlimCharge[];
  /** Money already received for months after this one (rent paid ahead). */
  advance?: number;
  openRequests: { id: number; title: string; status: string; priority: string; unitLabel: string }[];
  openRequestCount: number;
  pendingExpenseCount: number;
  leasesEnding: {
    tenancyId: number;
    tenantId: number;
    tenantName: string;
    unitLabel: string;
    endDate: string;
    /** Past its end date with no move-out: still billed at the last rent. */
    holdover?: boolean;
  }[];
  hasProperties: boolean;
}

export interface LedgerResponse {
  rows: LedgerRow[];
  months: string[];
  properties: { id: number; name: string }[];
}
export interface ChargeResponse {
  charge: LedgerRow;
  payee: { name: string; upiId: string };
}

export interface WorkspaceUnit {
  id: number;
  label: string;
  type: string;
  baseRent: number;
  tenancy: {
    id: number;
    tenantId: number;
    tenantName: string;
    tenantPhone: string;
    rent?: number;
    endDate: string | null;
  } | null;
}
export interface WorkspaceProperty {
  id: number;
  name: string;
  address: string;
  units: WorkspaceUnit[];
}
export interface WorkspaceResponse {
  properties: WorkspaceProperty[];
}

export interface TenantListItem {
  id: number;
  fullName: string;
  phone: string;
  linked: boolean;
  unitLabel: string;
  propertyName: string;
  active: boolean;
  rent?: number;
  balance?: number;
  overdue?: boolean;
  awaiting?: boolean;
}

export interface TenantDetailResponse {
  tenant: {
    id: number;
    fullName: string;
    phone: string;
    email: string;
    idNote: string;
    emergencyContact: string;
    moveInDate: string | null;
    deposit?: number;
    linked: boolean;
  };
  tenancies: {
    id: number;
    unitId: number;
    unitLabel: string;
    propertyName: string;
    rent?: number;
    dueDay: number;
    deposit?: number;
    startDate: string;
    endDate: string | null;
    /** A scheduled move-out (the tenant leaves on this day). */
    moveOutDate?: string | null;
    status: "active" | "ended" | string;
    state?: LeaseState;
  }[];
  ledger: LedgerRow[] | null;
  requests: { id: number; title: string; status: string; priority: string; createdAt: string }[];
  pendingInvite: { id: number; token: string; expiresAt: string } | null;
}

export interface TenantHome {
  tenant: {
    id: number;
    fullName: string;
    phone: string;
    email: string;
    emergencyContact: string;
    moveInDate: string | null;
  } | null;
  tenancy: {
    id: number;
    rent: number;
    dueDay: number;
    deposit: number;
    startDate: string;
    endDate: string | null;
    status: string;
  } | null;
  unit: { id: number; label: string; type: string } | null;
  property: { name: string; address: string } | null;
  payee: { name: string; upiId: string; phone: string };
  /** Charges with a balance, oldest first. */
  outstanding: LedgerRow[];
  /** Upcoming months that already have money on them (rent paid ahead), oldest first. */
  advance?: LedgerRow[];
  ledger: LedgerRow[];
  today: string;
}

export type RequestStatus = "open" | "in_progress" | "done";
export type Priority = "low" | "medium" | "high";
export interface RequestListItem {
  id: number;
  title: string;
  status: RequestStatus;
  priority: Priority;
  unitLabel: string;
  propertyName: string;
  raisedByName: string;
  assignedName: string;
  photoCount: number;
  createdAt: string;
  updatedAt: string;
}
export interface RequestDetailResponse {
  request: {
    id: number;
    title: string;
    description: string;
    status: RequestStatus;
    priority: Priority;
    unitId: number;
    unitLabel: string;
    propertyName: string;
    raisedByName: string;
    assignedTo: string | null;
    createdAt: string;
    updatedAt: string;
    photos: string[];
  };
  comments: { id: number; authorName: string; mine: boolean; body: string; createdAt: string; photo: string | null }[];
  assignees: { id: string; name: string; role: string }[];
  /** Tenants may comment only on requests they raised; owner and staff on any. */
  canComment: boolean;
}

export interface ExpenseRow {
  id: number;
  propertyId: number;
  propertyName: string;
  category: string;
  amount: number;
  date: string;
  note: string;
  approved: boolean;
  submittedByName: string;
}
export interface ExpensesResponse {
  rows: ExpenseRow[];
  properties: { id: number; name: string }[];
}

export interface InviteRow {
  id: number;
  role: "staff" | "tenant";
  name: string;
  token: string;
  expiresAt: string;
  createdAt: string;
  state: "valid" | "claimed" | "expired" | "locked";
}
export interface InvitesResponse {
  invites: InviteRow[];
  people: {
    id: string;
    role: string;
    fullName: string;
    email: string;
    /** Last sign-in or last activity on a signed-in device, whichever is later. Null if not seen since tracking began. */
    lastActiveAt: string | null;
    /** Devices currently signed in. */
    devices: number;
  }[];
}
export interface CreatedInvite {
  id: number;
  token: string;
  pin: string;
  role: "staff" | "tenant";
  name: string;
  expiresAt: string;
}
export interface InviteInfo {
  role: "staff" | "tenant";
  name: string;
  ownerName: string;
  unitLabel: string;
  propertyName: string;
  state: "valid" | "claimed" | "expired" | "locked";
}

/* ---- Receipts & agreements ---- */
export interface ReceiptItem {
  id: number;
  number: string;
  paymentId: number;
  amount: number;
  method: string;
  paidOn: string;
  month: string;
  tenantName: string;
  tenantPhone: string;
  unitLabel: string;
  createdAt: string;
  /** The payment was voided; the receipt is kept and marked VOID. */
  voided?: boolean;
  /** Last month covered when one receipt is for several months (multi-month payment). */
  monthTo?: string | null;
  months?: number;
}
export interface AgreementItem {
  tenancyId: number;
  tenantId: number;
  tenantName: string;
  tenantPhone: string;
  unitLabel: string;
  propertyName: string;
  rent: number;
  startDate: string;
  endDate: string | null;
  document: { id: number; number: string; createdAt: string } | null;
}
export interface TenantDocuments {
  receipts: ReceiptItem[];
  agreements: { id: number; number: string; tenancyId: number; createdAt: string }[];
}

/* ---- Meter readings ---- */
export type MeterKind = "electricity" | "water";
export interface MeterReading {
  id: number;
  unitId: number;
  unitLabel: string;
  kind: MeterKind;
  reading: number;
  previous: number | null;
  usage: number | null;
  rate: number;
  amount: number;
  confidence: number | null;
  readOn: string;
  applied: boolean;
  recordedByName: string;
  photo: string | null;
  /** "pending": a staff reading waiting for the owner's approval; it doesn't change any charge until approved. */
  status: "pending" | "approved";
  /** Sanity-check warning (unusually high usage) the person confirmed when saving. Empty when normal. */
  flag: string;
}
export interface MeterUnit {
  id: number;
  label: string;
  propertyId: number;
  propertyName: string;
  tenantName: string;
  occupied: boolean;
  last: { electricity: MeterReading | null; water: MeterReading | null };
}
export interface MeterRates {
  electricity: number;
  water: number;
}
/** A property's effective rates (paise per unit); `custom` marks values set on the property instead of the default. */
export interface MeterProperty extends MeterRates {
  id: number;
  name: string;
  custom: { electricity: boolean; water: boolean };
}
export interface MetersResponse {
  rates: MeterRates;
  properties: MeterProperty[];
  autoBill: boolean;
  pendingCount: number;
  units: MeterUnit[];
  readings: MeterReading[];
}
export interface MeterGuess {
  reading: number | null;
  confidence: number;
  note: string;
}

/* ---- Reports ---- */
export interface ReportMonth {
  month: string;
  income: number;
  expenses: number;
  profit: number;
  billed: number;
  collectedOnBill: number;
  occupied: number;
  units: number;
}
export interface ReportResponse {
  span: number;
  from: string;
  to: string;
  today: string;
  properties: { id: number; name: string }[];
  totals: {
    income: number;
    expenses: number;
    profit: number;
    billed: number;
    collected: number;
    collectionRate: number;
    occupancy: number;
    units: number;
  };
  months: ReportMonth[];
  byProperty: {
    id: number;
    name: string;
    income: number;
    expenses: number;
    profit: number;
    units: number;
    occupied: number;
  }[];
  categories: { category: string; amount: number }[];
  latePayers: {
    tenantId: number;
    tenantName: string;
    lateMonths: number;
    months: number;
    unpaid: number;
    avgDaysLate: number;
  }[];
  vacancy: { unitId: number; unitLabel: string; propertyName: string; vacantMonths: number }[];
}

/* ---- Automations ---- */
export type FlowKey =
  | "meter_to_bill"
  | "rent_reminders"
  | "auto_receipts"
  | "advance_rent"
  | "lease_alerts"
  | "prorate"
  | "late_fees"
  | "recurring_expenses";
export interface Flow {
  key: FlowKey;
  title: string;
  sub: string;
  enabled: boolean;
  config: Record<string, number>;
}
export interface AutomationsResponse {
  flows: Flow[];
  queued: number;
  runs: { id: number; action: string; entity: string; entityId: string | null; createdAt: string }[];
}
export interface ReminderItem {
  id: number;
  month: string;
  balance: number;
  dueDate: string;
  tenantId: number;
  tenantName: string;
  tenantPhone: string;
  unitLabel: string;
  overdue: boolean;
  reason: string;
}
export interface RemindersResponse {
  enabled: boolean;
  items: ReminderItem[];
}

/* ---- Leases and move-out settlement ---- */

/** `leaseState` on the server: ended, a move-out is scheduled, past its end date (holdover), ending within 60 days. */
export type LeaseState = "active" | "ending" | "holdover" | "moving_out" | "ended";

export interface LeaseTerm {
  id: number;
  startDate: string;
  endDate: string | null;
  rent: number;
  dueDay: number;
  deposit: number;
  reason: "initial" | "renewal" | "revision";
  note: string;
  createdAt: string;
}

export interface SettlementDeduction {
  id: number;
  kind: "damage" | "rent" | "utility" | "other";
  description: string;
  amount: number;
}
export interface SettlementInfo {
  id: number;
  status: "draft" | "final";
  number: string;
  moveOutDate: string;
  depositHeld: number;
  outstandingRent: number;
  pendingUtilities: number;
  advanceUnused: number;
  deductionTotal: number;
  /** Deposit - deductions + unused advance. Negative: the tenant still owes this much. */
  refundAmount: number;
  refundStatus: "pending" | "paid";
  refundMethod: string;
  refundRef: string;
  refundPaidOn: string | null;
  note: string;
  finalizedAt: string | null;
  deductions: SettlementDeduction[];
}

/** `GET /api/tenancies/:id/lease` and `GET /api/tenant/lease` (`lease`). */
export interface LeaseResponse {
  tenancy: {
    id: number;
    tenantId: number;
    tenantName: string;
    unitLabel: string;
    propertyName: string;
    rent: number;
    dueDay: number;
    deposit: number;
    startDate: string;
    endDate: string | null;
    moveOutDate: string | null;
    status: string;
    state: LeaseState;
  };
  terms: LeaseTerm[];
  /** Suggested dates for a renewal (owner, active tenancy only). */
  renewal: { effectiveFrom: string; endDate: string } | null;
  settlement: SettlementInfo | null;
}

/** `GET /api/tenancies/:id/settlement` */
export interface SettlementResponse {
  tenancy: {
    id: number;
    tenantId: number;
    tenantName: string;
    unitLabel: string;
    propertyName: string;
    deposit: number;
    startDate: string;
    endDate: string | null;
    moveOutDate: string | null;
    status: string;
  };
  suggestedMoveOut: string;
  settlement: SettlementInfo | null;
  /** The numbers as they stand, before a settlement is started. */
  preview: { depositHeld: number; outstandingRent: number; pendingUtilities: number; advanceUnused: number } | null;
}

/* ---- Late fees, pro-rating and recurring expenses ---- */

export interface ChargeFee {
  id: number;
  period: string;
  amount: number;
  note: string;
  createdAt: string;
  waivedAt: string | null;
  waiveReason: string;
}
export interface ChargeFeesResponse {
  fees: ChargeFee[];
}

export type Frequency = "monthly" | "quarterly" | "half_yearly" | "yearly";
export interface RecurringExpense {
  id: number;
  propertyId: number;
  propertyName: string;
  category: string;
  amount: number;
  frequency: Frequency;
  nextDate: string;
  note: string;
  active: boolean;
  /** Expenses this rule has logged so far. */
  generated: number;
  lastDate: string | null;
}
export interface RecurringResponse {
  enabled: boolean;
  items: RecurringExpense[];
  properties: { id: number; name: string }[];
}

/* ---- Notifications and the offline outbox ---- */

export interface NotificationItem {
  id: number;
  kind: string;
  title: string;
  body: string;
  url: string;
  read: boolean;
  createdAt: string;
}
export interface NotificationsResponse {
  items: NotificationItem[];
  unread: number;
  more: boolean;
}

/* ---- PAN, statements, QR codes, receipt verification, export and language ---- */

/** `GET /api/pan` */
export interface PanResponse {
  /** Owner: their own PAN. Tenant: the PAN on their tenant record. */
  pan: string;
  role: "owner" | "tenant";
}

/** One tenancy a statement can be made for (`GET /api/statements`). */
export interface StatementTenancy {
  tenancyId: number;
  tenantId: number;
  tenantName: string;
  unitLabel: string;
  propertyName: string;
  startDate: string;
  status: string;
  /** YYYY-MM, first and last month with a charge. */
  firstMonth: string | null;
  lastMonth: string | null;
}
export interface StatementsResponse {
  tenancies: StatementTenancy[];
  /** Financial years (April start) that have charges, newest first. */
  fys: number[];
  today: string;
}

export interface QrUnit {
  unitId: number;
  label: string;
  propertyName: string;
  tenantName: string;
  code: string;
}
export interface QrResponse {
  units: QrUnit[];
}

/** `GET /api/u/:code`: what scanning a unit's QR code opens, depending on who scanned it. */
export interface ScanResponse {
  unit: { id: number; label: string; type: string; propertyName: string; address: string };
  /** owner/staff: the unit's tenancy summary; tenant: only for their own unit. */
  tenancy: { id: number; tenantId: number; tenantName: string; endDate: string | null } | null;
  role: "owner" | "staff" | "tenant";
  mine: boolean;
  openRequests: { id: number; title: string; status: string; priority: string }[];
  lastReadings: { kind: string; reading: number | null; readOn: string | null }[];
}

/** `GET /api/verify/:code` (no sign-in): what a receipt's QR code proves. */
export interface VerifyResponse {
  valid: boolean;
  number?: string;
  amount?: number;
  paidOn?: string;
  month?: string;
  monthTo?: string | null;
  voided?: boolean;
  /** YYYY-MM-DD, when the landlord voided the payment. */
  voidedOn?: string | null;
  /** YYYY-MM-DD, when the receipt was issued. */
  issuedOn?: string;
  /** "upi" | "cash" | "bank" */
  method?: string;
  /** How many months the payment covers (1 for a single month). */
  months?: number;
  tenant?: string;
  unit?: string;
  property?: string;
  landlord?: string;
  /** Server time of this check (ISO). */
  checkedAt?: string;
}
