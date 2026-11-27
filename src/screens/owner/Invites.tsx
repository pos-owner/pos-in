import { useState } from "react";
import { useSearchParams } from "react-router-dom";
import { api, ApiError, invalidate, useApi } from "../../lib/api";
import { useAuth } from "../../lib/auth";
import { activityLabel, dateLabel, relTime } from "../../lib/format";
import type { CreatedInvite, InvitesResponse, TenantListItem } from "../../lib/types";
import {
  Avatar,
  copyText,
  Empty,
  ErrorState,
  Field,
  FormError,
  NavButton,
  Page,
  Row,
  Section,
  Segmented,
  SelectField,
  Sheet,
  Skeleton,
  Spinner,
  useToast,
} from "../../components/kit";
import { I } from "../../components/icons";
import { InviteResult, inviteUrl } from "./InviteResult";
import { ResetLinkSheet, type Person } from "./ResetLinkSheet";
import "../../styles/owner.css";
import { useT } from "../../lib/i18n";

const STATE: Record<string, { label: string; cls: string }> = {
  valid: { label: "Waiting", cls: "orange" },
  claimed: { label: "Joined", cls: "green" },
  expired: { label: "Expired", cls: "gray" },
  locked: { label: "Locked", cls: "red" },
};

export default function Invites() {
  const tx = useT();
  const { data, error, loading, reload } = useApi<InvitesResponse>("/api/invites");
  const [params, setParams] = useSearchParams();
  const [open, setOpen] = useState(params.get("new") === "1");
  const [revoking, setRevoking] = useState<number | null>(null);
  const [person, setPerson] = useState<Person | null>(null);
  const toast = useToast();

  const close = () => {
    setOpen(false);
    if (params.get("new")) setParams({}, { replace: true });
  };

  async function revoke(id: number) {
    if (revoking !== id) return setRevoking(id);
    try {
      await api(`/api/invites/${id}`, { method: "DELETE" });
      invalidate("/api/invites", "/api/tenants");
      toast("Invite revoked");
    } catch (e) {
      toast(e instanceof ApiError ? e.message : "Couldn't revoke it", "alert");
    } finally {
      setRevoking(null);
    }
  }

  const pending = data?.invites.filter((i) => i.state === "valid") ?? [];
  const past = data?.invites.filter((i) => i.state !== "valid") ?? [];

  return (
    <Page
      title="Invites & people"
      back="/more"
      right={<NavButton icon="plus" label="New invite" accent onClick={() => setOpen(true)} />}
    >
      {loading ? (
        <Section>
          <Skeleton rows={4} />
        </Section>
      ) : error || !data ? (
        <ErrorState error={error ?? { message: "Couldn't load invites." }} retry={reload} />
      ) : (
        <>
          {!data.invites.length && !data.people.length ? (
            <Empty
              icon="userPlus"
              title="Invite your tenants and staff"
              text="Each person gets a link and a 6-digit PIN. Tenants see only their own rent and requests. Staff handle requests and expenses."
              action={
                <button className="btn md auto" onClick={() => setOpen(true)}>
                  <I.userPlus /> {tx("New invite")}
                </button>
              }
            />
          ) : (
            <>
              {pending.length > 0 && (
                <Section title="Waiting to join" footer="Invites expire after 7 days and lock after 5 wrong PINs.">
                  <div className="list">
                    {pending.map((i) => (
                      <div className="row" key={i.id}>
                        <Avatar name={i.name || "?"} />
                        <span className="grow">
                          <span className="title" style={{ display: "block" }}>
                            {i.name || tx("Unnamed")}
                          </span>
                          <span className="sub" style={{ display: "block" }}>
                            {tx("{value} · expires {date}", {
                              value: i.role === "tenant" ? tx("Tenant") : tx("Staff"),
                              date: dateLabel(i.expiresAt),
                            })}
                          </span>
                        </span>
                        <span className="row-actions">
                          <button
                            className="circle-btn plain"
                            aria-label={tx("Copy invite link")}
                            onClick={async () => {
                              if (await copyText(inviteUrl(i.token))) toast("Link copied", "copy");
                            }}
                          >
                            <I.link />
                          </button>
                          <button
                            className="circle-btn plain"
                            aria-label={tx("Revoke invite")}
                            onClick={() => revoke(i.id)}
                            style={{ color: revoking === i.id ? "var(--red-text)" : "var(--label-3)" }}
                          >
                            <I.trash />
                          </button>
                        </span>
                      </div>
                    ))}
                  </div>
                  {revoking && (
                    <div className="confirm-text">
                      {tx("Tap the bin again to revoke. The link and PIN stop working.")}
                    </div>
                  )}
                </Section>
              )}
              <Section
                title="People in your workspace"
                footer={
                  data.people.length
                    ? tx("Tap someone who forgot their password to make them a reset link.")
                    : undefined
                }
              >
                {data.people.length ? (
                  <div className="list">
                    {data.people.map((p) => (
                      <Row
                        key={p.id}
                        avatar={p.fullName || p.email}
                        title={p.fullName || p.email}
                        sub={`${p.email} · ${activityLabel(p.lastActiveAt, p.devices)}`}
                        onClick={() => setPerson(p)}
                        chevron
                        end={
                          <span className={`pill ${p.role === "staff" ? "orange" : "green"}`}>
                            {p.role === "staff" ? tx("Staff") : tx("Tenant")}
                          </span>
                        }
                      />
                    ))}
                  </div>
                ) : (
                  <div className="card tight t-sub c2 center-text">{tx("No one has joined yet.")}</div>
                )}
              </Section>
              {past.length > 0 && (
                <Section title="History">
                  <div className="list">
                    {past.slice(0, 12).map((i) => (
                      <Row
                        key={i.id}
                        title={i.name || tx("Unnamed")}
                        sub={tx("{value} · created {when}", {
                          value: i.role === "tenant" ? tx("Tenant") : tx("Staff"),
                          when: relTime(i.createdAt),
                        })}
                        end={<span className={`pill ${STATE[i.state].cls}`}>{STATE[i.state].label}</span>}
                      />
                    ))}
                  </div>
                </Section>
              )}
            </>
          )}
        </>
      )}
      <NewInviteSheet open={open} onClose={close} />
      <ResetLinkSheet person={person} onClose={() => setPerson(null)} />
    </Page>
  );
}

