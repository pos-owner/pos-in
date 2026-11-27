/**
 * A rough, human place name for a sign-in, from the geolocation Cloudflare attaches to every request
 * (`request.cf.city`, `.region`, `.country`). It comes from the IP address, so it's only a hint for spotting an
 * unfamiliar device ("Pune, India"), never proof of where someone is. Pure: no bindings, no database.
 */
export interface CfGeo {
  city?: unknown;
  region?: unknown;
  country?: unknown;
}

const MAX = 80;
const part = (v: unknown) => (typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, 40) : "");

let countries: Intl.DisplayNames | null | undefined;
function countryName(code: string): string {
  if (!/^[A-Z]{2}$/.test(code) || code === "XX" || code === "T1") return ""; // unknown / Tor
  if (countries === undefined) {
    try {
      countries = new Intl.DisplayNames(["en"], { type: "region" });
    } catch {
      countries = null;
    }
  }
  return countries?.of(code) ?? code;
}

/** "Pune, India"; "Maharashtra, India" without a city; "India" with only a country; "" when nothing is known. */
export function locationLabel(cf: CfGeo | null | undefined): string {
  if (!cf) return "";
  const country = countryName(part(cf.country).toUpperCase());
  const place = part(cf.city) || part(cf.region);
  return [place, country]
    .filter(Boolean)
    .filter((v, i, all) => all.indexOf(v) === i)
    .join(", ")
    .slice(0, MAX);
}
