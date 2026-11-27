import { useEffect, useState } from "react";
import { api, ApiError } from "../../lib/api";
import { firstName } from "../../lib/format";
import { whatsappLink } from "../../lib/links";
import { copyText, FormError, Row, Section, Sheet, Spinner, useToast } from "../../components/kit";
import { I } from "../../components/icons";
import "../../styles/ops.css";
import { useT } from "../../lib/i18n";

export interface Person {
  id: string;
  role: string;
  fullName: string;
  email: string;
}

/**
 * The owner makes a one-time password reset link for staff or a tenant (POST /api/members/:id/reset-link) and
 * sends it on WhatsApp. Works without any email setup. Each new link cancels the previous one.
 */
export function ResetLinkSheet({ person, onClose }: { person: Person | null; onClose: () => void }) {
  const t = useT();
  const toast = useToast();
  // Keep the last person while the sheet animates closed.
  const [shown, setShown] = useState<Person | null>(person);
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  useEffect(() => {
    if (person) {
      setShown(person);
      setUrl("");
      setErr("");
    }
  }, [person]);

  const name = shown?.fullName || shown?.email || "";
  const who = firstName(name) || "there";
  const text = `Hi ${who}, here is a link to choose a new pOS password. It works once, within the next hour: ${url}`;

  async function make() {
    if (!shown) return;
    setBusy(true);
    setErr("");
    try {
      const r = await api<{ url: string }>(`/api/members/${encodeURIComponent(shown.id)}/reset-link`, {
        method: "POST",
      });
      setUrl(r.url);
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : "Couldn't make a reset link.");
    } finally {
      setBusy(false);
    }
  }

  async function share() {
    try {
      await navigator.share({ title: "Reset your pOS password", text });
    } catch {
      /* dismissed */
    }
  }

  return (
    <Sheet open={!!person} onClose={onClose} title={url ? t("Reset link ready") : t("Password help")}>
      <Section>
        <div className="list">
          <Row
            avatar={name}
            title={name}
            sub={[shown?.role === "staff" ? "Staff" : "Tenant", shown?.email].filter(Boolean).join(" · ")}
          />
        </div>
      </Section>
      {url ? (
        <Section
          title="Reset link"
          footer="Send it only to this person. It works once and expires in an hour. Making a new one cancels this one."
        >
          <div className="link-box">{url}</div>
          <div className="stack-8 mt12">
            <a className="btn whatsapp" href={whatsappLink("", text)} target="_blank" rel="noopener noreferrer">
              <I.chat /> {t("Send on WhatsApp")}
            </a>
            <div className="btn-row">
              <button
                className="btn gray md"
                onClick={async () => {
                  if (await copyText(url)) toast("Link copied", "copy");
                }}
              >
                <I.copy /> {t("Copy link")}
              </button>
              {"share" in navigator && (
                <button className="btn gray md" onClick={share}>
                  <I.share /> {t("Share")}
                </button>
              )}
            </div>
            <button className="btn tinted md" onClick={onClose}>
              {t("Done")}
            </button>
          </div>
        </Section>
      ) : (
        <Section
          footer={t("If {who} forgot their password, make a one-time link that lets them choose a new one.", { who })}
        >
          <FormError text={err} />
          <button className="btn" onClick={make} disabled={busy}>
            {busy ? (
              <Spinner />
            ) : (
              <>
                <I.key /> {t("Make reset link")}
              </>
            )}
          </button>
        </Section>
      )}
    </Sheet>
  );
}
