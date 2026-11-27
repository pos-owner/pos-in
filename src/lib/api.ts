import { useEffect, useSyncExternalStore, useCallback } from "react";
import { apiUrl } from "./session";
import { browserStore, clearLaunch, readData, SNAPSHOT_KEYS, writeData } from "./launch";
import type { DocumentModel } from "../../shared/pdf/models";

export class ApiError extends Error {
  /** Machine-readable reason some endpoints add (e.g. "unusual" for a meter reading that needs confirming). */
  code?: string;
  constructor(
    message: string,
    public status: number,
    code?: string,
  ) {
    super(message);
    this.code = code;
  }
}

type Opts = { method?: string; body?: unknown; form?: FormData };

async function raw(path: string, opts: Opts): Promise<Response> {
  const headers: Record<string, string> = { "x-pos-client": "1" };
  let body: BodyInit | undefined;
  if (opts.form) body = opts.form;
  else if (opts.body !== undefined) {
    headers["content-type"] = "application/json";
    body = JSON.stringify(opts.body);
  }
  return fetch(apiUrl(path), {
    method: opts.method ?? (body ? "POST" : "GET"),
    headers,
    body,
    credentials: "same-origin",
  });
}

/** Signed photo links come back as API paths (`/api/photos/...`); `apiUrl` makes them loadable from the app. */
function absolutePhotoUrls(v: unknown): unknown {
  if (typeof v === "string") return v.startsWith("/api/photos/") ? apiUrl(v) : v;
  if (Array.isArray(v)) return v.map(absolutePhotoUrls);
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    for (const k of Object.keys(o)) o[k] = absolutePhotoUrls(o[k]);
  }
  return v;
}

/** Calls the pOS API. The session cookie goes along automatically (same origin). */
export async function api<T = unknown>(path: string, opts: Opts = {}): Promise<T> {
  let res: Response;
  try {
    res = await raw(path, opts);
  } catch {
    throw new ApiError(navigator.onLine ? "Couldn't reach pOS. Check your connection." : "You're offline.", 0);
  }
  const data = absolutePhotoUrls(await res.json().catch(() => ({})));
  if (!res.ok) {
    const d = data as { error?: string; code?: string };
    throw new ApiError(d.error ?? "Something went wrong.", res.status, d.code);
  }
  return data as T;
}

/* ---- A tiny stale-while-revalidate cache (keeps the bundle small vs. a query library) ---- */

interface Entry {
  data?: unknown;
  error?: ApiError;
  at: number;
  inflight?: Promise<void>;
  dirty?: boolean;
}
const cache = new Map<string, Entry>();
const listeners = new Map<string, Set<() => void>>();
const STALE_MS = 20_000;
/** Bumped by clearCache(): replies that were still in flight for the previous person are dropped. */
let epoch = 0;

function emit(key: string) {
  listeners.get(key)?.forEach((l) => l());
}
function load(key: string) {
  const e = cache.get(key) ?? { at: 0 };
  if (e.inflight) return e.inflight;
  const mine = epoch;
  e.dirty = false;
  e.inflight = api(key)
    .then((d) => {
      if (mine === epoch) {
        e.data = d;
        e.error = undefined;
        e.at = Date.now();
      }
    })
    .catch((err: ApiError) => {
      if (mine === epoch) {
        e.error = err;
        e.at = Date.now();
      }
    })
    .finally(() => {
      e.inflight = undefined;
      if (mine !== epoch) return; // signed out meanwhile: don't put the old person's data back in the cache
      // Something changed while this request was running, so its answer may already be out of date.
      const stale = !!e.dirty;
      if (stale) e.at = 0;
      cache.set(key, { ...e, dirty: false });
      emit(key);
      if (SNAPSHOT_KEYS.has(key)) scheduleSnapshot();
      if (stale && listeners.get(key)?.size) void load(key);
    });
  cache.set(key, e);
  return e.inflight;
}

export function useApi<T>(key: string | null) {
  const subscribe = useCallback(
    (cb: () => void) => {
      if (!key) return () => {};
      let set = listeners.get(key);
      if (!set) listeners.set(key, (set = new Set()));
      set.add(cb);
      return () => set!.delete(cb);
    },
    [key],
  );
  const entry = useSyncExternalStore(subscribe, () => (key ? cache.get(key) : undefined));
  useEffect(() => {
    if (!key) return;
    const e = cache.get(key);
    if (!e || Date.now() - e.at > STALE_MS) load(key);
  }, [key]);
  const reload = useCallback(() => (key ? load(key) : Promise.resolve()), [key]);
  return {
    data: entry?.data as T | undefined,
    error: entry?.data === undefined ? entry?.error : undefined,
    loading: !!key && entry?.data === undefined && !entry?.error,
    reload,
  };
}

