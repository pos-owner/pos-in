/**
 * CSV exports built in the browser from the owner's backup (`GET /api/backup.json`, see worker/server/exportRoutes.ts).
 * The Worker only reads rows; joining names and writing CSV happens here, like the PDFs. Files open in Excel, Google
 * Sheets and Tally imports: UTF-8 with a BOM (so ₹ and Hindi names survive Excel), CRLF line ends, amounts in
 * whole rupees.
 */

/* The parts of the backup the exports read (dates arrive as ISO strings). */
interface Row {
  id: number;
}
export interface BackupDoc {
  app: string;
  version: number;
  exportedAt: string;
  exportedOn: string;
  owner: { fullName: string } | null;
  properties: (Row & { name: string; address: string })[];
  units: (Row & { propertyId: number; label: string; type: string; baseRent: number })[];
  tenants: (Row & {
    fullName: string;
    phone: string;
    email: string;
    moveInDate: string | null;
    deposit: number;
    pan: string;
    userId: string | null;
  })[];
  tenancies: (Row & {
    unitId: number;
    tenantId: number;
    rent: number;
    dueDay: number;
    deposit: number;
    startDate: string;
    endDate: string | null;
    moveOutDate: string | null;
    status: string;
  })[];
  charges: (Row & {
    tenancyId: number;
    month: string;
    amount: number;
    dueDate: string;
    status: string;
    extra: number;
    fees: number;
    rentPart: number | null;
  })[];
  payments: (Row & {
    chargeId: number;
    amount: number;
    method: string;
    utr: string;
    status: string;
    paidOn: string;
    note: string;
    batchId: number | null;
    voidReason: string;
  })[];
  expenses: (Row & {
    propertyId: number;
    category: string;
    amount: number;
    date: string;
    note: string;
    approved: boolean;
    recurringId: number | null;
  })[];
  maintenanceRequests: (Row & {
    unitId: number;
    title: string;
    priority: string;
    status: string;
    raisedByName: string;
    createdAt: string;
  })[];
  meterReadings: (Row & {
    unitId: number | null;
    kind: string;
    reading: number | null;
    previous: number | null;
    usage: number | null;
    amount: number;
    readOn: string | null;
    status: string;
    recordedByName: string;
  })[];
  documents: (Row & { kind: string; number: string; paymentId: number | null; batchId: number | null })[];
  [table: string]: unknown;
}

type Cell = string | number | boolean | null | undefined;

