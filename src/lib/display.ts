/*
 * Display and accessibility preferences, kept on this device (like Lite mode in perf.ts) and applied to <html> as
 * data attributes before the first paint, so there is no flash of the wrong theme or text size. The CSS for each
 * attribute is at the end of styles/global.css.
 */
export type ThemePref = "auto" | "light" | "dark";
export type TextPref = "default" | "large" | "larger";
export interface DisplayPrefs {
  theme: ThemePref;
  text: TextPref;
  /** Stronger text, hairlines and focus rings. */
  contrast: boolean;
  /** Turn animations off, whatever the phone's setting. */
  reduceMotion: boolean;
}

const KEY = "pos.display";
const DEFAULTS: DisplayPrefs = { theme: "auto", text: "default", contrast: false, reduceMotion: false };

export function getDisplay(): DisplayPrefs {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || "{}") as Partial<DisplayPrefs>;
    return {
      theme: raw.theme === "light" || raw.theme === "dark" ? raw.theme : "auto",
      text: raw.text === "large" || raw.text === "larger" ? raw.text : "default",
      contrast: raw.contrast === true,
      reduceMotion: raw.reduceMotion === true,
    };
  } catch {
    return { ...DEFAULTS };
  }
}

export function applyDisplay(p: DisplayPrefs = getDisplay()) {
  const d = document.documentElement.dataset;
  if (p.theme === "auto") delete d.theme;
  else d.theme = p.theme;
  if (p.text === "default") delete d.text;
  else d.text = p.text;
  if (p.contrast) d.contrast = "more";
  else delete d.contrast;
  if (p.reduceMotion) d.motion = "reduce";
  else delete d.motion;
  // The browser chrome (status bar, Android task switcher) follows the chosen theme too.
  document.querySelectorAll('meta[name="theme-color"]').forEach((m) => {
    const forDark = (m.getAttribute("media") ?? "").includes("dark");
    const dark = p.theme === "auto" ? forDark : p.theme === "dark";
    m.setAttribute("content", dark ? "#000000" : "#f2f2f7");
  });
}

export function setDisplay(patch: Partial<DisplayPrefs>): DisplayPrefs {
  const next = { ...getDisplay(), ...patch };
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    /* storage blocked: applies for this visit only */
  }
  applyDisplay(next);
  return next;
}
