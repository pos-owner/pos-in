import { useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { api, ApiError, useApi } from "../../lib/api";
import { parseRentAmount, rupees, todayISO } from "../../lib/format";
import type { TenantListItem, WorkspaceResponse } from "../../lib/types";
import {
  Avatar,
  Empty,
  ErrorState,
  Field,
  FormError,
  NavButton,
  Page,
  Section,
  SelectField,
  Sheet,
  Skeleton,
  Spinner,
  StatusPill,
  useToast,
} from "../../components/kit";
import { I } from "../../components/icons";
import { refreshRent } from "./ChargeSheet";
import "../../styles/owner.css";
import { useT } from "../../lib/i18n";

export default function Tenants() {
  const tx = useT();
  const { data, error, loading, reload } = useApi<TenantListItem[]>("/api/tenants");
  const [params, setParams] = useSearchParams();
  const [adding, setAdding] = useState(params.get("new") === "1");
  const [q, setQ] = useState("");
  const nav = useNavigate();

  const { active, past } = useMemo(() => {
    const s = q.trim().toLowerCase();
    const list = (data ?? []).filter(
      (t) => !s || [t.fullName, t.unitLabel, t.propertyName, t.phone].some((x) => x.toLowerCase().includes(s)),
    );
    return { active: list.filter((t) => t.active), past: list.filter((t) => !t.active) };
  }, [data, q]);

  const owed = (data ?? []).reduce((s, t) => s + (t.balance ?? 0), 0);
  const close = () => {
    setAdding(false);
    if (params.get("new")) setParams({}, { replace: true });
  };

  return (
    <Page
      title="Tenants"
      eyebrow={
        data
          ? tx("{n} active{value}", {
              n: data.filter((t) => t.active).length,
              value: owed ? ` · ${rupees(owed)} outstanding` : "",
            })
          : undefined
      }
      right={<NavButton icon="plus" label="Add tenant" accent onClick={() => setAdding(true)} />}
    >
      {(data?.length ?? 0) > 4 && (
        <div className="pad mb16">
          <label className="search">
            <I.search />
            <input
              type="search"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder={tx("Search name, unit or phone")}
              aria-label={tx("Search tenants")}
            />
          </label>
        </div>
      )}
      {loading ? (
        <Section>
          <Skeleton rows={6} />
        </Section>
      ) : error || !data ? (
        <ErrorState error={error ?? { message: "Couldn't load tenants." }} retry={reload} />
      ) : !data.length ? (
        <Empty
          icon="people"
          title="No tenants yet"
          text="Add a tenant to a unit with their rent and due day. Their monthly charges start right away."
          action={
            <button className="btn md auto" onClick={() => setAdding(true)}>
              <I.userPlus /> {tx("Add tenant")}
            </button>
          }
        />
      ) : !active.length && !past.length ? (
        <Empty icon="search" title="No matches" text={tx("No tenant matches “{q}”.", { q })} />
      ) : (
        <>
          {active.length > 0 && (
            <Section title={past.length ? tx("Current") : undefined}>
              <div className="list dense">
                {active.map((t) => (
                  <TenantLine key={t.id} t={t} onOpen={() => nav(`/tenants/${t.id}`)} />
                ))}
              </div>
            </Section>
          )}
          {past.length > 0 && (
            <Section title="Past tenants">
              <div className="list dense">
                {past.map((t) => (
                  <TenantLine key={t.id} t={t} onOpen={() => nav(`/tenants/${t.id}`)} />
                ))}
              </div>
            </Section>
          )}
        </>
      )}
      <AddTenantSheet
        open={adding}
        onClose={close}
        onAdded={(id) => {
          close();
          nav(`/tenants/${id}`);
        }}
      />
    </Page>
  );
}

function TenantLine({ t, onOpen }: { t: TenantListItem; onOpen: () => void }) {
  const tx = useT();
  let end;
  if (!t.active) end = <span className="pill gray">{tx("Moved out")}</span>;
  else if (t.awaiting)
    end = (
      <span className="stack">
        <span className="num money">{rupees(t.balance)}</span>
        <StatusPill status="awaiting" />
      </span>
    );
  else if (t.overdue)
    end = (
      <span className="stack">
        <span className="num money c-red">{rupees(t.balance)}</span>
        <StatusPill status="overdue" />
      </span>
    );
  else if (t.balance)
    end = (
      <span className="stack">
        <span className="num money">{rupees(t.balance)}</span>
        <StatusPill status="due" />
      </span>
    );
  else end = <StatusPill status="paid" label="Paid up" />;
  return (
    <button type="button" className="row" onClick={onOpen}>
      <Avatar name={t.fullName} />
      <span className="grow">
        <span className="title" style={{ display: "block" }}>
          {t.fullName}
        </span>
        <span className="sub" style={{ display: "block" }}>
          {[t.unitLabel, t.propertyName].filter(Boolean).join(" · ") || tx("No unit")}
          {t.active && !t.linked && tx(" · not on app")}
        </span>
      </span>
      <span className="end">
        {end}
        <I.chevR className="chev" />
      </span>
    </button>
  );
}

const blank = {
  fullName: "",
  phone: "",
  email: "",
  rent: "",
  dueDay: "5",
  deposit: "",
  startDate: todayISO(),
  endDate: "",
  idNote: "",
  emergencyContact: "",
};

export function AddTenantSheet({
  open,
  onClose,
  onAdded,
  unitId,
}: {
  open: boolean;
  onClose: () => void;
  onAdded: (id: number) => void;
  unitId?: number;
}) {
  const tx = useT();
  const ws = useApi<WorkspaceResponse>(open ? "/api/workspace" : null);
  const toast = useToast();
  const [f, setF] = useState(blank);
  const [unit, setUnit] = useState<number>(unitId ?? 0);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const set = (k: keyof typeof blank) => (v: string) => setF((x) => ({ ...x, [k]: v }));

  const vacant = (ws.data?.properties ?? []).flatMap((p) =>
    p.units.filter((u) => !u.tenancy).map((u) => ({ ...u, propertyName: p.name })),
  );

  function chooseUnit(id: number) {
    setUnit(id);
    const u = vacant.find((x) => x.id === id);
    if (u?.baseRent) setF((x) => ({ ...x, rent: String(u.baseRent), deposit: x.deposit || String(u.baseRent * 2) }));
  }

  async function save() {
    const rent = parseRentAmount(f.rent, 1);
    const deposit = parseRentAmount(f.deposit);
    if (!f.fullName.trim()) return setErr("Enter the tenant's name.");
    if (!unit) return setErr("Choose a vacant unit.");
    if (rent === null) return setErr("Enter a valid monthly rent.");
    if (deposit === null) return setErr("Enter a valid deposit.");
    const due = Number(f.dueDay);
    if (!Number.isInteger(due) || due < 1 || due > 28) return setErr("The due day must be between 1 and 28.");
    if (f.phone && f.phone.replace(/\D/g, "").length < 10)
      return setErr("Enter a 10-digit mobile number, or leave it blank.");
    setBusy(true);
    setErr("");
    try {
      const t = await api<{ id: number }>("/api/tenants", {
        body: {
          ...f,
          unitId: unit,
          rent,
          dueDay: due,
          deposit,
          endDate: f.endDate || null,
        },
      });
      refreshRent();
      ws.reload();
      toast(`${f.fullName.trim().split(" ")[0]} added`);
      setF(blank);
      setUnit(0);
      onAdded(t.id);
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : "Couldn't add the tenant.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Sheet open={open} onClose={onClose} title="New tenant" onDone={save} doneLabel="Add tenant" busy={busy}>
      {ws.loading ? (
        <Section>
          <Skeleton rows={3} avatar={false} />
        </Section>
      ) : !vacant.length ? (
        <Empty
          icon="key"
          title="No vacant units"
          text="Every unit has an active tenant. Add a unit, or end a tenancy first."
        />
      ) : (
        <>
          <Section title="Tenant">
            <div className="list">
              <Field
                label="Name"
                value={f.fullName}
                onChange={set("fullName")}
                placeholder="Full name"
                autoComplete="off"
                maxLength={80}
              />
              <Field
                label="Mobile"
                value={f.phone}
                onChange={set("phone")}
                type="tel"
                inputMode="tel"
                placeholder="98450 12345"
                maxLength={20}
              />
              <Field
                label="Email"
                value={f.email}
                onChange={set("email")}
                type="email"
                inputMode="email"
                placeholder="Optional"
                maxLength={120}
              />
            </div>
          </Section>
          <Section
            title="Tenancy"
            footer="Charges are created for each month from the start date. Due days are capped at 28 so every month has one."
          >
            <div className="list">
              <SelectField
                label="Unit"
                value={unit}
                onChange={chooseUnit}
                options={[
                  { value: 0, label: "Choose…" },
                  ...vacant.map((u) => ({ value: u.id, label: `${u.label} · ${u.propertyName}` })),
                ]}
              />
              <Field
                label="Monthly rent"
                value={f.rent}
                onChange={set("rent")}
                inputMode="numeric"
                prefix="₹"
                placeholder="0"
              />
              <Field
                label="Due day"
                value={f.dueDay}
                onChange={set("dueDay")}
                inputMode="numeric"
                placeholder="5"
                maxLength={2}
              />
              <Field
                label="Deposit"
                value={f.deposit}
                onChange={set("deposit")}
                inputMode="numeric"
                prefix="₹"
                placeholder="0"
              />
              <Field label="Start date" type="date" value={f.startDate} onChange={set("startDate")} />
              <Field label="End date" type="date" value={f.endDate} onChange={set("endDate")} />
            </div>
          </Section>
          <Section title="Records">
            <div className="list">
              <Field
                label="ID note"
                value={f.idNote}
                onChange={set("idNote")}
                placeholder="e.g. Aadhaar ending 4417"
                maxLength={200}
              />
              <Field
                label="Emergency"
                value={f.emergencyContact}
                onChange={set("emergencyContact")}
                placeholder="Name and phone"
                maxLength={120}
              />
            </div>
            <FormError text={err} />
            <button className="btn mt16" onClick={save} disabled={busy}>
              {busy ? <Spinner /> : tx("Add tenant")}
            </button>
          </Section>
        </>
      )}
    </Sheet>
  );
}
