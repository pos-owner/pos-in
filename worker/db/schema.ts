import { sql } from "drizzle-orm";
import { check, index, integer, real, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

/*
 * Cloudflare D1 (SQLite) schema.
 *
 * Column conventions:
 *  - Timestamps are `integer` milliseconds since the epoch (`mode: "timestamp_ms"`), so the API keeps reading and
 *    writing `Date` objects.
 *  - Calendar dates (rent due dates, move-in, paid on) are `text` in `YYYY-MM-DD`. They sort and compare as strings.
 *  - Booleans are `integer` 0/1 (`mode: "boolean"`), JSON values are `text` (`mode: "json"`).
 *
 * CHECK constraints mirror the values the API writes (routes.ts, toolRoutes.ts, seed.ts); they are a backstop so a
 * bug or a manual SQL edit can't store a role, status or amount the app doesn't understand. Update both together.
 */

const now = () => new Date();
const createdAt = () => integer("created_at", { mode: "timestamp_ms" }).notNull().$defaultFn(now);

/* ---------- accounts (built-in email + password auth) ---------- */

/** Sign-in accounts. `id` is a random string; `profiles.id` points at it once the person has onboarded. */
export const users = sqliteTable(
  "users",
  {
    id: text().primaryKey(),
    /** Lower-cased, trimmed. */
    email: text().notNull(),
    name: text().notNull().default(""),
    /** `p2$<iterations>$<salt>$<hash>` (PBKDF2-SHA256 of the login key). Never sent anywhere. */
    passwordHash: text("password_hash").notNull(),
    createdAt: createdAt(),
    /** Bumped on password change: every session issued before it is refused. */
    passwordChangedAt: integer("password_changed_at", { mode: "timestamp_ms" }).notNull().$defaultFn(now),
    /** Set whenever a session starts (sign up, sign in, password change or reset). */
    lastSignInAt: integer("last_sign_in_at", { mode: "timestamp_ms" }),
  },
  (t) => [uniqueIndex("users_email_uq").on(t.email)],
);

/** Server-side sessions. The browser holds the random token in an HttpOnly cookie; only its SHA-256 is stored. */
export const sessions = sqliteTable(
  "sessions",
  {
    tokenHash: text("token_hash").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    createdAt: createdAt(),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
    /** Updated at most once an hour, to slide the expiry without writing on every request. */
    seenAt: integer("seen_at", { mode: "timestamp_ms" }).notNull().$defaultFn(now),
    userAgent: text("user_agent").notNull().default(""),
    /** Rough place the session started, from Cloudflare's IP geolocation ("Pune, India"). Empty when unknown. */
    location: text().notNull().default(""),
  },
  (t) => [index("sessions_user_idx").on(t.userId), index("sessions_expires_idx").on(t.expiresAt)],
);

/** One-time password reset links (owner-issued, emailed, or made with `npm run cf:reset-link`). */
export const passwordResets = sqliteTable(
  "password_resets",
  {
    tokenHash: text("token_hash").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
    usedAt: integer("used_at", { mode: "timestamp_ms" }),
    createdAt: createdAt(),
  },
  (t) => [index("password_resets_user_idx").on(t.userId)],
);

/* ---------- workspace ---------- */

/** One row per onboarded person. `id` is the user id (users.id). */
export const profiles = sqliteTable(
  "profiles",
  {
    id: text().primaryKey(),
    role: text().notNull(), // owner | staff | tenant
    /** The owner workspace this person belongs to (owners point at themselves). */
    ownerId: text("owner_id").notNull(),
    fullName: text("full_name").notNull().default(""),
    email: text().notNull().default(""),
    phone: text().notNull().default(""),
    upiId: text("upi_id").notNull().default(""),
    /** Owner's utility rates in paise per unit (meter readings). */
    electricityRate: integer("electricity_rate").notNull().default(800),
    waterRate: integer("water_rate").notNull().default(0),
    createdAt: createdAt(),
    /** Owner's PAN (printed on rent receipts for HRA). Upper-case, validated as AAAAA9999A. Never shown to staff. */
    pan: text().notNull().default(""),
    /** Interface language: "en" or "hi". */
    locale: text().notNull().default("en"),
  },
  (t) => [
    index("profiles_owner_idx").on(t.ownerId),
    check("profiles_role_check", sql`${t.role} in ('owner', 'staff', 'tenant')`),
  ],
);

export const properties = sqliteTable(
  "properties",
  {
    id: integer().primaryKey({ autoIncrement: true }),
    name: text().notNull(),
    address: text().notNull().default(""),
    ownerId: text("owner_id")
      .notNull()
      .references(() => profiles.id),
    /** Utility rates for this property in paise per unit. Null uses the owner's default rate. */
    electricityRate: integer("electricity_rate"),
    waterRate: integer("water_rate"),
    createdAt: createdAt(),
  },
  (t) => [index("properties_owner_idx").on(t.ownerId)],
);

export const units = sqliteTable(
  "units",
  {
    id: integer().primaryKey({ autoIncrement: true }),
    propertyId: integer("property_id")
      .notNull()
      .references(() => properties.id, { onDelete: "cascade" }),
    label: text().notNull(),
    type: text().notNull().default("2BHK"),
    /** Suggested rent for a new tenancy. Optional, so 0 is allowed (the default); the tenancy's own rent must be > 0. */
    baseRent: integer("base_rent").notNull().default(0),
  },
  (t) => [index("units_property_idx").on(t.propertyId), check("units_base_rent_check", sql`${t.baseRent} >= 0`)],
);

/** Tenant records. `userId` is set once the tenant claims an invite and signs in. */
export const tenants = sqliteTable(
  "tenants",
  {
    id: integer().primaryKey({ autoIncrement: true }),
    ownerId: text("owner_id")
      .notNull()
      .references(() => profiles.id),
    userId: text("user_id").references(() => profiles.id),
    fullName: text("full_name").notNull(),
    phone: text().notNull().default(""),
    email: text().notNull().default(""),
    idNote: text("id_note").notNull().default(""),
    emergencyContact: text("emergency_contact").notNull().default(""),
    moveInDate: text("move_in_date"),
    deposit: integer().notNull().default(0),
    createdAt: createdAt(),
    /** Tenant's PAN (optional, for their own HRA claim). */
    pan: text().notNull().default(""),
  },
  (t) => [index("tenants_user_idx").on(t.userId), index("tenants_owner_idx").on(t.ownerId)],
);

export const tenancies = sqliteTable(
  "tenancies",
  {
    id: integer().primaryKey({ autoIncrement: true }),
    unitId: integer("unit_id")
      .notNull()
      .references(() => units.id, { onDelete: "cascade" }),
    tenantId: integer("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    rent: integer().notNull(),
    dueDay: integer("due_day").notNull().default(5),
    deposit: integer().notNull().default(0),
    startDate: text("start_date").notNull(),
    endDate: text("end_date"),
    status: text().notNull().default("active"), // active | ended
    /**
     * A scheduled move-out (the tenant leaves on this day). Separate from `endDate`, which is when the lease term
     * ends: a lease that ends without a move-out keeps running as a holdover (billed at the last rent) until the
     * owner renews it or ends it.
     */
    moveOutDate: text("move_out_date"),
  },
  (t) => [
    index("tenancies_unit_idx").on(t.unitId),
    index("tenancies_tenant_idx").on(t.tenantId),
    check("tenancies_status_check", sql`${t.status} in ('active', 'ended')`),
    check("tenancies_rent_check", sql`${t.rent} > 0`),
    // The API accepts due days 1 to 28 (cleanInt(dueDay, 1, 28)), so every month has the day.
    check("tenancies_due_day_check", sql`${t.dueDay} between 1 and 28`),
  ],
);

export const invites = sqliteTable(
  "invites",
  {
    id: integer().primaryKey({ autoIncrement: true }),
    ownerId: text("owner_id")
      .notNull()
      .references(() => profiles.id),
    role: text().notNull(), // staff | tenant
    unitId: integer("unit_id").references(() => units.id, { onDelete: "set null" }),
    tenantId: integer("tenant_id").references(() => tenants.id, { onDelete: "cascade" }),
    name: text().notNull().default(""),
    token: text().notNull(),
    pinHash: text("pin_hash").notNull(),
    attempts: integer().notNull().default(0),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
    claimedBy: text("claimed_by").references(() => profiles.id),
    claimedAt: integer("claimed_at", { mode: "timestamp_ms" }),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("invites_token_uq").on(t.token), index("invites_owner_idx").on(t.ownerId)],
);

/** One charge per tenancy per month (month = 'YYYY-MM'). */
export const charges = sqliteTable(
  "charges",
  {
    id: integer().primaryKey({ autoIncrement: true }),
    tenancyId: integer("tenancy_id")
      .notNull()
      .references(() => tenancies.id, { onDelete: "cascade" }),
    month: text().notNull(),
    amount: integer().notNull(),
    dueDate: text("due_date").notNull(),
    status: text().notNull().default("due"),
    /** Utility bills (meter readings) added on top of rent. Already included in `amount`. */
    extra: integer().notNull().default(0),
    /** The rent part of `amount` when it differs from the tenancy rent (pro-rated move-in or move-out month). */
    rentPart: integer("rent_part"),
    /** Days billed in a pro-rated month (null for a full month). */
    proratedDays: integer("prorated_days"),
    /** Late fees (charge_adjustments that aren't waived). Already included in `amount`, kept in step by triggers. */
    fees: integer().notNull().default(0),
  },
  (t) => [
    uniqueIndex("charges_tenancy_month_uq").on(t.tenancyId, t.month),
    check("charges_amount_check", sql`${t.amount} >= 0`),
  ],
);

/**
 * One money transfer that covers one or more months (multi-month and advance rent). Each month it covers is an
 * ordinary `payments` row with `batch_id` set, so the ledger, reports and statuses keep working month by month.
 * The batch's status always matches its rows: confirm, reject, void and delete act on the whole batch.
 * `client_key` makes a submission idempotent (a retry or double tap returns the first result).
 */
export const paymentBatches = sqliteTable(
  "payment_batches",
  {
    id: integer().primaryKey({ autoIncrement: true }),
    ownerId: text("owner_id")
      .notNull()
      .references(() => profiles.id),
    tenancyId: integer("tenancy_id")
      .notNull()
      .references(() => tenancies.id, { onDelete: "cascade" }),
    clientKey: text("client_key").notNull(),
    amount: integer().notNull(),
    /** How many months (charges) this payment is spread over. */
    months: integer().notNull(),
    method: text().notNull(), // upi | cash | bank
    utr: text().notNull().default(""),
    status: text().notNull().default("confirmed"), // pending | confirmed | rejected | void
    recordedBy: text("recorded_by").references(() => profiles.id),
    paidOn: text("paid_on").notNull(),
    note: text().notNull().default(""),
    voidReason: text("void_reason").notNull().default(""),
    voidedBy: text("voided_by").references(() => profiles.id),
    voidedAt: integer("voided_at", { mode: "timestamp_ms" }),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("payment_batches_owner_key_uq").on(t.ownerId, t.clientKey),
    index("payment_batches_tenancy_idx").on(t.tenancyId),
    check("payment_batches_status_check", sql`${t.status} in ('pending', 'confirmed', 'rejected', 'void')`),
    check("payment_batches_method_check", sql`${t.method} in ('upi', 'cash', 'bank')`),
    check("payment_batches_amount_check", sql`${t.amount} > 0`),
    check("payment_batches_months_check", sql`${t.months} >= 1`),
  ],
);

export const payments = sqliteTable(
  "payments",
  {
    id: integer().primaryKey({ autoIncrement: true }),
    chargeId: integer("charge_id")
      .notNull()
      .references(() => charges.id, { onDelete: "cascade" }),
    amount: integer().notNull(),
    method: text().notNull(), // upi | cash | bank
    utr: text().notNull().default(""),
    status: text().notNull().default("confirmed"), // pending | confirmed | rejected | void
    recordedBy: text("recorded_by").references(() => profiles.id),
    paidOn: text("paid_on").notNull(),
    note: text().notNull().default(""),
    /** Confirmed payments are never deleted; the owner voids them. Receipts stay, marked void. */
    voidReason: text("void_reason").notNull().default(""),
    voidedBy: text("voided_by").references(() => profiles.id),
    voidedAt: integer("voided_at", { mode: "timestamp_ms" }),
    createdAt: createdAt(),
    /** Set when this month is one part of a multi-month payment (see `paymentBatches`). */
    batchId: integer("batch_id").references(() => paymentBatches.id),
  },
  (t) => [
    index("payments_charge_idx").on(t.chargeId),
    index("payments_batch_idx").on(t.batchId),
    check("payments_status_check", sql`${t.status} in ('pending', 'confirmed', 'rejected', 'void')`),
    check("payments_method_check", sql`${t.method} in ('upi', 'cash', 'bank')`),
    check("payments_amount_check", sql`${t.amount} > 0`),
  ],
);

export const maintenanceRequests = sqliteTable(
  "maintenance_requests",
  {
    id: integer().primaryKey({ autoIncrement: true }),
    unitId: integer("unit_id")
      .notNull()
      .references(() => units.id, { onDelete: "cascade" }),
    raisedBy: text("raised_by").references(() => profiles.id),
    raisedByName: text("raised_by_name").notNull().default(""),
    title: text().notNull(),
    description: text().notNull().default(""),
    priority: text().notNull().default("medium"), // low | medium | high
    status: text().notNull().default("open"), // open | in_progress | done
    assignedTo: text("assigned_to").references(() => profiles.id),
    photoKeys: text("photo_keys", { mode: "json" })
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'`),
    createdAt: createdAt(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull().$defaultFn(now),
    /** Set by the offline outbox (idempotent retries). */
    clientKey: text("client_key"),
  },
  (t) => [
    uniqueIndex("maintenance_requests_client_key_uq").on(t.clientKey),
    index("maintenance_requests_unit_idx").on(t.unitId),
    check("maintenance_requests_status_check", sql`${t.status} in ('open', 'in_progress', 'done')`),
  ],
);

export const requestComments = sqliteTable(
  "request_comments",
  {
    id: integer().primaryKey({ autoIncrement: true }),
    requestId: integer("request_id")
      .notNull()
      .references(() => maintenanceRequests.id, { onDelete: "cascade" }),
    authorId: text("author_id").references(() => profiles.id),
    authorName: text("author_name").notNull().default(""),
    body: text().notNull().default(""),
    photoPath: text("photo_path"),
    createdAt: createdAt(),
  },
  (t) => [index("request_comments_request_idx").on(t.requestId)],
);

export const expenses = sqliteTable(
  "expenses",
  {
    id: integer().primaryKey({ autoIncrement: true }),
    propertyId: integer("property_id")
      .notNull()
      .references(() => properties.id, { onDelete: "cascade" }),
    category: text().notNull(),
    amount: integer().notNull(),
    date: text().notNull(),
    note: text().notNull().default(""),
    submittedBy: text("submitted_by").references(() => profiles.id),
    approved: integer({ mode: "boolean" }).notNull().default(false),
    createdAt: createdAt(),
    /** Set by the offline outbox (idempotent retries). */
    clientKey: text("client_key"),
    /** The recurring expense that generated this row, and the period it covers (YYYY-MM). */
    recurringId: integer("recurring_id").references(() => recurringExpenses.id, { onDelete: "set null" }),
    period: text(),
  },
  (t) => [
    index("expenses_property_idx").on(t.propertyId),
    uniqueIndex("expenses_client_key_uq").on(t.clientKey),
    uniqueIndex("expenses_recurring_period_uq").on(t.recurringId, t.period),
  ],
);

/** Expenses that repeat (society maintenance, property tax, internet). The daily job turns each due period into an `expenses` row. */
export const recurringExpenses = sqliteTable(
  "recurring_expenses",
  {
    id: integer().primaryKey({ autoIncrement: true }),
    ownerId: text("owner_id")
      .notNull()
      .references(() => profiles.id),
    propertyId: integer("property_id")
      .notNull()
      .references(() => properties.id, { onDelete: "cascade" }),
    category: text().notNull(),
    amount: integer().notNull(),
    frequency: text().notNull().default("monthly"), // monthly | quarterly | half_yearly | yearly
    /** YYYY-MM-DD: the next date an expense is generated for. */
    nextDate: text("next_date").notNull(),
    note: text().notNull().default(""),
    active: integer({ mode: "boolean" }).notNull().default(true),
    createdBy: text("created_by").references(() => profiles.id),
    createdAt: createdAt(),
  },
  (t) => [
    index("recurring_expenses_owner_idx").on(t.ownerId),
    check(
      "recurring_expenses_frequency_check",
      sql`${t.frequency} in ('monthly', 'quarterly', 'half_yearly', 'yearly')`,
    ),
    check("recurring_expenses_amount_check", sql`${t.amount} > 0`),
  ],
);

export const activityLog = sqliteTable(
  "activity_log",
  {
    id: integer().primaryKey({ autoIncrement: true }),
    actorId: text("actor_id"),
    action: text().notNull(),
    entity: text().notNull(),
    entityId: text("entity_id"),
    createdAt: createdAt(),
  },
  (t) => [index("activity_log_actor_idx").on(t.actorId, t.createdAt)],
);

/* Meter readings: photo + number (read by Workers AI, confirmed by a person), usage and bill. */
export const meterReadings = sqliteTable(
  "meter_readings",
  {
    id: integer().primaryKey({ autoIncrement: true }),
    unitId: integer("unit_id").references(() => units.id, { onDelete: "cascade" }),
    kind: text().notNull().default("electricity"), // electricity | water
    reading: real(),
    previous: real(),
    usage: real(),
    rate: integer().notNull().default(0), // paise per unit at the time of reading
    amount: integer().notNull().default(0), // bill in rupees
    confidence: real(),
    photoPath: text("photo_path"),
    readOn: text("read_on"),
    /**
     * The charge this reading's bill was added to. Changing it moves the bill: the `meter_bill_*` triggers (defined at the
     * end of the initial migration) add or remove `amount` on the charge in the same statement, so the link
     * and the money can never disagree.
     */
    chargeId: integer("charge_id").references(() => charges.id, { onDelete: "set null" }),
    recordedBy: text("recorded_by").references(() => profiles.id),
    recordedByName: text("recorded_by_name").notNull().default(""),
    /** "pending": a staff reading waiting for the owner (never changes a charge); "approved": saved or approved by the owner. */
    status: text().notNull().default("approved"),
    /** Why the sanity check flagged this reading (unusually high usage), confirmed by the person who saved it. */
    flag: text().notNull().default(""),
    approvedBy: text("approved_by").references(() => profiles.id),
    approvedAt: integer("approved_at", { mode: "timestamp_ms" }),
    createdAt: createdAt(),
    /** Set by the offline outbox: a retried submission returns the first row instead of saving twice. */
    clientKey: text("client_key"),
  },
  (t) => [
    uniqueIndex("meter_readings_client_key_uq").on(t.clientKey),
    index("meter_readings_unit_idx").on(t.unitId, t.kind),
    check("meter_readings_status_check", sql`${t.status} in ('pending', 'approved')`),
    // Usage is null until a reading has one; a NULL passes a CHECK, so only negative values are refused.
    check("meter_readings_usage_check", sql`${t.usage} >= 0`),
    check("meter_readings_amount_check", sql`${t.amount} >= 0`),
  ],
);

/** Receipts (one per confirmed payment) and rental agreements (one per tenancy). PDFs are rendered on request. */
export const documents = sqliteTable(
  "documents",
  {
    id: integer().primaryKey({ autoIncrement: true }),
    ownerId: text("owner_id").references(() => profiles.id),
    tenancyId: integer("tenancy_id").references(() => tenancies.id, { onDelete: "cascade" }),
    paymentId: integer("payment_id").references(() => payments.id, { onDelete: "cascade" }),
    kind: text().notNull(), // receipt | agreement
    number: text().notNull().default(""),
    path: text(),
    createdAt: createdAt(),
    /**
     * A multi-month payment has one receipt for the whole batch. `paymentId` then points at the batch's first month
     * (so the receipt is reachable from any of its months) and `batchId` at the batch.
     */
    batchId: integer("batch_id").references(() => paymentBatches.id),
  },
  (t) => [
    uniqueIndex("documents_payment_uq").on(t.paymentId),
    uniqueIndex("documents_batch_uq").on(t.batchId),
    index("documents_tenancy_idx").on(t.tenancyId),
  ],
);

/** Ready-made workflows per workspace. `name` is the workflow key (see server/domain/automations.ts). */
export const automations = sqliteTable(
  "automations",
  {
    id: integer().primaryKey({ autoIncrement: true }),
    ownerId: text("owner_id").references(() => profiles.id),
    name: text().notNull(),
    config: text({ mode: "json" })
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'`),
    enabled: integer({ mode: "boolean" }).notNull().default(false),
  },
  (t) => [uniqueIndex("automations_owner_name_uq").on(t.ownerId, t.name)],
);

/** Who uploaded each photo. Keys are random, so ownership is checked here. The image itself is in `photo_data`. */
export const photoUploads = sqliteTable(
  "photo_uploads",
  {
    key: text().primaryKey(),
    ownerId: text("owner_id")
      .notNull()
      .references(() => profiles.id),
    uploadedBy: text("uploaded_by").references(() => profiles.id),
    createdAt: createdAt(),
  },
  (t) => [index("photo_uploads_owner_idx").on(t.ownerId)],
);

/**
 * The photo bytes themselves, stored in D1. `data` is base64 text: D1 returns text cheaply,
 * whereas BLOB columns come back as arrays of numbers. A D1 row can hold 2 MB, so uploads are capped well below that
 * (MAX_PHOTO_BYTES in worker/server/core/storage.ts).
 */
export const photoData = sqliteTable("photo_data", {
  key: text().primaryKey(),
  data: text().notNull(),
  size: integer().notNull(),
  createdAt: createdAt(),
});

/** Short-lived counters for database-backed abuse limits (D1 is strongly consistent, unlike KV). */
export const rateLimits = sqliteTable(
  "rate_limits",
  {
    key: text().notNull(),
    bucket: text().notNull(),
    count: integer().notNull().default(0),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull().$defaultFn(now),
  },
  (t) => [
    uniqueIndex("rate_limits_key_bucket_uq").on(t.key, t.bucket),
    index("rate_limits_updated_idx").on(t.updatedAt),
  ],
);

/** Generated server secrets (for example the photo-link signing key when SIGNING_SECRET isn't set). */
export const appSecrets = sqliteTable("app_secrets", {
  name: text().primaryKey(),
  value: text().notNull(),
  createdAt: createdAt(),
});

/* ---------- leases, move-out, fees, notifications ---------- */

/**
 * Append-only lease history. The first row (`initial`) mirrors the tenancy as it started; every renewal or rent
 * revision adds a row. `tenancies.rent` / `end_date` always hold the latest term.
 */
export const leaseTerms = sqliteTable(
  "lease_terms",
  {
    id: integer().primaryKey({ autoIncrement: true }),
    ownerId: text("owner_id")
      .notNull()
      .references(() => profiles.id),
    tenancyId: integer("tenancy_id")
      .notNull()
      .references(() => tenancies.id, { onDelete: "cascade" }),
    /** YYYY-MM-DD: the day this term (and its rent) starts. */
    startDate: text("start_date").notNull(),
    endDate: text("end_date"),
    rent: integer().notNull(),
    dueDay: integer("due_day").notNull(),
    deposit: integer().notNull().default(0),
    reason: text().notNull().default("initial"), // initial | renewal | revision
    note: text().notNull().default(""),
    createdBy: text("created_by").references(() => profiles.id),
    createdAt: createdAt(),
  },
  (t) => [
    index("lease_terms_tenancy_idx").on(t.tenancyId, t.startDate),
    index("lease_terms_owner_idx").on(t.ownerId),
    check("lease_terms_reason_check", sql`${t.reason} in ('initial', 'renewal', 'revision')`),
    check("lease_terms_rent_check", sql`${t.rent} > 0`),
  ],
);

/** Move-out and deposit settlement, one per tenancy. Numbers are computed by the server; `final` freezes them. */
export const settlements = sqliteTable(
  "settlements",
  {
    id: integer().primaryKey({ autoIncrement: true }),
    ownerId: text("owner_id")
      .notNull()
      .references(() => profiles.id),
    tenancyId: integer("tenancy_id")
      .notNull()
      .references(() => tenancies.id, { onDelete: "cascade" }),
    moveOutDate: text("move_out_date").notNull(),
    depositHeld: integer("deposit_held").notNull().default(0),
    outstandingRent: integer("outstanding_rent").notNull().default(0),
    pendingUtilities: integer("pending_utilities").notNull().default(0),
    advanceUnused: integer("advance_unused").notNull().default(0),
    /** deposit - deductions + unused advance. Negative: the tenant owes this much. */
    refundAmount: integer("refund_amount").notNull().default(0),
    refundStatus: text("refund_status").notNull().default("pending"), // pending | paid
    refundMethod: text("refund_method").notNull().default(""),
    refundRef: text("refund_ref").notNull().default(""),
    refundPaidOn: text("refund_paid_on"),
    status: text().notNull().default("draft"), // draft | final
    note: text().notNull().default(""),
    number: text().notNull().default(""),
    finalizedAt: integer("finalized_at", { mode: "timestamp_ms" }),
    finalizedBy: text("finalized_by").references(() => profiles.id),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("settlements_tenancy_uq").on(t.tenancyId),
    index("settlements_owner_idx").on(t.ownerId),
    check("settlements_status_check", sql`${t.status} in ('draft', 'final')`),
    check("settlements_refund_status_check", sql`${t.refundStatus} in ('pending', 'paid')`),
  ],
);

export const settlementDeductions = sqliteTable(
  "settlement_deductions",
  {
    id: integer().primaryKey({ autoIncrement: true }),
    settlementId: integer("settlement_id")
      .notNull()
      .references(() => settlements.id, { onDelete: "cascade" }),
    kind: text().notNull(), // damage | rent | utility | other
    description: text().notNull().default(""),
    amount: integer().notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    index("settlement_deductions_settlement_idx").on(t.settlementId),
    check("settlement_deductions_kind_check", sql`${t.kind} in ('damage', 'rent', 'utility', 'other')`),
    check("settlement_deductions_amount_check", sql`${t.amount} > 0`),
  ],
);

/**
 * Late fees (and later other adjustments) on a charge. Unique per charge, kind and period, so the daily job can never
 * apply the same fee twice. Triggers keep `charges.fees` and `charges.amount` in step (insert adds, waive removes).
 */
export const chargeAdjustments = sqliteTable(
  "charge_adjustments",
  {
    id: integer().primaryKey({ autoIncrement: true }),
    ownerId: text("owner_id")
      .notNull()
      .references(() => profiles.id),
    chargeId: integer("charge_id")
      .notNull()
      .references(() => charges.id, { onDelete: "cascade" }),
    kind: text().notNull().default("late_fee"), // late_fee
    /** What the fee is for: "once" for a flat or percent fee, YYYY-MM-DD for a per-day fee. */
    period: text().notNull(),
    amount: integer().notNull(),
    note: text().notNull().default(""),
    waivedAt: integer("waived_at", { mode: "timestamp_ms" }),
    waivedBy: text("waived_by").references(() => profiles.id),
    waiveReason: text("waive_reason").notNull().default(""),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("charge_adjustments_charge_kind_period_uq").on(t.chargeId, t.kind, t.period),
    index("charge_adjustments_owner_idx").on(t.ownerId),
    check("charge_adjustments_kind_check", sql`${t.kind} in ('late_fee')`),
    check("charge_adjustments_amount_check", sql`${t.amount} > 0`),
  ],
);

/** In-app inbox. `dedupe_key` is unique, so an event (or a daily alert) notifies each person once. */
export const notifications = sqliteTable(
  "notifications",
  {
    id: integer().primaryKey({ autoIncrement: true }),
    ownerId: text("owner_id")
      .notNull()
      .references(() => profiles.id),
    recipientId: text("recipient_id")
      .notNull()
      .references(() => profiles.id, { onDelete: "cascade" }),
    kind: text().notNull(),
    title: text().notNull(),
    body: text().notNull().default(""),
    /** In-app path to open (for example /tenants/4). */
    url: text().notNull().default("/"),
    entity: text().notNull().default(""),
    entityId: text("entity_id"),
    dedupeKey: text("dedupe_key").notNull(),
    readAt: integer("read_at", { mode: "timestamp_ms" }),
    pushedAt: integer("pushed_at", { mode: "timestamp_ms" }),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("notifications_dedupe_uq").on(t.dedupeKey),
    index("notifications_recipient_idx").on(t.recipientId, t.createdAt),
    index("notifications_owner_idx").on(t.ownerId),
  ],
);

/** Web Push subscriptions, one per browser. Expired endpoints (404/410 from the push service) are deleted. */
export const pushSubscriptions = sqliteTable(
  "push_subscriptions",
  {
    id: integer().primaryKey({ autoIncrement: true }),
    userId: text("user_id")
      .notNull()
      .references(() => profiles.id, { onDelete: "cascade" }),
    ownerId: text("owner_id")
      .notNull()
      .references(() => profiles.id),
    endpoint: text().notNull(),
    p256dh: text().notNull().default(""),
    auth: text().notNull().default(""),
    userAgent: text("user_agent").notNull().default(""),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("push_subscriptions_endpoint_uq").on(t.endpoint),
    index("push_subscriptions_user_idx").on(t.userId),
  ],
);
