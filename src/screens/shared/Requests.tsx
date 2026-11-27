import { useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { ApiError, invalidate, useApi } from "../../lib/api";
import { useAuth } from "../../lib/auth";
import { relTime } from "../../lib/format";
import type { Priority, RequestListItem, RequestStatus, WorkspaceResponse } from "../../lib/types";
import {
  Empty,
  ErrorState,
  Field,
  FormError,
  NavButton,
  Page,
  PRIORITY_COLOR,
  PriorityPill,
  Section,
  Segmented,
  SelectField,
  Sheet,
  Skeleton,
  Spinner,
  StatusPill,
  useToast,
} from "../../components/kit";
import { I } from "../../components/icons";
import { PhotoGrid, usePhotos } from "../../components/PhotoPicker";
import { OutboxNote } from "../../components/OutboxButton";
import { useT } from "../../lib/i18n";
import { sendOrQueue } from "../../lib/outbox";
import "../../styles/ops.css";

export default function Requests() {
  const { me } = useAuth();
  const role = me?.profile?.role ?? "owner";
  const { data, error, loading, reload } = useApi<RequestListItem[]>("/api/requests");
  const [params, setParams] = useSearchParams();
  const [tab, setTab] = useState<RequestStatus>("open");
  const [creating, setCreating] = useState(params.get("new") === "1");
  const nav = useNavigate();
  const t = useT();

  const counts = useMemo(() => {
    const c = { open: 0, in_progress: 0, done: 0 } as Record<RequestStatus, number>;
    for (const r of data ?? []) c[r.status]++;
    return c;
  }, [data]);
  const rows = (data ?? []).filter((r) => r.status === tab);
  const mineAssigned =
    role === "staff"
      ? (data ?? []).filter((r) => r.status !== "done" && r.assignedName && r.assignedName === me?.profile?.fullName)
          .length
      : 0;

  const close = () => {
    setCreating(false);
    if (params.get("new") || params.get("unit")) setParams({}, { replace: true });
  };

  return (
    <Page
      title="Requests"
      eyebrow={
        data
          ? mineAssigned
            ? t("{n} assigned to you", { n: mineAssigned })
            : t("{n} open", { n: counts.open + counts.in_progress })
          : undefined
      }
      left={role === "staff" ? <NavButton icon="gear" label="Settings" onClick={() => nav("/settings")} /> : undefined}
      right={<NavButton icon="plus" label="New request" accent onClick={() => setCreating(true)} />}
    >
      <OutboxNote kind="request" />
      <Section>
        <Segmented
          label="Status"
          value={tab}
          onChange={setTab}
          options={[
            { value: "open", label: `${t("Open")}${counts.open ? ` · ${counts.open}` : ""}` },
            {
              value: "in_progress",
              label: `${t("In progress")}${counts.in_progress ? ` · ${counts.in_progress}` : ""}`,
            },
            { value: "done", label: "Done" },
          ]}
        />
      </Section>
      {loading ? (
        <Section>
          <Skeleton rows={4} avatar={false} />
        </Section>
      ) : error || !data ? (
        <ErrorState error={error ?? { message: "Couldn't load requests." }} retry={reload} />
      ) : !rows.length ? (
        <Empty
          icon={tab === "done" ? "checkCircle" : "wrench"}
          title={
            tab === "open"
              ? t("No open requests")
              : tab === "in_progress"
                ? t("Nothing in progress")
                : t("No finished requests yet")
          }
          text={
            tab === "open"
              ? role === "tenant"
                ? t("Something not working? Report it with a photo and track it here.")
                : t("New requests from tenants and staff land here.")
              : t("Requests move here as their status changes.")
          }
          action={
            tab === "open" ? (
              <button className="btn md auto tinted" onClick={() => setCreating(true)}>
                <I.plus /> {t("New request")}
              </button>
            ) : undefined
          }
        />
      ) : (
        <Section>
          <div className="list">
            {rows.map((r) => (
              <button type="button" key={r.id} className="row req-row" onClick={() => nav(`/requests/${r.id}`)}>
                <span className="dot" style={{ background: PRIORITY_COLOR[r.priority] }} aria-hidden="true" />
                <span className="grow">
                  <span className="title" style={{ display: "block" }}>
                    {r.title}
                  </span>
                  <span className="sub" style={{ display: "block" }}>
                    {role === "tenant" ? r.unitLabel : `${r.unitLabel} · ${r.propertyName}`}
                  </span>
                  <span className="req-meta">
                    <span>
                      <I.clock /> {relTime(r.updatedAt)}
                    </span>
                    {r.photoCount > 0 && (
                      <span>
                        <I.camera /> {r.photoCount}
                      </span>
                    )}
                    {r.assignedName ? (
                      <span>
                        <I.person /> {r.assignedName.split(" ")[0]}
                      </span>
                    ) : role !== "tenant" && r.status !== "done" ? (
                      <span className="c-orange">{t("Unassigned")}</span>
                    ) : null}
                  </span>
                </span>
                <span className="end">
                  {r.status === "done" ? <StatusPill status="done" /> : <PriorityPill priority={r.priority} />}
                  <I.chevR className="chev" />
                </span>
              </button>
            ))}
          </div>
        </Section>
      )}
      <NewRequestSheet
        open={creating}
        initialUnit={Number(params.get("unit")) || 0}
        onClose={close}
        onCreated={(id) => {
          close();
          nav(`/requests/${id}`);
        }}
      />
    </Page>
  );
}

function NewRequestSheet({
  open,
  initialUnit = 0,
  onClose,
  onCreated,
}: {
  open: boolean;
  /** Preselected unit (`/requests?new=1&unit=<id>`, from a scanned unit QR code). */
  initialUnit?: number;
  onClose: () => void;
  onCreated: (id: number) => void;
}) {
  const { me } = useAuth();
  const isTenant = me?.profile?.role === "tenant";
  const ws = useApi<WorkspaceResponse>(open && !isTenant ? "/api/workspace" : null);
  const photos = usePhotos(6, { keepOffline: true });
  const toast = useToast();
  const t = useT();
  const [title, setTitle] = useState("");
  const [desc, setDesc] = useState("");
  const [priority, setPriority] = useState<Priority>("medium");
  const [unit, setUnit] = useState(initialUnit);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const units = (ws.data?.properties ?? []).flatMap((p) =>
    p.units.map((u) => ({ value: u.id, label: `${u.label} · ${p.name}` })),
  );

  async function submit() {
    if (!title.trim()) return setErr("Describe the problem in a few words.");
    if (!isTenant && !unit) return setErr("Choose the unit.");
    if (photos.uploading) return setErr("Wait a moment for the photos to finish uploading.");
    setBusy(true);
    setErr("");
    try {
      // Kept on the phone and sent later when there's no connection, or when photos still need uploading.
      const r = await sendOrQueue<{ id: number }>({
        kind: "request",
        body: {
          title: title.trim(),
          description: desc.trim(),
          priority,
          unitId: unit || undefined,
          photoKeys: photos.keys,
        },
        photos: photos.offline,
        title: title.trim(),
        detail: [
          units.find((u) => u.value === unit)?.label,
          t(priority === "high" ? "Urgent" : priority === "low" ? "Low" : "Medium"),
        ]
          .filter(Boolean)
          .join(" · "),
      });
      if (!r.queued) {
        invalidate("/api/requests", "/api/dashboard", "/api/tenants");
        toast("Request sent");
      } else toast(t("Saved on this phone. It's sent when you're back online."), "cloudUp");
      setTitle("");
      setDesc("");
      setPriority("medium");
      setUnit(0);
      photos.reset();
      if (r.queued) onClose();
      else onCreated(r.data.id);
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : "Couldn't send the request.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Sheet open={open} onClose={onClose} title="New request" onDone={submit} doneLabel="Send request" busy={busy}>
      <Section>
        <div className="list">
          {!isTenant &&
            (ws.loading ? (
              <div className="field">
                <div className="sk" style={{ height: 14, width: "50%" }} />
              </div>
            ) : (
              <SelectField
                label="Unit"
                value={unit}
                onChange={setUnit}
                options={[{ value: 0, label: "Choose…" }, ...units]}
              />
            ))}
          <Field
            label="What's wrong?"
            value={title}
            onChange={setTitle}
            placeholder="e.g. Kitchen sink is leaking"
            maxLength={120}
            stack
            autoFocus
          />
          <Field
            label="Details"
            type="textarea"
            value={desc}
            onChange={setDesc}
            placeholder="Where it is, since when, best time to visit"
            maxLength={2000}
            stack
          />
        </div>
      </Section>
      <Section title="How urgent?">
        <Segmented
          label="Priority"
          value={priority}
          onChange={setPriority}
          options={[
            { value: "low", label: "Low" },
            { value: "medium", label: "Medium" },
            { value: "high", label: "Urgent" },
          ]}
        />
      </Section>
      <Section
        title="Photos"
        footer="A clear photo helps the caretaker bring the right tools. Photos are private to your workspace."
      >
        <PhotoGrid ctl={photos} />
      </Section>
      <Section>
        <FormError text={err} />
        <button className="btn" onClick={submit} disabled={busy}>
          {busy ? (
            <Spinner />
          ) : (
            <>
              <I.send /> {t("Send request")}
            </>
          )}
        </button>
      </Section>
    </Sheet>
  );
}
