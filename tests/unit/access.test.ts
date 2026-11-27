/**
 * Proves tenant isolation: a tenant can never read another tenant's ledger, record or
 * requests, staff never see ledgers, and nobody crosses into another owner's workspace.
 * Every API read goes through these rules (server/access.ts).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  canCommentOnRequest,
  canReadLedger,
  canReadRequest,
  canReadTenant,
  canManage,
  canUpdateRequestStatus,
  canLogExpense,
  canViewUnits,
  type Actor,
} from "../../worker/server/core/access.ts";

const OWNER = "owner-1";
const owner: Actor = { id: OWNER, role: "owner", ownerId: OWNER, name: "Owner", tenantIds: [] };
const staff: Actor = { id: "staff-1", role: "staff", ownerId: OWNER, name: "Caretaker", tenantIds: [] };
const asha: Actor = { id: "user-asha", role: "tenant", ownerId: OWNER, name: "Asha", tenantIds: [1] };
const ravi: Actor = { id: "user-ravi", role: "tenant", ownerId: OWNER, name: "Ravi", tenantIds: [2] };
const otherOwner: Actor = { id: "owner-2", role: "owner", ownerId: "owner-2", name: "Other", tenantIds: [] };

const ashaLedger = { ownerId: OWNER, tenantId: 1 };
const raviLedger = { ownerId: OWNER, tenantId: 2 };

test("a tenant reads only their own charges and payments", () => {
  assert.equal(canReadLedger(asha, ashaLedger), true);
  assert.equal(canReadLedger(asha, raviLedger), false);
  assert.equal(canReadLedger(ravi, ashaLedger), false);
});

test("a tenant reads only their own tenant record", () => {
  assert.equal(canReadTenant(asha, ashaLedger), true);
  assert.equal(canReadTenant(asha, raviLedger), false);
});

test("a tenant sees requests they raised or for their own unit only", () => {
  const ashaUnit = { ownerId: OWNER, unitTenantIds: [1], raisedBy: OWNER };
  const raviUnit = { ownerId: OWNER, unitTenantIds: [2], raisedBy: "user-ravi" };
  assert.equal(canReadRequest(asha, ashaUnit), true);
  assert.equal(canReadRequest(asha, raviUnit), false);
  assert.equal(canReadRequest(asha, { ownerId: OWNER, unitTenantIds: [], raisedBy: "user-asha" }), true);
});

test("tenants comment only on requests they raised; owner and staff on any", () => {
  const raisedByAsha = { ownerId: OWNER, unitTenantIds: [1], raisedBy: "user-asha" };
  const raisedByOwner = { ownerId: OWNER, unitTenantIds: [1], raisedBy: OWNER };
  assert.equal(canCommentOnRequest(asha, raisedByAsha), true);
  assert.equal(canReadRequest(asha, raisedByOwner), true); // still visible on her unit…
  assert.equal(canCommentOnRequest(asha, raisedByOwner), false); // …but read-only
  assert.equal(canCommentOnRequest(ravi, raisedByAsha), false);
  assert.equal(canCommentOnRequest(owner, raisedByAsha), true);
  assert.equal(canCommentOnRequest(staff, raisedByOwner), true);
  assert.equal(canCommentOnRequest(otherOwner, raisedByAsha), false);
});

test("staff never see rent ledgers but can view tenants and requests", () => {
  assert.equal(canReadLedger(staff, ashaLedger), false);
  assert.equal(canReadTenant(staff, ashaLedger), true);
  assert.equal(canReadRequest(staff, { ownerId: OWNER, unitTenantIds: [2], raisedBy: null }), true);
});

test("nobody reads another owner's workspace", () => {
  assert.equal(canReadLedger(otherOwner, ashaLedger), false);
  assert.equal(canReadTenant(otherOwner, ashaLedger), false);
  assert.equal(canReadRequest(otherOwner, { ownerId: OWNER, unitTenantIds: [1], raisedBy: null }), false);
  const foreignTenant: Actor = { ...asha, ownerId: "owner-2" };
  assert.equal(canReadLedger(foreignTenant, ashaLedger), false);
});

test("role capabilities match the permissions table", () => {
  assert.deepEqual([canManage(owner), canManage(staff), canManage(asha)], [true, false, false]);
  assert.deepEqual(
    [canUpdateRequestStatus(owner), canUpdateRequestStatus(staff), canUpdateRequestStatus(asha)],
    [true, true, false],
  );
  assert.deepEqual([canLogExpense(owner), canLogExpense(staff), canLogExpense(asha)], [true, true, false]);
  assert.deepEqual([canViewUnits(owner), canViewUnits(staff), canViewUnits(asha)], [true, true, false]);
});
