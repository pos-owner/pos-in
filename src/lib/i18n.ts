/*
 * Languages. English text is the key: `t("Waiting to sync")` looks the sentence up in
 * src/i18n/hi.json and falls back to the English when there is no translation yet, so a screen is never blank and
 * translations can be added a screen at a time.
 *
 *  - `{name}` placeholders are filled from `vars`: `t("{n} entries on this phone", { n: 3 })`.
 *  - The kit components (Page, Section, Sheet, Field, Empty, TabBar, …) translate the strings they are given, so
 *    screens only call `t()` for text they render themselves.
 *  - The choice is remembered on this phone (so the first screen and signed-out screens use it) and saved on the
 *    account as `profiles.locale`; the account's value wins whenever /api/me loads.
 *  - Numbers and money use Intl with `en-IN` or `hi-IN`; both keep Latin digits and lakh grouping (₹1,25,000).
 *  - PDFs stay in English: the standard PDF fonts have no Devanagari glyphs.
 */
import { useCallback, useSyncExternalStore } from "react";
// The attribute lets Node load this module in unit tests (tests/unit/i18n.test.ts); Vite accepts it as is.
import hi from "../i18n/hi.json" with { type: "json" };

export type Locale = "en" | "hi";
type Vars = Record<string, string | number>;

/** Each language's name in its own script, for the language picker. */
export const LOCALES: { value: Locale; label: string }[] = [
  { value: "en", label: "English" },
  { value: "hi", label: "हिन्दी" },
];

const DICT: Record<Locale, Record<string, string>> = { en: {}, hi };
const STORE_KEY = "pos.locale.v1";

const isLocale = (v: unknown): v is Locale => v === "en" || v === "hi";

function remembered(): Locale {
  try {
    const v = localStorage.getItem(STORE_KEY);
    if (isLocale(v)) return v;
  } catch {
    /* storage blocked: English */
  }
  return "en";
}

let current: Locale = typeof window === "undefined" ? "en" : remembered();
const listeners = new Set<() => void>();
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

function applyToDocument() {
  if (typeof document !== "undefined") document.documentElement.lang = current === "hi" ? "hi-IN" : "en-IN";
}
applyToDocument();

export const getLocale = () => current;

/** Switches the app's language now and remembers it on this phone. */
export function setLocale(l: unknown) {
  if (!isLocale(l) || l === current) return;
  current = l;
  try {
    localStorage.setItem(STORE_KEY, l);
  } catch {
    /* only remembered for this visit */
  }
  applyToDocument();
  listeners.forEach((fn) => fn());
}

/** Translates outside React (module code, async handlers that have no hook at hand). */
export function tr(text: string, vars?: Vars, locale: Locale = current): string {
  const s = DICT[locale][text] ?? text;
  return vars ? s.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m)) : s;
}

/** Translates a string prop if it is one; anything else (an element, a number) is returned untouched. */
export function trNode<T>(v: T, locale: Locale = current): T {
  return (typeof v === "string" ? tr(v, undefined, locale) : v) as T;
}

export function useLocale(): Locale {
  return useSyncExternalStore(
    subscribe,
    () => current,
    () => current,
  );
}

/** `t(text, vars)` in the current language; screens re-render when the language changes. */
export function useT() {
  const locale = useLocale();
  return useCallback((text: string, vars?: Vars) => tr(text, vars, locale), [locale]);
}

/** The Intl locale for numbers and dates. */
export const intlLocale = (l: Locale = current) => (l === "hi" ? "hi-IN" : "en-IN");
