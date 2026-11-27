import { useEffect, useState } from "react";
import { useAuth } from "../../../lib/auth";
import { api, ApiError, invalidate, useApi } from "../../../lib/api";
import type { PanResponse } from "../../../lib/types";
import { Field, FormError, Section, Spinner, useToast } from "../../../components/kit";
import { useT } from "../../../lib/i18n";

const PAN_RE = /^[A-Z]{5}[0-9]{4}[A-Z]$/;

/**
 * PAN for HRA. The owner's PAN prints on every receipt and statement (tenants claiming HRA over
 * ₹1 lakh a year need it); a tenant's PAN prints on their own statements. Staff never see either.
 */
export default function PanSection() {
  const t = useT();
  const { me } = useAuth();
  const role = me?.profile?.role;
  const allowed = role === "owner" || role === "tenant";
  const { data } = useApi<PanResponse>(allowed ? "/api/pan" : null);
  const toast = useToast();
  const [pan, setPan] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  useEffect(() => {
    if (data) setPan(data.pan);
  }, [data]);
  if (!allowed || !data) return null;

  const clean = pan.toUpperCase().replace(/\s/g, "");
  const dirty = clean !== data.pan;

  async function save() {
    if (clean && !PAN_RE.test(clean)) return setErr("Enter a valid PAN, like ABCDE1234F.");
    setBusy(true);
    setErr("");
    try {
      await api("/api/pan", { method: "PATCH", body: { pan: clean } });
      invalidate("/api/pan");
      toast(clean ? "PAN saved" : "PAN removed");
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : "Couldn't save the PAN.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Section
      title="PAN for HRA"
      footer={
        role === "owner"
          ? t(
              "Printed on rent receipts and statements. Tenants paying more than ₹1 lakh a year need the landlord's PAN to claim HRA.",
            )
          : t("Printed on your rent statements. Only you and your owner can see it.")
      }
    >
      <div className="list">
        <Field
          label="PAN"
          value={pan}
          onChange={(v) => setPan(v.toUpperCase())}
          placeholder="ABCDE1234F"
          maxLength={10}
          autoComplete="off"
        />
      </div>
      <FormError text={err} />
      {dirty && (
        <button className="btn mt12" onClick={save} disabled={busy}>
          {busy ? <Spinner /> : t("Save PAN")}
        </button>
      )}
    </Section>
  );
}
