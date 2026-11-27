import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { registerSW } from "virtual:pwa-register";
import App from "./App";
import { warmApi } from "./lib/api";
import { applyPerf } from "./lib/perf";
import { applyDisplay } from "./lib/display";
import "./styles/global.css";

applyPerf();
applyDisplay();
// Start waking the API now so its cold start overlaps with the app starting, not with the first request.
warmApi();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

/**
 * Register the service worker once the first screen has had time to load, so an update check or a precache
 * download never competes with launch for the phone's connection. The installed app still opens from the cache.
 */
function registerLater() {
  setTimeout(() => registerSW({ immediate: true }), 1500);
}
if (document.readyState === "complete") registerLater();
else addEventListener("load", registerLater, { once: true });
