import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { api, ApiError } from "../../lib/api";
import { extractCode, RECEIPT_CODE } from "../../lib/receiptCode";
import { useAuth } from "../../lib/auth";
import { dateLabel, monthLabel, rupees } from "../../lib/format";
import type { VerifyResponse } from "../../lib/types";
import { copyText, Spinner, useToast } from "../../components/kit";
import { I } from "../../components/icons";
import "../../styles/verify.css";
import { useT } from "../../lib/i18n";

/*
 * Public receipt verification. Routes: /verify/:code (from the QR printed on every receipt) and /verify (type or
 * paste a code). Works signed out, so an employer, a bank or the tenant's CA can check that pOS issued a receipt, for
 * how much, and whether the landlord voided it afterwards. It shows only what is already printed on the receipt.
 */

const METHOD: Record<string, string> = { upi: "UPI", cash: "Cash", bank: "Bank transfer" };
function checkedLabel(iso?: string) {
  const d = iso ? new Date(iso) : new Date();
  return new Intl.DateTimeFormat("en-IN", {
    timeZone: "Asia/Kolkata",
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(d);
}

export default function VerifyReceipt() {
  const t = useT();
  const { code = "" } = useParams();
  const { status } = useAuth();
  const signedIn = status === "ready";
  useEffect(() => {
    document.title = "Verify a rent receipt · pOS";
  }, []);

  return (
    <div className="verify-page">
      <a className="skip-link" href="#verify-main">
        {t("Skip to result")}
      </a>
      <header className="verify-top">
        <Link to="/" className="verify-brand" aria-label="pOS home">
          <img src="/icons/icon.svg" alt="" width={34} height={34} />
          <span>
            <b>{t("pOS")}</b>
            <small>{t("Receipt verification")}</small>
          </span>
        </Link>
        <Link to="/" className="verify-open">
          {signedIn ? t("Back to pOS") : t("Open pOS")}
        </Link>
      </header>
      <main id="verify-main" className="verify-main" tabIndex={-1}>
        {code ? <Verification key={code} code={code} /> : <EnterCode />}
        <HowItWorks />
      </main>
      <footer className="verify-foot">
        <I.lock aria-hidden="true" />
        <span>
          {t(
            "Verification is free and needs no account. pOS shows only what is printed on the receipt, never phone numbers, bank details or the rest of the rent ledger.",
          )}
        </span>
      </footer>
    </div>
  );
}

/** A verdict must describe this visit's check, since an owner may have voided a previously valid receipt. */
function Verification({ code }: { code: string }) {
  const [attempt, retry] = useState(0);
  const [result, setResult] = useState<VerifyResponse | ApiError | null>(null);

  useEffect(() => {
    let active = true;
    api<VerifyResponse>(`/api/verify/${encodeURIComponent(code)}`).then(
      (value) => {
        if (active) setResult(value);
      },
      (error: unknown) => {
        if (active) setResult(error instanceof ApiError ? error : new ApiError("Couldn't check this receipt.", 0));
      },
    );
    return () => {
      active = false;
    };
  }, [code, attempt]);

  if (!result) return <Checking />;
  if (result instanceof ApiError) {
    if (result.status === 404) return <Result code={code} data={{ valid: false }} />;
    return (
      <Problem
        message={result.message}
        rateLimited={result.status === 429}
        retry={() => {
          setResult(null);
          retry((n) => n + 1);
        }}
      />
    );
  }
  return <Result code={code} data={result} />;
}

function Checking() {
  const t = useT();
  return (
    <section className="verify-card checking" aria-busy="true" aria-live="polite">
      <div className="verify-seal neutral">
        <Spinner size={30} />
      </div>
      <h1>{t("Checking the receipt…")}</h1>
      <p>{t("Matching the code with the landlord's rent ledger.")}</p>
    </section>
  );
}

function Problem({ message, rateLimited, retry }: { message: string; rateLimited: boolean; retry: () => void }) {
  const t = useT();
  const offline = typeof navigator !== "undefined" && !navigator.onLine;
  return (
    <section className="verify-card" role="alert">
      <div className="verify-seal neutral">{offline ? <I.wifiOff /> : <I.alert />}</div>
      <h1>{offline ? t("You're offline") : rateLimited ? t("Too many checks") : t("Couldn't check right now")}</h1>
      <p>
        {offline
          ? t("Connect to the internet, then try again. Verification always checks the live ledger.")
          : rateLimited
            ? t("This network has checked a lot of receipts in the last hour. Wait a while and try again.")
            : message}
      </p>
      <div className="verify-actions">
        <button className="btn md auto" onClick={retry}>
          {t("Try again")}
        </button>
      </div>
    </section>
  );
}

function Result({ code, data }: { code: string; data: VerifyResponse }) {
  const t = useT();
  const toast = useToast();
  const nav = useNavigate();
  const heading = useRef<HTMLHeadingElement>(null);
  const valid = !!data.valid;
  const voided = valid && !!data.voided;
  const state = !valid ? "invalid" : voided ? "voided" : "genuine";

  // Screen readers hear the verdict first; keyboard users land on it.
  useEffect(() => {
    heading.current?.focus();
  }, [state]);

  const period =
    data.month && data.monthTo && data.monthTo !== data.month
      ? `${monthLabel(data.month, true)} to ${monthLabel(data.monthTo, true)}`
      : data.month
        ? monthLabel(data.month, true)
        : "";

  const share = async () => {
    const url = window.location.href;
    const text = valid
      ? `pOS verification for receipt ${data.number}: ${voided ? "voided by the landlord" : "genuine"}.`
      : "pOS receipt verification";
    if (navigator.share) {
      try {
        await navigator.share({ title: "Receipt verification", text, url });
        return;
      } catch {
        /* cancelled: fall through to copying */
      }
    }
    toast((await copyText(url)) ? "Link copied" : "Couldn't copy the link", "copy");
  };

  return (
    <>
      <section className={`verify-card verdict ${state}`} aria-live="polite">
        <div className={`verify-seal ${state}`}>
          {state === "genuine" ? <I.shield /> : state === "voided" ? <I.alert /> : <I.x />}
        </div>
        <p className="verify-kicker">
          {state === "genuine"
            ? t("Verified")
            : state === "voided"
              ? t("Verified · no longer valid")
              : t("Not verified")}
        </p>
        <h1 ref={heading} tabIndex={-1}>
          {state === "genuine"
            ? t("Genuine receipt")
            : state === "voided"
              ? t("This receipt was voided")
              : t("Receipt not recognised")}
        </h1>
        <p>
          {state === "genuine"
            ? t(
                "pOS issued this receipt from the landlord's rent ledger, and the payment still counts toward the rent. The details below should match the paper exactly.",
              )
            : state === "voided"
              ? t(
                  "pOS issued this receipt, but the landlord later voided the payment{value}. It no longer counts toward the rent, so don't accept it as proof of payment.",
                  { value: data.voidedOn ? ` on ${dateLabel(data.voidedOn, true)}` : "" },
                )
              : t(
                  "This code doesn't match any receipt issued through pOS. Check that you scanned the QR code printed on the receipt itself, or type the code again below.",
                )}
        </p>
        <p className="verify-checked">
          <I.clock aria-hidden="true" /> {t("Checked")} {checkedLabel(data.checkedAt)} {t("IST")}
        </p>
      </section>

      {valid && (
        <section aria-labelledby="slip-title">
          <h2 id="slip-title" className="verify-h2">
            {t("Printed on the receipt")}
          </h2>
          <div className="slip-wrap">
            <article className={`slip ${voided ? "is-void" : ""}`}>
              <div className="slip-head">
                <img src="/icons/icon.svg" alt="" width={30} height={30} />
                <div>
                  <b>{t("pOS")}</b>
                  <small>{t("Rent receipt")}</small>
                </div>
                <div className="slip-no">
                  <b className="num">
                    {t("No.")} {data.number}
                  </b>
                  {data.issuedOn && <small>{t("Issued {date}", { date: dateLabel(data.issuedOn, true) })}</small>}
                </div>
              </div>
              <div className="slip-perf" aria-hidden="true" />
              <div className="slip-amount">
                <small>{t("Amount received")}</small>
                <strong className="num">{rupees(data.amount)}</strong>
                <span className={`slip-stamp ${voided ? "void" : "paid"}`}>{voided ? t("Void") : t("Paid")}</span>
              </div>
              <div className="slip-perf" aria-hidden="true" />
              <dl className="slip-rows">
                {data.tenant && (
                  <div>
                    <dt>{t("Received from")}</dt>
                    <dd>
                      <b>{data.tenant}</b>
                    </dd>
                  </div>
                )}
                {period && (
                  <div>
                    <dt>{t("Rent for")}</dt>
                    <dd>
                      {period}
                      {data.months && data.months > 1 ? t(" ({n} months)", { n: data.months }) : ""}
                    </dd>
                  </div>
                )}
                {data.unit && (
                  <div>
                    <dt>{t("Premises")}</dt>
                    <dd>{`${data.unit}${data.property ? `, ${data.property}` : ""}`}</dd>
                  </div>
                )}
                {data.paidOn && (
                  <div>
                    <dt>{t("Paid on")}</dt>
                    <dd>
                      {dateLabel(data.paidOn, true)}
                      {data.method ? ` · ${METHOD[data.method] ?? data.method}` : ""}
                    </dd>
                  </div>
                )}
                {data.landlord && (
                  <div>
                    <dt>{t("Landlord")}</dt>
                    <dd>{data.landlord}</dd>
                  </div>
                )}
              </dl>
              <div className="slip-perf" aria-hidden="true" />
              <p className="slip-foot">
                <I.checkCircle aria-hidden="true" /> {t("Matched with the pOS rent ledger")}
              </p>
            </article>
          </div>

          <div className="verify-match">
            <h2 className="verify-h2">{t("Before you accept it, check that")}</h2>
            <ul>
              <li>
                <I.check aria-hidden="true" /> {t("the receipt number and the amount match the paper")}
              </li>
              <li>
                <I.check aria-hidden="true" /> {t("the tenant's name and the premises are the ones you expect")}
              </li>
              <li>
                <I.check aria-hidden="true" /> {t("the month (or months) covered is the period you were told")}
              </li>
            </ul>
          </div>
        </section>
      )}

      <div className="verify-actions">
        {valid && (
          <>
            <button className="btn md auto" onClick={share}>
              <I.share aria-hidden="true" /> {t("Share this check")}
            </button>
            <button className="btn md auto tinted" onClick={() => window.print()}>
              <I.print aria-hidden="true" /> {t("Print")}
            </button>
          </>
        )}
        <button className={`btn md auto ${valid ? "plain" : ""}`} onClick={() => nav("/verify")}>
          <I.qr aria-hidden="true" /> {t("Verify another receipt")}
        </button>
      </div>
      {!valid && (
        <p className="verify-code-note">
          {t("Code checked:")} <code>{code}</code>
        </p>
      )}
    </>
  );
}

function EnterCode() {
  const t = useT();
  const nav = useNavigate();
  const id = useId();
  const [value, setValue] = useState("");
  const [err, setErr] = useState("");
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const code = extractCode(value);
    if (!RECEIPT_CODE.test(code)) {
      setErr(
        "That doesn't look like a receipt code. It is printed under the QR code, like “1a-Xy3…”, or paste the whole link.",
      );
      return;
    }
    setErr("");
    nav(`/verify/${encodeURIComponent(code)}`);
  };
  return (
    <section className="verify-card">
      <div className="verify-seal neutral">
        <I.qr />
      </div>
      <p className="verify-kicker">{t("Free · no sign-in")}</p>
      <h1>{t("Verify a rent receipt")}</h1>
      <p>
        {t(
          "Scan the QR code printed on the receipt with your phone's camera. Or paste the link or the code it opens here.",
        )}
      </p>
      <form className="verify-form" onSubmit={submit} noValidate>
        <label htmlFor={id}>{t("Receipt link or code")}</label>
        <div className="verify-input">
          <input
            id={id}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder={t("https://…/verify/…")}
            autoComplete="off"
            autoCapitalize="off"
            spellCheck={false}
            inputMode="url"
            aria-invalid={!!err}
            aria-describedby={err ? `${id}-err` : undefined}
          />
          <button className="btn md auto" type="submit" disabled={!value.trim()}>
            {t("Verify")}
          </button>
        </div>
        {err && (
          <p id={`${id}-err`} className="verify-err" role="alert">
            {err}
          </p>
        )}
      </form>
    </section>
  );
}

function HowItWorks() {
  const t = useT();
  return (
    <section className="verify-how" aria-labelledby="how-title">
      <h2 id="how-title" className="verify-h2">
        {t("How verification works")}
      </h2>
      <ol>
        <li>
          <span className="how-ic">
            <I.receipt aria-hidden="true" />
          </span>
          <div>
            <b>{t("Every receipt carries a signed code")}</b>
            <p>
              {t("pOS prints a QR code on each rent receipt. The code is signed, so it can't be guessed or edited.")}
            </p>
          </div>
        </li>
        <li>
          <span className="how-ic">
            <I.bank aria-hidden="true" />
          </span>
          <div>
            <b>{t("It is matched with the live ledger")}</b>
            <p>
              {t(
                "The check reads the landlord's rent ledger at this moment, not a copy made when the receipt printed.",
              )}
            </p>
          </div>
        </li>
        <li>
          <span className="how-ic">
            <I.shield aria-hidden="true" />
          </span>
          <div>
            <b>{t("Voided payments show up at once")}</b>
            <p>{t("If the landlord reverses a payment, its receipt shows as voided here, even on old printouts.")}</p>
          </div>
        </li>
      </ol>
    </section>
  );
}