/** One CSV field: quoted when needed; a leading =, +, - or @ is defused so a spreadsheet never runs it as a formula. */
function csvCell(v: Cell): string {
  if (v == null) return "";
  if (typeof v === "boolean") return v ? "Yes" : "No";
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : "";
  let s = String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function toCsv(head: string[], rows: Cell[][]): string {
  return "﻿" + [head, ...rows].map((r) => r.map(csvCell).join(",")).join("\r\n") + "\r\n";
}

const METHOD: Record<string, string> = { upi: "UPI", cash: "Cash", bank: "Bank transfer" };

/** Lookups shared by the exports. */
function index(b: BackupDoc) {
  const prop = new Map(b.properties.map((p) => [p.id, p]));
  const unit = new Map(b.units.map((u) => [u.id, u]));
  const tenant = new Map(b.tenants.map((t) => [t.id, t]));
  const tenancy = new Map(b.tenancies.map((t) => [t.id, t]));
  const charge = new Map(b.charges.map((c) => [c.id, c]));
  const where = (unitId: number | null | undefined) => {
    const u = unitId != null ? unit.get(unitId) : undefined;
    return { unit: u?.label ?? "", property: u ? (prop.get(u.propertyId)?.name ?? "") : "" };
  };
  const ofTenancy = (id: number) => {
    const tn = tenancy.get(id);
    return { tn, tenant: tn ? (tenant.get(tn.tenantId)?.fullName ?? "") : "", ...where(tn?.unitId) };
  };
  return { prop, unit, tenant, tenancy, charge, where, ofTenancy };
}

export type ExportKind = "payments" | "ledger" | "expenses" | "tenants" | "leases" | "units" | "requests" | "meters";

export const EXPORTS: { kind: ExportKind; title: string; sub: string; count: (b: BackupDoc) => number }[] = [
  {
    kind: "payments",
    title: "Payments",
    sub: "Every payment with method, reference and receipt",
    count: (b) => b.payments.length,
  },
  {
    kind: "ledger",
    title: "Rent ledger",
    sub: "Month by month: rent, bills, late fees, paid and due",
    count: (b) => b.charges.length,
  },
  { kind: "expenses", title: "Expenses", sub: "Date, property, category and amount", count: (b) => b.expenses.length },
  {
    kind: "tenants",
    title: "Tenants",
    sub: "Contacts, deposits, PAN and current home",
    count: (b) => b.tenants.length,
  },
  {
    kind: "leases",
    title: "Leases",
    sub: "Every tenancy with rent, dates and status",
    count: (b) => b.tenancies.length,
  },
  {
    kind: "units",
    title: "Properties & units",
    sub: "Each unit with its property and tenant",
    count: (b) => b.units.length,
  },
  {
    kind: "requests",
    title: "Maintenance requests",
    sub: "What was reported, when and its status",
    count: (b) => b.maintenanceRequests.length,
  },
  { kind: "meters", title: "Meter readings", sub: "Readings, usage and bills", count: (b) => b.meterReadings.length },
];

/** The CSV for one export: file contents and a dated filename. */
export function buildCsv(b: BackupDoc, kind: ExportKind): { filename: string; csv: string } {
  const ix = index(b);
  const day = b.exportedOn;
  const file = (name: string) => `pOS-${name}-${day}.csv`;

  if (kind === "payments") {
    const receiptByPayment = new Map<number, string>();
    const receiptByBatch = new Map<number, string>();
    for (const d of b.documents)
      if (d.kind === "receipt") {
        if (d.batchId != null) receiptByBatch.set(d.batchId, d.number);
        else if (d.paymentId != null) receiptByPayment.set(d.paymentId, d.number);
      }
    const rows = [...b.payments]
      .sort((x, y) => x.paidOn.localeCompare(y.paidOn) || x.id - y.id)
      .map((p) => {
        const c = ix.charge.get(p.chargeId);
        const t = c ? ix.ofTenancy(c.tenancyId) : { tenant: "", unit: "", property: "" };
        const receipt = p.batchId != null ? receiptByBatch.get(p.batchId) : receiptByPayment.get(p.id);
        return [
          p.paidOn,
          t.tenant,
          t.unit,
          t.property,
          c?.month ?? "",
          p.amount,
          METHOD[p.method] ?? p.method,
          p.utr,
          p.status,
          receipt ?? "",
          p.batchId != null ? `#${p.batchId}` : "",
          [p.note, p.voidReason && `Voided: ${p.voidReason}`].filter(Boolean).join(" · "),
        ];
      });
    return {
      filename: file("payments"),
      csv: toCsv(
        [
          "Paid on",
          "Tenant",
          "Unit",
          "Property",
          "For month",
          "Amount (Rs)",
          "Method",
          "Reference / UTR",
          "Status",
          "Receipt no.",
          "Multi-month payment",
          "Note",
        ],
        rows,
      ),
    };
  }

  if (kind === "ledger") {
    const paid = new Map<number, number>();
    for (const p of b.payments)
      if (p.status === "confirmed") paid.set(p.chargeId, (paid.get(p.chargeId) ?? 0) + p.amount);
    const rows = [...b.charges]
      .map((c) => ({ c, t: ix.ofTenancy(c.tenancyId) }))
      .sort(
        (x, y) =>
          x.c.month.localeCompare(y.c.month) ||
          x.t.property.localeCompare(y.t.property) ||
          x.t.unit.localeCompare(y.t.unit),
      )
      .map(({ c, t }) => {
        const got = paid.get(c.id) ?? 0;
        const rent = c.rentPart ?? Math.max(0, c.amount - c.extra - c.fees);
        return [
          c.month,
          t.tenant,
          t.unit,
          t.property,
          rent,
          c.extra,
          c.fees,
          c.amount,
          got,
          Math.max(0, c.amount - got),
          c.status,
          c.dueDate,
        ];
      });
    return {
      filename: file("rent-ledger"),
      csv: toCsv(
        [
          "Month",
          "Tenant",
          "Unit",
          "Property",
          "Rent (Rs)",
          "Utilities (Rs)",
          "Late fees (Rs)",
          "Total (Rs)",
          "Paid (Rs)",
          "Balance (Rs)",
          "Status",
          "Due date",
        ],
        rows,
      ),
    };
  }

  if (kind === "expenses") {
    const rows = [...b.expenses]
      .sort((x, y) => x.date.localeCompare(y.date) || x.id - y.id)
      .map((e) => [
        e.date,
        ix.prop.get(e.propertyId)?.name ?? "",
        e.category,
        e.amount,
        e.approved,
        e.recurringId != null,
        e.note,
      ]);
    return {
      filename: file("expenses"),
      csv: toCsv(["Date", "Property", "Category", "Amount (Rs)", "Approved", "Recurring", "Note"], rows),
    };
  }

  if (kind === "tenants") {
    const current = new Map<number, string>();
    for (const tn of b.tenancies)
      if (tn.status === "active") {
        const w = ix.where(tn.unitId);
        current.set(tn.tenantId, `${w.unit}, ${w.property}`);
      }
    const rows = [...b.tenants]
      .sort((x, y) => x.fullName.localeCompare(y.fullName))
      .map((t) => [
        t.fullName,
        t.phone,
        t.email,
        t.pan,
        t.moveInDate,
        t.deposit,
        current.get(t.id) ?? "",
        current.has(t.id) ? "Current" : "Past",
        !!t.userId,
      ]);
    return {
      filename: file("tenants"),
      csv: toCsv(["Name", "Phone", "Email", "PAN", "Moved in", "Deposit (Rs)", "Home", "Status", "Uses the app"], rows),
    };
  }

  if (kind === "leases") {
    const rows = [...b.tenancies]
      .sort((x, y) => x.startDate.localeCompare(y.startDate))
      .map((tn) => {
        const t = ix.ofTenancy(tn.id);
        return [
          t.tenant,
          t.unit,
          t.property,
          tn.startDate,
          tn.endDate,
          tn.moveOutDate,
          tn.rent,
          tn.deposit,
          tn.dueDay,
          tn.status,
        ];
      });
    return {
      filename: file("leases"),
      csv: toCsv(
        [
          "Tenant",
          "Unit",
          "Property",
          "Start",
          "Lease end",
          "Move-out",
          "Rent (Rs)",
          "Deposit (Rs)",
          "Due day",
          "Status",
        ],
        rows,
      ),
    };
  }

  if (kind === "units") {
    const active = new Map(b.tenancies.filter((t) => t.status === "active").map((t) => [t.unitId, t]));
    const rows = [...b.units]
      .sort((x, y) => x.propertyId - y.propertyId || x.label.localeCompare(y.label))
      .map((u) => {
        const p = ix.prop.get(u.propertyId);
        const tn = active.get(u.id);
        return [
          p?.name ?? "",
          p?.address ?? "",
          u.label,
          u.type,
          u.baseRent,
          tn ? (ix.tenant.get(tn.tenantId)?.fullName ?? "") : "",
          tn?.rent ?? "",
        ];
      });
    return {
      filename: file("properties-units"),
      csv: toCsv(["Property", "Address", "Unit", "Type", "Base rent (Rs)", "Tenant", "Current rent (Rs)"], rows),
    };
  }

  if (kind === "requests") {
    const rows = [...b.maintenanceRequests]
      .sort((x, y) => x.createdAt.localeCompare(y.createdAt))
      .map((r) => {
        const w = ix.where(r.unitId);
        return [r.createdAt.slice(0, 10), w.unit, w.property, r.title, r.priority, r.status, r.raisedByName];
      });
    return {
      filename: file("requests"),
      csv: toCsv(["Reported on", "Unit", "Property", "Problem", "Priority", "Status", "Reported by"], rows),
    };
  }

  const rows = [...b.meterReadings]
    .sort((x, y) => (x.readOn ?? "").localeCompare(y.readOn ?? "") || x.id - y.id)
    .map((m) => {
      const w = ix.where(m.unitId);
      return [
        m.readOn,
        w.unit,
        w.property,
        m.kind,
        m.previous,
        m.reading,
        m.usage,
        m.amount,
        m.status,
        m.recordedByName,
      ];
    });
  return {
    filename: file("meter-readings"),
    csv: toCsv(
      ["Read on", "Unit", "Property", "Meter", "Previous", "Reading", "Usage", "Bill (Rs)", "Status", "Recorded by"],
      rows,
    ),
  };
}

/** Saves text as a file (download on a computer; the share sheet when `share` and the phone supports it). */
export async function saveText(text: string, filename: string, type: string, share = false) {
  const blob = new Blob([text], { type });
  if (share) {
    const f = new File([blob], filename, { type });
    if (navigator.canShare?.({ files: [f] })) {
      try {
        await navigator.share({ files: [f], title: filename });
        return "shared" as const;
      } catch (e) {
        if ((e as Error).name === "AbortError") return "cancelled" as const;
      }
    }
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
  return "downloaded" as const;
}
