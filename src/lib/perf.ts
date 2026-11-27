/** Chooses "lite" rendering (no live blur) on phones that would struggle with it. */
export type PerfPref = "auto" | "lite" | "full";
export function getPerfPref(): PerfPref {
  try {
    const v = localStorage.getItem("pos.perf");
    return v === "lite" || v === "full" ? v : "auto";
  } catch {
    return "auto";
  }
}
function isLowEnd() {
  const n = navigator as Navigator & { deviceMemory?: number; connection?: { saveData?: boolean } };
  const cores = n.hardwareConcurrency ?? 8;
  const mem = n.deviceMemory ?? 8;
  return cores <= 4 || mem <= 3 || !!n.connection?.saveData;
}
export function applyPerf(pref = getPerfPref()) {
  const lite = pref === "lite" || (pref === "auto" && isLowEnd());
  document.documentElement.dataset.perf = lite ? "lite" : "full";
}
export function setPerfPref(p: PerfPref) {
  try {
    localStorage.setItem("pos.perf", p);
  } catch {
    /* storage blocked: applies for this visit only */
  }
  applyPerf(p);
}
/**
 * Short vibration on Android (iOS Safari ignores it). "tap" for presses, "success" when the ledger changes
 * (a confirmed payment, a sent "I have paid"), "warn" for a rejection or an error.
 */
const HAPTICS = { tap: 8, success: [12, 60, 22], warn: [30, 40, 30] } as const;
export function haptic(kind: keyof typeof HAPTICS = "tap") {
  if ("vibrate" in navigator)
    try {
      navigator.vibrate(HAPTICS[kind] as number | number[]);
    } catch {
      /* not supported */
    }
}