export function NewInviteSheet({ open, onClose, tenantId }: { open: boolean; onClose: () => void; tenantId?: number }) {
  const tx = useT();
  const { me } = useAuth();
  const tenants = useApi<TenantListItem[]>(open ? "/api/tenants" : null);
  const [role, setRole] = useState<"tenant" | "staff">("tenant");
  const [tid, setTid] = useState<number>(tenantId ?? 0);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [created, setCreated] = useState<CreatedInvite | null>(null);

  const candidates = (tenants.data ?? []).filter((t) => !t.linked && t.active);
  const fixed = tenantId ? tenants.data?.find((t) => t.id === tenantId) : undefined;
  const chosen = tenants.data?.find((t) => t.id === (tenantId ?? tid));

  function reset() {
    setCreated(null);
    setErr("");
    setName("");
    setTid(tenantId ?? 0);
  }
  function close() {
    onClose();
    setTimeout(reset, 300);
  }

  async function create() {
    const r = tenantId ? "tenant" : role;
    if (r === "tenant" && !(tenantId ?? tid)) return setErr("Choose the tenant you're inviting.");
    if (r === "staff" && !name.trim()) return setErr("Enter their name.");
    setBusy(true);
    setErr("");
    try {
      const inv = await api<CreatedInvite>("/api/invites", {
        body: r === "tenant" ? { role: r, tenantId: tenantId ?? tid } : { role: r, name: name.trim() },
      });
      setCreated(inv);
      invalidate("/api/invites", "/api/tenants");
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : "Couldn't create the invite.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Sheet
      open={open}
      onClose={close}
      title={created ? tx("Invite created") : tx("New invite")}
      onDone={created ? undefined : create}
      doneLabel="Create invite"
      busy={busy}
    >
      {created ? (
        <InviteResult invite={created} ownerName={me?.profile?.fullName ?? ""} phone={chosen?.phone} onDone={close} />
      ) : (
        <>
          {!tenantId && (
            <Section>
              <Segmented
                label="Who are you inviting"
                value={role}
                onChange={setRole}
                options={[
                  { value: "tenant", label: "Tenant" },
                  { value: "staff", label: "Staff" },
                ]}
              />
            </Section>
          )}
          {tenantId || role === "tenant" ? (
            <Section footer="They'll see only their own tenancy, rent and requests.">
              {tenantId ? (
                <div className="list">
                  <Row
                    avatar={fixed?.fullName ?? ""}
                    title={fixed?.fullName ?? tx("Tenant")}
                    sub={[fixed?.unitLabel, fixed?.propertyName].filter(Boolean).join(" · ")}
                  />
                </div>
              ) : tenants.loading ? (
                <Skeleton rows={1} />
              ) : candidates.length ? (
                <div className="list">
                  <SelectField
                    label="Tenant"
                    value={tid}
                    onChange={setTid}
                    options={[
                      { value: 0, label: "Choose…" },
                      ...candidates.map((t) => ({ value: t.id, label: `${t.fullName} · ${t.unitLabel}` })),
                    ]}
                  />
                </div>
              ) : (
                <div className="card tight t-sub c2 center-text">
                  {tx("Every active tenant has already joined or has no unit. Add a tenant first.")}
                </div>
              )}
            </Section>
          ) : (
            <Section footer="Staff can update requests, view units and tenants, and submit expenses for your approval. They can't see rent.">
              <div className="list">
                <Field
                  label="Name"
                  value={name}
                  onChange={setName}
                  placeholder="e.g. Ramesh (caretaker)"
                  maxLength={80}
                  autoFocus
                />
              </div>
            </Section>
          )}
          <Section>
            <FormError text={err} />
            <button className="btn" onClick={create} disabled={busy}>
              {busy ? (
                <Spinner />
              ) : (
                <>
                  <I.link /> {tx("Create invite link")}
                </>
              )}
            </button>
          </Section>
        </>
      )}
    </Sheet>
  );
}
