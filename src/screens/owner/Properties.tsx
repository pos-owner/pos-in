import { useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { api, ApiError, invalidate, useApi } from "../../lib/api";
import { parseRentAmount, rupees } from "../../lib/format";
import type { WorkspaceProperty, WorkspaceResponse, WorkspaceUnit } from "../../lib/types";
import {
  Avatar,
  Empty,
  ErrorState,
  Field,
  FormError,
  NavButton,
  Page,
  Section,
  Sheet,
  Skeleton,
  Spinner,
  useToast,
} from "../../components/kit";
import { I } from "../../components/icons";
import "../../styles/ops.css";
import "../../styles/owner.css";
import { useT } from "../../lib/i18n";

const TYPES = ["1RK", "1BHK", "2BHK", "3BHK", "Studio", "Shop", "Other"];

type Edit = { kind: "property"; p?: WorkspaceProperty } | { kind: "unit"; propertyId: number; u?: WorkspaceUnit };

export default function Properties() {
  const tx = useT();
  const { data, error, loading, reload } = useApi<WorkspaceResponse>("/api/workspace");
  const [params, setParams] = useSearchParams();
  const [edit, setEdit] = useState<Edit | null>(params.get("new") === "1" ? { kind: "property" } : null);
  const nav = useNavigate();

  const close = () => {
    setEdit(null);
    if (params.get("new")) setParams({}, { replace: true });
  };
  const units = (data?.properties ?? []).flatMap((p) => p.units);

  return (
    <Page
      title="Properties"
      back="/more"
      eyebrow={
        data
          ? tx("{n} properties · {n2}/{n3} units let", {
              n: data.properties.length,
              n2: units.filter((u) => u.tenancy).length,
              n3: units.length,
            })
          : undefined
      }
      right={<NavButton icon="plus" label="Add property" accent onClick={() => setEdit({ kind: "property" })} />}
    >
      {loading ? (
        <Section>
          <Skeleton rows={4} />
        </Section>
      ) : error || !data ? (
        <ErrorState error={error ?? { message: "Couldn't load properties." }} retry={reload} />
      ) : !data.properties.length ? (
        <Empty
          icon="building"
          title="No properties yet"
          text="Add a building or house, then its flats, floors or rooms as units."
          action={
            <button className="btn md auto" onClick={() => setEdit({ kind: "property" })}>
              <I.plus /> {tx("Add property")}
            </button>
          }
        />
      ) : (
        data.properties.map((p) => (
          <Section
            key={p.id}
            title={p.name}
            action={<button onClick={() => setEdit({ kind: "property", p })}>{tx("Edit")}</button>}
            footer={p.address || undefined}
          >
            <div className="list">
              {p.units.map((u) => (
                <button
                  type="button"
                  key={u.id}
                  className="row"
                  onClick={() => setEdit({ kind: "unit", propertyId: p.id, u })}
                >
                  {u.tenancy ? (
                    <Avatar name={u.tenancy.tenantName} />
                  ) : (
                    <span
                      className="icon-sq"
                      style={{
                        background: "var(--fill)",
                        color: "var(--label-2)",
                        width: 40,
                        height: 40,
                        borderRadius: 20,
                      }}
                    >
                      <I.key />
                    </span>
                  )}
                  <span className="grow">
                    <span className="title" style={{ display: "block" }}>
                      {u.label}
                    </span>
                    <span className="sub" style={{ display: "block" }}>
                      {u.type}
                      {u.tenancy ? ` · ${u.tenancy.tenantName}` : ""}
                    </span>
                  </span>
                  <span className="end">
                    <span className="stack">
                      <span className="num w6">{rupees(u.tenancy?.rent ?? u.baseRent)}</span>
                      {u.tenancy ? (
                        <span className="pill green">{tx("Let")}</span>
                      ) : (
                        <span className="pill gray">{tx("Vacant")}</span>
                      )}
                    </span>
                    <I.chevR className="chev" />
                  </span>
                </button>
              ))}
              <button type="button" className="row" onClick={() => setEdit({ kind: "unit", propertyId: p.id })}>
                <span
                  className="icon-sq"
                  style={{
                    background: "var(--accent-tint)",
                    color: "var(--accent-press)",
                    width: 40,
                    height: 40,
                    borderRadius: 20,
                  }}
                >
                  <I.plus />
                </span>
                <span className="grow title c-accent">{tx("Add unit")}</span>
              </button>
            </div>
          </Section>
        ))
      )}
      <Sheet
        open={!!edit}
        onClose={close}
        title={
          !edit
            ? ""
            : edit.kind === "property"
              ? edit.p
                ? tx("Edit property")
                : tx("New property")
              : edit.u
                ? edit.u.label
                : tx("New unit")
        }
      >
        {edit?.kind === "property" && <PropertyForm key={edit.p?.id ?? "new"} p={edit.p} onDone={close} />}
        {edit?.kind === "unit" && (
          <UnitForm
            key={edit.u?.id ?? `new${edit.propertyId}`}
            propertyId={edit.propertyId}
            u={edit.u}
            onDone={close}
            onTenant={(id) => {
              close();
              nav(`/tenants/${id}`);
            }}
            onAddTenant={() => {
              close();
              nav("/tenants?new=1");
            }}
          />
        )}
      </Sheet>
    </Page>
  );
}

function useSave() {
  const toast = useToast();
  const [busy, setBusy] = useState("");
  const [err, setErr] = useState("");
  async function run(tag: string, fn: () => Promise<unknown>, done: string) {
    setBusy(tag);
    setErr("");
    try {
      await fn();
      invalidate("/api/workspace", "/api/dashboard", "/api/ledger", "/api/tenants", "/api/expenses");
      toast(done);
      return true;
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : "That didn't work. Please try again.");
      return false;
    } finally {
      setBusy("");
    }
  }
  return { busy, err, setErr, run };
}

