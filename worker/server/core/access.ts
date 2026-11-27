/**
 * Pure authorization rules. Every data read/write in the API goes through these,
 * so they can be unit-tested without a database (see tests/unit/access.test.ts).
 */
export type Role = "owner" | "staff" | "tenant";
export interface Actor {
  id: string;
  role: Role;
  ownerId: string;
  name: string;
  /** For tenants: tenant record ids linked to this sign-in. */
  tenantIds: number[];
}

/** Charges, payments and ledgers: the workspace owner or the tenant on the tenancy. Never staff. */
export function canReadLedger(actor: Actor, rec: { ownerId: string; tenantId: number }): boolean {
  if (actor.ownerId !== rec.ownerId) return false;
  if (actor.role === "owner") return true;
  if (actor.role === "tenant") return actor.tenantIds.includes(rec.tenantId);
  return false;
}

/** Maintenance requests: owner and staff see all in their workspace; tenants only their units or ones they raised. */
export function canReadRequest(
  actor: Actor,
  rec: { ownerId: string; unitTenantIds: number[]; raisedBy: string | null },
): boolean {
  if (actor.ownerId !== rec.ownerId) return false;
  if (actor.role === "owner" || actor.role === "staff") return true;
  return rec.raisedBy === actor.id || rec.unitTenantIds.some((t) => actor.tenantIds.includes(t));
}

/**
 * Comments on a maintenance request: owner and staff on any request they can read; tenants only on requests
 * they raised themselves (they can still read requests for their unit).
 */
export function canCommentOnRequest(
  actor: Actor,
  rec: { ownerId: string; unitTenantIds: number[]; raisedBy: string | null },
): boolean {
  if (!canReadRequest(actor, rec)) return false;
  if (actor.role === "owner" || actor.role === "staff") return true;
  return rec.raisedBy === actor.id;
}

/** Tenant records: owner fully, staff view-only (no ledger), tenants only their own record. */
export function canReadTenant(actor: Actor, rec: { ownerId: string; tenantId: number }): boolean {
  if (actor.ownerId !== rec.ownerId) return false;
  if (actor.role === "owner" || actor.role === "staff") return true;
  return actor.tenantIds.includes(rec.tenantId);
}

export const canUpdateRequestStatus = (a: Actor) => a.role === "owner" || a.role === "staff";
export const canManage = (a: Actor) => a.role === "owner";
export const canViewUnits = (a: Actor) => a.role === "owner" || a.role === "staff";
export const canLogExpense = (a: Actor) => a.role === "owner" || a.role === "staff";
