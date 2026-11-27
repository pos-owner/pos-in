import { useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { api, ApiError, invalidate, useApi } from "../../lib/api";
import { useAuth } from "../../lib/auth";
import { dateLabel, rupees, todayISO } from "../../lib/format";
import type { MeterGuess, MeterKind, MeterProperty, MeterRates, MeterReading, MetersResponse } from "../../lib/types";
import {
  Empty,
  ErrorState,
  Field,
  FormError,
  Lightbox,
  NavButton,
  Page,
  Row,
  Section,
  Segmented,
  SelectField,
  Sheet,
  Skeleton,
  Spinner,
  Toggle,
  useToast,
} from "../../components/kit";
import { I } from "../../components/icons";
import { uploadPhoto } from "../../lib/photo";
import { useT } from "../../lib/i18n";
import { sendOrQueue } from "../../lib/outbox";
import { OutboxNote } from "../../components/OutboxButton";
import { refreshRent } from "../owner/ChargeSheet";
import "../../styles/owner.css";
import "../../styles/tools.css";

const KIND: Record<MeterKind, { label: string; unit: string; bg: string }> = {
  electricity: { label: "Electricity", unit: "kWh", bg: "var(--orange)" },
  water: { label: "Water", unit: "units", bg: "var(--teal)" },
};
const fmt = (n: number | null | undefined) =>
  n == null ? "—" : new Intl.NumberFormat("en-IN", { maximumFractionDigits: 1 }).format(n);
const perUnit = (paise: number) =>
  `₹${new Intl.NumberFormat("en-IN", { maximumFractionDigits: 2 }).format(paise / 100)}`;

export default function Meters() {
  const t = useT();
  const { me } = useAuth();
  const isOwner = me?.profile?.role === "owner";
  const { data, error, loading, reload } = useApi<MetersResponse>("/api/meters");
  const [params, setParams] = useSearchParams();
  // `?unit=<id>` (from a unit row or the staff Today screen) opens the scanner on that unit straight away.
  const [scan, setScan] = useState<{ unitId?: number; kind?: MeterKind } | null>(() =>
    params.get("unit") ? { unitId: Number(params.get("unit")), kind: "electricity" } : null,
  );
  // null: closed · "default": workspace default · a property: that property's own rates.
  const [rates, setRates] = useState<"default" | MeterProperty | null>(null);
  const [open, setOpen] = useState<MeterReading | null>(null);

  const monthReadings = (data?.readings ?? []).filter((r) => r.readOn?.slice(0, 7) === todayISO().slice(0, 7));
  const billed = monthReadings.filter((r) => r.status !== "pending").reduce((s, r) => s + r.amount, 0);
  const occupied = (data?.units ?? []).filter((u) => u.occupied);
  const missing = occupied.filter((u) => !monthReadings.some((r) => r.unitId === u.id && r.kind === "electricity"));
  const pending = (data?.readings ?? []).filter((r) => r.status === "pending");

  return (
    <Page
      title="Meter readings"
      back={isOwner ? "/more" : undefined}
      tabs={!isOwner}
      right={<NavButton icon="camera" label="Scan a meter" accent onClick={() => setScan({})} />}
    >
      {loading ? (
        <Section>
          <Skeleton rows={4} />
        </Section>
      ) : error || !data ? (
        <>
          <OutboxNote kind="meter" />
          <ErrorState error={error ?? { message: "Couldn't load meter readings." }} retry={reload} />
        </>
      ) : !data.units.length ? (
        <Empty
          icon="gauge"
          title="No units yet"
          text="Add properties and units first. Then scan each meter once a month."
        />
      ) : (
        <>
          <OutboxNote kind="meter" />
          <Section>
            <button className="btn" onClick={() => setScan({})}>
              <I.camera /> {t("Scan a meter")}
            </button>
          </Section>

          <Section>
            <div className="stats">
              <div className="stat">
                <div className="k">{t("Read this month")}</div>
                <div className="v">
                  {t("{n} of {n2}", { n: occupied.length - missing.length, n2: occupied.length })}
                </div>
              </div>
              <div className="stat">
                <div className="k">{t("Billed this month")}</div>
                <div className="v">{rupees(billed)}</div>
              </div>
            </div>
          </Section>

          {pending.length > 0 && (
            <Section
              title="Needs approval"
              footer={
                isOwner
                  ? t(
                      "Staff readings don't change any rent until you approve them. Check the photo and number, then approve.",
                    )
                  : t("The owner checks these readings before any bill is added to rent.")
              }
            >
              <div className="list">
                {pending.map((r) => (
                  <ReadingRow key={r.id} r={r} onOpen={() => setOpen(r)} />
                ))}
              </div>
            </Section>
          )}

          {missing.length > 0 && (
            <Section title="Still to read" footer="Occupied units without an electricity reading this month.">
              <div className="list icons">
                {missing.map((u) => (
                  <Row
                    key={u.id}
                    icon="gauge"
                    iconBg={KIND.electricity.bg}
                    title={u.label}
                    sub={[u.propertyName, u.tenantName].filter(Boolean).join(" · ")}
                    end={<span className="pill orange">{t("Scan")}</span>}
                    onClick={() => setScan({ unitId: u.id, kind: "electricity" })}
                  />
                ))}
              </div>
            </Section>
          )}

          {isOwner && (
            <Section
              title="Rates"
              footer={t(
                "{value} Staff readings always wait for your approval. Each property uses the default unless you set its own rate.",
                {
                  value: data.autoBill
                    ? t(
                        "Bills from your readings are added to the month's rent by default. Change this in Automations.",
                      )
                    : t("Bills from your readings are only added to rent when you choose."),
                },
              )}
            >
              <div className="list icons">
                <Row
                  icon="bolt"
                  iconBg={KIND.electricity.bg}
                  title="Default rates"
                  sub={rateLine(data.rates)}
                  chevron
                  onClick={() => setRates("default")}
                />
                {data.properties.map((p) => (
                  <Row
                    key={p.id}
                    icon="building"
                    iconBg="var(--indigo)"
                    title={p.name}
                    sub={rateLine(p)}
                    value={p.custom.electricity || p.custom.water ? "Own rates" : "Default"}
                    chevron
                    onClick={() => setRates(p)}
                  />
                ))}
              </div>
            </Section>
          )}

          <Section title="Recent readings">
            {data.readings.some((r) => r.status !== "pending") ? (
              <div className="list">
                {data.readings
                  .filter((r) => r.status !== "pending")
                  .slice(0, 30)
                  .map((r) => (
                    <ReadingRow key={r.id} r={r} onOpen={() => setOpen(r)} />
                  ))}
              </div>
            ) : (
              <div className="card tight t-sub c2 center-text">
                {t("No readings yet. The first reading for each meter sets the starting point.")}
              </div>
            )}
          </Section>
        </>
      )}

      {data && (
        <ScanSheet
          open={!!scan}
          preset={scan}
          data={data}
          isOwner={isOwner}
          onClose={() => {
            setScan(null);
            if (params.get("unit")) setParams({}, { replace: true });
          }}
        />
      )}
      {data && isOwner && <RatesSheet target={rates} defaults={data.rates} onClose={() => setRates(null)} />}
      <ReadingSheet r={open} isOwner={isOwner} onClose={() => setOpen(null)} />
    </Page>
  );
}

function ReadingRow({ r, onOpen }: { r: MeterReading; onOpen: () => void }) {
  const t = useT();
  return (
    <button type="button" className="row" onClick={onOpen}>
      {r.photo ? (
        <img className="thumb-sm" src={r.photo} alt="" loading="lazy" />
      ) : (
        <span className="icon-sq" style={{ background: KIND[r.kind].bg }}>
          <I.gauge />
        </span>
      )}
      <span className="grow">
        <span className="title" style={{ display: "block" }}>
          {r.unitLabel} · {KIND[r.kind].label}
        </span>
        <span className="sub" style={{ display: "block" }}>
          {fmt(r.reading)} {KIND[r.kind].unit} ·{" "}
          {r.usage ? t("{value} used", { value: fmt(r.usage) }) : t("First reading")} · {dateLabel(r.readOn)}
        </span>
      </span>
      <span className="end">
        <span className="stack">
          <span className="num w6">{r.amount ? rupees(r.amount) : "—"}</span>
          {r.status === "pending" ? (
            <span className="pill orange">{t("Needs approval")}</span>
          ) : (
            r.amount > 0 &&
            (r.applied ? (
              <span className="pill green">{t("On rent")}</span>
            ) : (
              <span className="pill gray">{t("Not billed")}</span>
            ))
          )}
          {r.flag && r.status !== "pending" && <span className="pill red">{t("Unusual")}</span>}
        </span>
        <I.chevR className="chev" />
      </span>
    </button>
  );
}

/** "offline": picked with no connection; kept on the phone and uploaded by the outbox with the reading. */
type Photo = {
  preview: string;
  key?: string;
  state: "uploading" | "scanning" | "done" | "error" | "offline";
  file?: File;
};

function ScanSheet({
  open,
  preset,
  data,
  isOwner,
  onClose,
}: {
  open: boolean;
  preset: { unitId?: number; kind?: MeterKind } | null;
  data: MetersResponse;
  isOwner: boolean;
  onClose: () => void;
}) {
  const toast = useToast();
  const t = useT();
  const input = useRef<HTMLInputElement>(null);
  const [unitId, setUnitId] = useState<number>(data.units[0]?.id ?? 0);
  const [kind, setKind] = useState<MeterKind>("electricity");
  const [photo, setPhoto] = useState<Photo | null>(null);
  const [guess, setGuess] = useState<MeterGuess | null>(null);
  const [reading, setReading] = useState("");
  const [readOn, setReadOn] = useState(todayISO());
  const [addToRent, setAddToRent] = useState(true);
  const [reset, setReset] = useState(false);
  const [lower, setLower] = useState(false);
  /** Set when the server's sanity check flags the usage; saving again confirms it. */
  const [unusual, setUnusual] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  useEffect(() => {
    if (!open) return;
    setUnitId(preset?.unitId ?? data.units.find((u) => u.occupied)?.id ?? data.units[0]?.id ?? 0);
    setKind(preset?.kind ?? "electricity");
    setPhoto(null);
    setGuess(null);
    setReading("");
    setReadOn(todayISO());
    setAddToRent(data.autoBill);
    setReset(false);
    setLower(false);
    setUnusual("");
    setErr("");
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  const unit = data.units.find((u) => u.id === unitId);
  const prev = unit?.last[kind] ?? null;
  const propRates = data.properties.find((p) => p.id === unit?.propertyId) ?? data.rates;
  const rate = kind === "water" ? propRates.water : propRates.electricity;
  const value = Number(reading.replace(/[,\s]/g, ""));
  const valid = reading.trim() !== "" && Number.isFinite(value) && value >= 0;
  const usage = valid && prev && !reset ? Math.max(0, Math.round((value - prev.reading) * 10) / 10) : 0;
  const bill = Math.round((usage * rate) / 100);
  const below = valid && prev && value < prev.reading && !reset;
  // Any change to what's being saved needs a fresh sanity check.
  useEffect(() => {
    setUnusual("");
  }, [reading, unitId, kind, reset]);

  async function pick(file: File | undefined) {
    if (!file) return;
    const preview = URL.createObjectURL(file);
    setGuess(null);
    setErr("");
    // No connection: keep the photo for the outbox. Reading the number from it needs the server, so it's typed.
    if (navigator.onLine === false) return setPhoto({ preview, state: "offline", file });
    setPhoto({ preview, state: "uploading" });
    try {
      const up = await uploadPhoto(file);
      setPhoto({ preview, key: up.key, state: "scanning" });
      const g = await api<MeterGuess>("/api/meters/scan", { body: { photoKey: up.key, kind } });
      setGuess(g);
      if (g.reading !== null) setReading(String(g.reading));
      setPhoto({ preview, key: up.key, state: "done" });
    } catch (e) {
      // The connection dropped before the photo was uploaded: keep it for the outbox.
      const lost = e instanceof ApiError && e.status === 0;
      setPhoto((p) => (p ? { ...p, state: p.key ? "done" : lost ? "offline" : "error", file } : p));
      setErr(e instanceof ApiError ? e.message : "The photo couldn't be read. Type the number from the meter.");
    }
  }

  async function save() {
    if (!valid) return setErr("Enter the number shown on the meter.");
    setBusy(true);
    setErr("");
    try {
      // Kept on the phone and sent later when there's no connection (src/lib/outbox.ts). Online, the server's checks
      // (lower than last time, unusual usage) come back here right away; for a queued reading they show on /outbox.
      const sent = await sendOrQueue<{ amount: number; applied: boolean; pending: boolean; firstReading: boolean }>({
        kind: "meter",
        body: {
          unitId,
          kind,
          reading: value,
          readOn,
          photoKey: photo?.key,
          confidence: guess?.confidence,
          addToRent: isOwner ? addToRent : undefined,
          reset,
          confirmUnusual: !!unusual,
        },
        photos: photo?.state === "offline" && photo.file ? [photo.file] : undefined,
        title: [unit?.label, t(KIND[kind].label)].filter(Boolean).join(" · "),
        detail: [`${fmt(value)} ${t(KIND[kind].unit)}`, unit?.propertyName, dateLabel(readOn)]
          .filter(Boolean)
          .join(" · "),
      });
      if (sent.queued) {
        toast(t("Saved on this phone. It's sent when you're back online."), "cloudUp");
        onClose();
        return;
      }
      const r = sent.data;
      invalidate("/api/meters", "/api/automations");
      if (r.applied) refreshRent();
      toast(
        r.firstReading
          ? "Starting reading saved"
          : r.pending
            ? "Saved · waiting for the owner's approval"
            : r.applied
              ? `Saved · ${rupees(r.amount)} added to rent`
              : r.amount
                ? `Saved · bill ${rupees(r.amount)}`
                : "Reading saved",
      );
      onClose();
    } catch (e) {
      if (e instanceof ApiError && e.code === "unusual") {
        setUnusual(e.message);
        return;
      }
      if (e instanceof ApiError && e.status === 400 && /lower than the last/.test(e.message)) setLower(true);
      setErr(e instanceof ApiError ? e.message : "Couldn't save the reading.");
    } finally {
      setBusy(false);
    }
  }

  const sure = guess ? Math.round(guess.confidence * 100) : 0;
  const sureColor = sure >= 85 ? "var(--green)" : sure >= 60 ? "var(--orange)" : "var(--red)";

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="Scan a meter"
      onDone={save}
      doneLabel={unusual ? "Save anyway" : "Save reading"}
      doneDisabled={!valid || photo?.state === "uploading" || photo?.state === "scanning"}
      busy={busy}
    >
      <Section>
        <div className="list">
          <SelectField
            label="Unit"
            value={unitId}
            onChange={setUnitId}
            options={data.units.map((u) => ({ value: u.id, label: `${u.label} · ${u.propertyName}` }))}
          />
        </div>
        <div className="mt12">
          <Segmented
            label="Meter"
            value={kind}
            onChange={(k) => {
              setKind(k);
              setGuess(null);
            }}
            options={[
              { value: "electricity", label: "Electricity" },
              { value: "water", label: "Water" },
            ]}
          />
        </div>
      </Section>

      <Section footer="Fill the frame with the meter display. pOS reads the number and you check it.">
        <button
          type="button"
          className="scan-hero"
          style={{ width: "100%" }}
          onClick={() => input.current?.click()}
          aria-label={t(photo ? "Retake meter photo" : "Take meter photo")}
        >
          {photo ? (
            <img src={photo.preview} alt={t("Meter photo")} />
          ) : (
            <span className="scan-empty">
              <I.camera />
              <span className="t-headline" style={{ display: "block", marginTop: 8 }}>
                {t("Take a photo of the meter")}
              </span>
              <span className="t-foot" style={{ opacity: 0.75 }}>
                {t("or type the reading below")}
              </span>
            </span>
          )}
          {(photo?.state === "uploading" || photo?.state === "scanning") && <span className="scan-line" />}
          {photo && (
            <span className="scan-chip">
              {t(
                photo.state === "uploading"
                  ? "Uploading…"
                  : photo.state === "scanning"
                    ? "Reading the meter…"
                    : photo.state === "error"
                      ? "Upload failed · tap to retry"
                      : photo.state === "offline"
                        ? "Offline · type the reading below"
                        : "Tap to retake",
              )}
            </span>
          )}
        </button>
        <input
          ref={input}
          type="file"
          accept="image/*"
          capture="environment"
          hidden
          onChange={(e) => {
            pick(e.target.files?.[0]);
            e.target.value = "";
          }}
        />
      </Section>

      <Section
        footer={
          guess
            ? guess.note
            : prev
              ? t("Last reading {value} on {date}.", { value: fmt(prev.reading), date: dateLabel(prev.readOn, true) })
              : t("No earlier reading for this meter. This one sets the starting point.")
        }
      >
        {guess && guess.reading !== null && (
          <div className="between mb8" style={{ padding: "0 4px" }}>
            <span className="confidence">
              <i style={{ background: sureColor }} /> {t("Read from photo ·")} {sure}
              {t("% sure")}
            </span>
            {sure < 85 && <span className="t-foot c2">{t("Please double-check")}</span>}
          </div>
        )}
        <div className="list reading-input">
          <Field
            label={t("Reading ({unit})", { unit: t(KIND[kind].unit) })}
            value={reading}
            onChange={setReading}
            inputMode="decimal"
            big
            placeholder="0000.0"
          />
          <Field label="Read on" type="date" value={readOn} onChange={setReadOn} />
        </div>
      </Section>

      {prev && valid && (
        <Section>
          <div className="calc">
            <div className="stat">
              <div className="k">{t("Last")}</div>
              <div className="v num">{fmt(prev.reading)}</div>
            </div>
            <div className="stat">
              <div className="k">{t("Used")}</div>
              <div className="v num">{below ? "—" : fmt(usage)}</div>
            </div>
            <div className="stat">
              <div className="k">{t("Bill")}</div>
              <div className="v num">{rate ? rupees(bill) : "—"}</div>
            </div>
          </div>
        </Section>
      )}

      {(lower || below) && (
        <Section>
          <div className="list">
            <Toggle
              label="This is a new meter"
              sub="The old meter was replaced, so start counting from this reading."
              checked={reset}
              onChange={setReset}
            />
          </div>
        </Section>
      )}

      {unit?.occupied && bill > 0 && (
        <Section>
          {isOwner ? (
            <div className="list">
              <Toggle
                label="Add bill to rent"
                sub={t("{amount} is added to {value}'s rent for this month.", {
                  amount: rupees(bill),
                  value: unit.tenantName || "the tenant",
                })}
                checked={addToRent}
                onChange={setAddToRent}
              />
            </div>
          ) : (
            <div className="card tight t-sub c2">
              {t("The owner approves this reading before {amount} is added to the rent.", { amount: rupees(bill) })}
            </div>
          )}
        </Section>
      )}
      {unusual && (
        <Section footer="Tap Save anyway if the meter really shows this number. The owner sees it marked as unusual.">
          <div className="card tight warn-card" role="alert">
            <I.alert /> <span>{unusual}</span>
          </div>
        </Section>
      )}
      <Section>
        <FormError text={err} />
      </Section>
    </Sheet>
  );
}

const rateLine = (r: MeterRates) =>
  `Electricity ${perUnit(r.electricity)} · Water ${r.water ? perUnit(r.water) : "not billed"}`;
const rupeeInput = (paise: number) => String(paise / 100);

/** Edits the workspace default rates, or one property's own rates (blank = use the default). */
function RatesSheet({
  target,
  defaults,
  onClose,
}: {
  target: "default" | MeterProperty | null;
  defaults: MeterRates;
  onClose: () => void;
}) {
  const t = useT();
  const toast = useToast();
  const prop = target && target !== "default" ? target : null;
  const [e, setE] = useState("");
  const [w, setW] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  useEffect(() => {
    if (!target) return;
    setErr("");
    if (prop) {
      setE(prop.custom.electricity ? rupeeInput(prop.electricity) : "");
      setW(prop.custom.water ? rupeeInput(prop.water) : "");
    } else {
      setE(rupeeInput(defaults.electricity));
      setW(rupeeInput(defaults.water));
    }
  }, [target]); // eslint-disable-line react-hooks/exhaustive-deps

  async function save(body: Record<string, unknown>) {
    setBusy(true);
    setErr("");
    try {
      await api("/api/meters/rates", { method: "PATCH", body });
      invalidate("/api/meters");
      toast("Rates saved");
      onClose();
    } catch (x) {
      setErr(x instanceof ApiError ? x.message : "Couldn't save rates.");
    } finally {
      setBusy(false);
    }
  }
  const submit = () =>
    prop
      ? save({
          propertyId: prop.id,
          electricity: e.trim() === "" ? null : Number(e),
          water: w.trim() === "" ? null : Number(w),
        })
      : save({ electricity: Number(e || 0), water: Number(w || 0) });

  return (
    <Sheet open={!!target} onClose={onClose} title={prop ? prop.name : t("Default rates")} onDone={submit} busy={busy}>
      <Section
        footer={
          prop
            ? t(
                "Per unit, in rupees. Leave a field empty to use the default ({value}). Enter 0 to stop billing it here. New rates apply to new readings only.",
                { value: rateLine(defaults) },
              )
            : t(
                "Per unit, in rupees. Used by every property without its own rate. Set water to 0 if you don't bill it. New rates apply to new readings only.",
              )
        }
      >
        <div className="list">
          <Field
            label="Electricity"
            value={e}
            onChange={setE}
            inputMode="decimal"
            prefix="₹"
            placeholder={prop ? rupeeInput(defaults.electricity) : "8"}
          />
          <Field
            label="Water"
            value={w}
            onChange={setW}
            inputMode="decimal"
            prefix="₹"
            placeholder={prop ? rupeeInput(defaults.water) : "0"}
          />
        </div>
        <FormError text={err} />
      </Section>
      {prop && (prop.custom.electricity || prop.custom.water) && (
        <Section>
          <button
            type="button"
            className="btn gray"
            disabled={busy}
            onClick={() => save({ propertyId: prop.id, electricity: null, water: null })}
          >
            {t("Use default rates")}
          </button>
        </Section>
      )}
    </Sheet>
  );
}

function ReadingSheet({ r, isOwner, onClose }: { r: MeterReading | null; isOwner: boolean; onClose: () => void }) {
  const t = useT();
  const toast = useToast();
  const [last, setLast] = useState(r);
  if (r && r !== last) setLast(r);
  const x = r ?? last;
  const [busy, setBusy] = useState("");
  const [confirm, setConfirm] = useState(false);
  const [zoom, setZoom] = useState<string | null>(null);
  useEffect(() => {
    setConfirm(false);
  }, [r]);
  const sure = useMemo(() => (x?.confidence != null ? Math.round(x.confidence * 100) : null), [x]);

  async function run(tag: string, fn: () => Promise<unknown>, done: string) {
    setBusy(tag);
    try {
      await fn();
      invalidate("/api/meters");
      refreshRent();
      toast(done);
      onClose();
    } catch (e) {
      toast(e instanceof ApiError ? e.message : "That didn't work.", "alert");
    } finally {
      setBusy("");
    }
  }

  return (
    <Sheet open={!!r} onClose={onClose} title={x ? `${x.unitLabel} · ${KIND[x.kind].label}` : t("Reading")}>
      {x && (
        <>
          {x.photo && (
            <Section>
              <button
                type="button"
                className="scan-hero"
                style={{ width: "100%" }}
                onClick={() => setZoom(x.photo)}
                aria-label={t("View meter photo")}
              >
                <img src={x.photo} alt={t("Meter photo")} />
                {sure !== null && <span className="scan-chip">{t("Read from photo · {sure}% sure", { sure })}</span>}
              </button>
            </Section>
          )}
          <Section>
            <div className="list">
              <Row
                title="Reading"
                value={
                  <span className="num">
                    {fmt(x.reading)} {KIND[x.kind].unit}
                  </span>
                }
              />
              <Row title="Previous" value={<span className="num">{fmt(x.previous)}</span>} />
              <Row title="Units used" value={<span className="num">{x.usage ? fmt(x.usage) : "—"}</span>} />
              <Row title="Rate" value={x.rate ? `${perUnit(x.rate)} per unit` : "Not billed"} />
              <Row
                title={<span className="w6">{t("Bill")}</span>}
                value={
                  <span className="num w6" style={{ color: "var(--label)" }}>
                    {x.amount ? rupees(x.amount) : "—"}
                  </span>
                }
              />
              <Row
                title="Read on"
                value={dateLabel(x.readOn, true)}
                sub={x.recordedByName ? t("By {recordedByName}", { recordedByName: x.recordedByName }) : undefined}
              />
              <Row
                title="Status"
                value={
                  x.status === "pending" ? (
                    <span className="pill orange">{t("Needs approval")}</span>
                  ) : x.applied ? (
                    "On rent"
                  ) : x.amount ? (
                    "Not billed"
                  ) : (
                    "Saved"
                  )
                }
              />
            </div>
          </Section>
          {x.flag && (
            <Section footer="Saved after the unusual-usage warning was confirmed. Compare the photo with the number before billing.">
              <div className="card tight warn-card" role="note">
                <I.alert /> <span>{x.flag}</span>
              </div>
            </Section>
          )}
          {isOwner && (
            <Section
              footer={
                x.status === "pending"
                  ? t(
                      "Approving adds the bill to this month's rent (when the unit has a tenant). Deleting rejects the reading.",
                    )
                  : x.applied
                    ? t("This bill is part of the month's rent charge. Deleting the reading removes it from the rent.")
                    : undefined
              }
            >
              <div className="stack-8">
                {x.status === "pending" && (
                  <button
                    className="btn green"
                    disabled={!!busy}
                    onClick={() =>
                      run(
                        "apply",
                        () => api(`/api/meters/${x.id}/apply`, { method: "POST" }),
                        x.amount > 0 ? `Approved · ${rupees(x.amount)} added to rent` : "Reading approved",
                      )
                    }
                  >
                    {busy === "apply" ? (
                      <Spinner />
                    ) : (
                      <>
                        <I.check />{" "}
                        {x.amount > 0
                          ? t("Approve and add {amount}", { amount: rupees(x.amount) })
                          : t("Approve reading")}
                      </>
                    )}
                  </button>
                )}
                {x.status !== "pending" && !x.applied && x.amount > 0 && (
                  <button
                    className="btn"
                    disabled={!!busy}
                    onClick={() =>
                      run(
                        "apply",
                        () => api(`/api/meters/${x.id}/apply`, { method: "POST" }),
                        `${rupees(x.amount)} added to rent`,
                      )
                    }
                  >
                    {busy === "apply" ? (
                      <Spinner />
                    ) : (
                      <>
                        <I.plus /> {t("Add")} {rupees(x.amount)} {t("to rent")}
                      </>
                    )}
                  </button>
                )}
                <button
                  className="btn gray danger"
                  disabled={!!busy}
                  onClick={() => {
                    if (!confirm) return setConfirm(true);
                    run("del", () => api(`/api/meters/${x.id}`, { method: "DELETE" }), "Reading deleted");
                  }}
                >
                  {busy === "del" ? (
                    <Spinner />
                  ) : confirm ? (
                    t("Tap again to delete")
                  ) : (
                    <>
                      <I.trash /> {t("Delete reading")}
                    </>
                  )}
                </button>
              </div>
            </Section>
          )}
        </>
      )}
      <Lightbox src={zoom} onClose={() => setZoom(null)} />
    </Sheet>
  );
}