function PropertyForm({ p, onDone }: { p?: WorkspaceProperty; onDone: () => void }) {
  const tx = useT();
  const [name, setName] = useState(p?.name ?? "");
  const [address, setAddress] = useState(p?.address ?? "");
  const [confirm, setConfirm] = useState(false);
  const s = useSave();
  const hasTenants = !!p?.units.some((u) => u.tenancy);

  async function save() {
    if (!name.trim()) return s.setErr("Give the property a name.");
    const ok = await s.run(
      "save",
      () =>
        p
          ? api(`/api/properties/${p.id}`, { method: "PATCH", body: { name: name.trim(), address: address.trim() } })
          : api("/api/properties", { body: { name: name.trim(), address: address.trim() } }),
      p ? "Property saved" : "Property added",
    );
    if (ok) onDone();
  }
  async function remove() {
    if (!p) return;
    if (!confirm) return setConfirm(true);
    if (await s.run("del", () => api(`/api/properties/${p.id}`, { method: "DELETE" }), "Property deleted")) onDone();
  }

  return (
    <>
      <Section footer={p ? undefined : tx("Next, add its units: flats, floors or rooms you rent out.")}>
        <div className="list">
          <Field
            label="Name"
            value={name}
            onChange={setName}
            placeholder="e.g. Lakshmi Nilaya"
            maxLength={80}
            autoFocus={!p}
          />
          <Field
            label="Address"
            type="textarea"
            value={address}
            onChange={setAddress}
            placeholder="Street, area, city, PIN"
            maxLength={200}
            stack
          />
        </div>
        <FormError text={s.err} />
        <button className="btn mt16" onClick={save} disabled={!!s.busy}>
          {s.busy === "save" ? <Spinner /> : p ? tx("Save") : tx("Add property")}
        </button>
      </Section>
      {p && (
        <Section>
          <button className="btn danger" onClick={remove} disabled={!!s.busy || hasTenants}>
            {s.busy === "del" ? (
              <Spinner />
            ) : confirm ? (
              tx("Tap again to delete everything")
            ) : (
              <>
                <I.trash /> {tx("Delete property")}
              </>
            )}
          </button>
          <div className="confirm-text" style={{ color: hasTenants ? "var(--label-2)" : undefined }}>
            {hasTenants
              ? tx("End the active tenancies before deleting this property.")
              : confirm
                ? tx("This removes its units, rent history, requests and expenses.")
                : ""}
          </div>
        </Section>
      )}
    </>
  );
}