/** Marks cached entries stale and refetches the ones on screen. */
export function invalidate(...prefixes: string[]) {
  for (const key of cache.keys()) {
    if (prefixes.some((p) => key.startsWith(p))) {
      const e = cache.get(key)!;
      e.at = 0;
      if (e.inflight)
        e.dirty = true; // the request already running started before this change
      else if (listeners.get(key)?.size) load(key);
    }
  }
}
export function clearCache() {
  cache.clear();
  epoch++;
  // Forget what was remembered for launch too: it belongs to the person who just left.
  snapUser = null;
  clearTimeout(snapTimer);
  snapTimer = undefined;
  clearLaunch(browserStore);
}
export function prefetch(key: string) {
  const e = cache.get(key);
  if (!e || Date.now() - e.at > STALE_MS) load(key);
}

/* ---- Last-session snapshot (see launch.ts): first screens paint from it while fresh data loads ---- */

let snapUser: string | null = null;
let snapTimer: ReturnType<typeof setTimeout> | undefined;

function saveSnapshot() {
  snapTimer = undefined;
  if (!snapUser) return;
  const data: Record<string, unknown> = {};
  for (const [key, e] of cache) if (SNAPSHOT_KEYS.has(key) && e.data !== undefined) data[key] = e.data;
  writeData(browserStore, snapUser, data);
}
function scheduleSnapshot() {
  if (snapUser && snapTimer === undefined) snapTimer = setTimeout(saveSnapshot, 500);
}
/** Writes any pending snapshot now; the phone can freeze or close the app without warning. */
function flushSnapshot() {
  if (snapTimer === undefined) return;
  clearTimeout(snapTimer);
  saveSnapshot();
}
if (typeof document !== "undefined") {
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") flushSnapshot();
  });
  addEventListener("pagehide", flushSnapshot);
}

/**
 * Fills the cache from the last session's snapshot for this person and starts remembering new replies. Restored
 * entries count as stale (`at: 0`), so every screen shows them instantly and still refetches.
 */
export function restoreSnapshot(uid: string) {
  snapUser = uid;
  for (const [key, data] of Object.entries(readData(browserStore, uid))) {
    if (!cache.has(key)) cache.set(key, { data, at: 0 });
  }
}

/** Opens the connection to the Worker while the app is still starting. `/api/health` needs no sign-in. */
export function warmApi() {
  fetch(apiUrl("/api/health"), { credentials: "omit", cache: "no-store" }).catch(() => {
    /* only a head start: the real requests report their own errors */
  });
}

/* ---- PDFs (receipts, agreements, reports) ---- */

/**
 * `path` is a document data route (`….json`). The API sends the document's data and the PDF is drawn here, in the
 * browser (see src/lib/pdf.ts), which keeps the Worker inside Cloudflare's free-plan CPU limit.
 */
async function fetchFile(path: string): Promise<Blob> {
  const model = await api<DocumentModel>(path);
  try {
    const { renderPdf } = await import("./pdf");
    return await renderPdf(model);
  } catch (e) {
    console.error("PDF drawing failed", e);
    throw new ApiError(navigator.onLine ? "Couldn't prepare the PDF. Try again." : "You're offline.", 0);
  }
}

function saveBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

/**
 * Shares a PDF through the phone's share sheet (WhatsApp, Mail, Files…) where supported,
 * otherwise downloads it. Returns "shared", "downloaded" or "cancelled".
 */
export async function sharePdf(
  path: string,
  filename: string,
  title: string,
): Promise<"shared" | "downloaded" | "cancelled"> {
  const blob = await fetchFile(path);
  const file = new File([blob], filename, { type: "application/pdf" });
  if (navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title });
      return "shared";
    } catch (e) {
      if ((e as Error).name === "AbortError") return "cancelled";
    }
  }
  saveBlob(blob, filename);
  return "downloaded";
}

export async function downloadPdf(path: string, filename: string) {
  saveBlob(await fetchFile(path), filename);
}

/**
 * Opens a PDF in a new tab. The file is fetched first and shown from a blob URL, so an expired session shows a
 * message in the app instead of a JSON error page in a new tab. Pass a tab opened synchronously in
 * the click handler (`window.open("", "_blank")`), because browsers block tabs opened after an await. Without one
 * (pop-ups blocked), the PDF is downloaded instead.
 */
export async function openPdf(path: string, filename: string, tab: Window | null): Promise<"opened" | "downloaded"> {
  let blob: Blob;
  try {
    blob = await fetchFile(path);
  } catch (e) {
    tab?.close();
    throw e;
  }
  if (!tab || tab.closed) {
    saveBlob(blob, filename);
    return "downloaded";
  }
  const url = URL.createObjectURL(blob);
  tab.location.href = url;
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
  return "opened";
}
