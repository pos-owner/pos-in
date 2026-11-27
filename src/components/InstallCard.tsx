import { useState } from "react";
import { useInstall } from "../lib/install";
import { I } from "./icons";

const KEY = "pos.installDismissed";

/** A dismissible hint to add pOS to the home screen. Renders nothing when installed, dismissed, or not installable. */
export function InstallCard() {
  const { standalone, ios, canPrompt, prompt } = useInstall();
  const [hidden, setHidden] = useState(() => {
    try {
      return localStorage.getItem(KEY) === "1";
    } catch {
      return false;
    }
  });
  if (standalone || hidden || (!ios && !canPrompt)) return null;
  const dismiss = () => {
    try {
      localStorage.setItem(KEY, "1");
    } catch {
      /* storage blocked: hidden until the next visit */
    }
    setHidden(true);
  };
  return (
    <section className="section">
      <div className="card tight hstack" style={{ gap: 14, alignItems: "flex-start" }}>
        <img src="/icons/icon.svg" alt="" width={44} height={44} style={{ borderRadius: 11, flex: "none" }} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="t-headline">Add pOS to your Home Screen</div>
          <div className="t-sub c2" style={{ marginTop: 2 }}>
            {ios ? (
              <>
                Tap <I.share style={{ width: 16, height: 16, verticalAlign: "-3px", color: "var(--accent)" }} /> Share,
                then <b>Add to Home Screen</b>. It opens full screen, like an app.
              </>
            ) : (
              "Install it for one-tap access and a full-screen app, with no app store needed."
            )}
          </div>
          {!ios && canPrompt && (
            <button className="btn sm mt12" onClick={() => prompt()}>
              <I.install /> Install pOS
            </button>
          )}
        </div>
        <button
          className="circle-btn plain"
          style={{ width: 30, height: 30, flex: "none" }}
          aria-label="Dismiss"
          onClick={dismiss}
        >
          <I.x style={{ width: 16, height: 16 }} />
        </button>
      </div>
    </section>
  );
}
