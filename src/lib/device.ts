/**
 * Turns a browser user agent into a short, human name for the Settings device list ("iPhone · Safari").
 * Best effort only: user agents are self-reported and often frozen, so this names the device, it doesn't prove it.
 */
interface DeviceInfo {
  /** e.g. "iPhone", "Android phone", "Mac", "Windows PC". */
  device: string;
  /** e.g. "Safari", "Chrome", "pOS app". Empty when unknown. */
  browser: string;
  /** Phones and tablets get a phone icon, everything else a computer. */
  mobile: boolean;
}

export function deviceInfo(ua: string | null | undefined): DeviceInfo {
  const s = ua ?? "";
  let device = "Unknown device";
  let mobile = false;
  if (/iPhone/.test(s)) [device, mobile] = ["iPhone", true];
  else if (/iPad/.test(s)) [device, mobile] = ["iPad", true];
  else if (/Android/.test(s)) [device, mobile] = [/Mobile/.test(s) ? "Android phone" : "Android tablet", true];
  else if (/CrOS/.test(s)) device = "Chromebook";
  else if (/Macintosh|Mac OS X/.test(s)) device = "Mac";
  else if (/Windows/.test(s)) device = "Windows PC";
  else if (/Linux/.test(s)) device = "Linux computer";
  else if (/node|curl|wget|undici/i.test(s)) device = "Script";

  // Order matters: Edge, Opera and Samsung Internet all also say "Chrome", and Chrome on iOS says "Safari".
  let browser = "";
  if (/EdgA?\/|EdgiOS\//.test(s)) browser = "Edge";
  else if (/OPR\/|Opera/.test(s)) browser = "Opera";
  else if (/SamsungBrowser\//.test(s)) browser = "Samsung Internet";
  else if (/Firefox\/|FxiOS\//.test(s)) browser = "Firefox";
  else if (/Chrome\/|CriOS\//.test(s)) browser = "Chrome";
  else if (/Safari\//.test(s)) browser = "Safari";
  return { device, browser, mobile };
}

/** "iPhone · Safari", or just "iPhone" when the browser is unknown. */
export function deviceLabel(ua: string | null | undefined): string {
  const d = deviceInfo(ua);
  return d.browser ? `${d.device} · ${d.browser}` : d.device;
}
