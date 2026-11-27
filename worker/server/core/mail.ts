import { bindings, env } from "./bindings.ts";

/*
 * Optional outgoing email through a Cloudflare `send_email` binding named EMAIL (Cloudflare Email Service), sending
 * from EMAIL_FROM (an address on a domain set up for Email in your Cloudflare account). Used only for "Forgot
 * password?". Without it, owners make reset links for their staff and tenants from the app instead.
 */
interface SendEmailBinding {
  send: (message: unknown) => Promise<unknown>;
}

function binding(): SendEmailBinding | null {
  try {
    const b = bindings().EMAIL as SendEmailBinding | undefined;
    return b && typeof b.send === "function" ? b : null;
  } catch {
    return null;
  }
}

export const mailConfigured = () => !!binding() && !!env("EMAIL_FROM");

const header = (s: string) => s.replace(/[\r\n]+/g, " ").trim();

export async function sendMail(m: { to: string; subject: string; text: string }) {
  const b = binding();
  const from = env("EMAIL_FROM");
  if (!b || !from) throw new Error("Email isn't configured (EMAIL binding and EMAIL_FROM).");
  try {
    // Cloudflare Email Service: structured message.
    await b.send({ from, to: m.to, subject: header(m.subject), text: m.text });
    return;
  } catch (e) {
    // Email Routing bindings only accept a raw MIME `EmailMessage`; fall back to that form.
    const mod = (await import(/* @vite-ignore */ "cloudflare:email" as string).catch(() => null)) as {
      EmailMessage: new (from: string, to: string, raw: string) => unknown;
    } | null;
    if (!mod) throw e;
    const raw = [
      `From: ${header(from)}`,
      `To: ${header(m.to)}`,
      `Subject: ${header(m.subject)}`,
      `Message-ID: <${crypto.randomUUID()}@${from.split("@")[1] ?? "pos"}>`,
      `Date: ${new Date().toUTCString()}`,
      "MIME-Version: 1.0",
      "Content-Type: text/plain; charset=utf-8",
      "",
      m.text,
    ].join("\r\n");
    await b.send(new mod.EmailMessage(from, m.to, raw));
  }
}