function UnitForm({
  propertyId,
  u,
  onDone,
  onTenant,
  onAddTenant,
}: {
  propertyId: number;
  u?: WorkspaceUnit;
  onDone: () => void;
  onTenant: (id: number) => void;
  onAddTenant: () => void;
}) {
  const tx = useT();
  const [label, setLabel] = useState(u?.label ?? "");
  const [type, setType] = useState(u?.type ?? "1BHK");
  const [rent, setRent] = useState(u ? String(u.baseRent || "") : "");
  const [confirm, setConfirm] = useState(false);
  const s = useSave();

  async function save() {
    if (!label.trim()) return s.setErr("Give the unit a name, like A-101.");
    const baseRent = parseRentAmount(rent);
    if (baseRent === null) return s.setErr("Enter a valid usual rent.");
    const body = { label: label.trim(), type, baseRent };
    const ok = await s.run(
      "save",
      () =>
        u ? api(`/api/units/${u.id}`, { method: "PATCH", body }) : api("/api/units", { body: { ...body, propertyId } }),
      u ? "Unit saved" : "Unit added",
    );
    if (ok) onDone();
  }
  async function remove() {
    if (!u) return;
    if (!confirm) return setConfirm(true);
    if (await s.run("del", () => api(`/api/units/${u.id}`, { method: "DELETE" }), "Unit deleted")) onDone();
  }

  return (
    <>
      {u?.tenancy ? (
        <Section>
          <div className="list">
            <button type="button" className="row" onClick={() => onTenant(u.tenancy!.tenantId)}>
              <Avatar name={u.tenancy.tenantName} />
              <span className="grow">
                <span className="title" style={{ display: "block" }}>
                  {u.tenancy.tenantName}
                </span>
                <span className="sub" style={{ display: "block" }}>
                  {tx("Current tenant{value}", { value: u.tenancy.rent ? ` · ${rupees(u.tenancy.rent)}/month` : "" })}
                </span>
              </span>
              <span className="end">
                <I.chevR className="chev" />
              </span>
            </button>
          </div>
        </Section>
      ) : u ? (
        <Section>
          <button className="btn tinted md" onClick={onAddTenant}>
            <I.userPlus /> {tx("Add a tenant to this unit")}
          </button>
        </Section>
      ) : null}
      <Section footer="The usual rent is suggested when you add a tenant. Each tenancy keeps its own rent.">
        <div className="list">
          <Field
            label="Name"
            value={label}
            onChange={setLabel}
            placeholder="e.g. A-101 or First floor"
            maxLength={40}
            autoFocus={!u}
          />
          <Field label="Usual rent" value={rent} onChange={setRent} inputMode="numeric" prefix="₹" placeholder="0" />
        </div>
      </Section>
      <Section title="Type">
        <div className="chips" style={{ flexWrap: "wrap", margin: 0, padding: 0 }}>
          {TYPES.map((t) => (
            <button key={t} type="button" className="chip" aria-pressed={type === t} onClick={() => setType(t)}>
              {t}
            </button>
          ))}
        </div>
        <FormError text={s.err} />
        <button className="btn mt16" onClick={save} disabled={!!s.busy}>
          {s.busy === "save" ? <Spinner /> : u ? tx("Save") : tx("Add unit")}
        </button>
      </Section>
      {u && !u.tenancy && (
        <Section>
          <button className="btn danger" onClick={remove} disabled={!!s.busy}>
            {s.busy === "del" ? (
              <Spinner />
            ) : confirm ? (
              tx("Tap again to delete")
            ) : (
              <>
                <I.trash /> {tx("Delete unit")}
              </>
            )}
          </button>
          {confirm && (
            <div className="confirm-text">{tx("This also removes the unit's past rent history and requests.")}</div>
          )}
        </Section>
      )}
    </>
  );
}
