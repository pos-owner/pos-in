import { useState } from "react";
import { Section, Segmented, Toggle } from "../../../components/kit";
import { getDisplay, setDisplay, type DisplayPrefs } from "../../../lib/display";
import { useT } from "../../../lib/i18n";

/** Theme, text size, contrast and motion. Saved on this device only; applies instantly. */
export default function DisplaySection() {
  const t = useT();
  const [p, setP] = useState<DisplayPrefs>(getDisplay);
  const set = (patch: Partial<DisplayPrefs>) => setP(setDisplay(patch));
  return (
    <Section
      title="Display & accessibility"
      footer="Saved on this device. Bigger text scales every screen, receipts and amounts included."
    >
      <div className="display-group">
        <span className="display-label">{t("Theme")}</span>
        <Segmented
          label="Theme"
          value={p.theme}
          onChange={(theme) => set({ theme })}
          options={[
            { value: "auto", label: "Auto" },
            { value: "light", label: "Light" },
            { value: "dark", label: "Dark" },
          ]}
        />
      </div>
      <div className="display-group">
        <span className="display-label">{t("Text size")}</span>
        <Segmented
          label="Text size"
          value={p.text}
          onChange={(text) => set({ text })}
          options={[
            { value: "default", label: "Default" },
            { value: "large", label: "Large" },
            { value: "larger", label: "Larger" },
          ]}
        />
      </div>
      <div className="list mt12">
        <Toggle
          label="Higher contrast"
          sub="Darker secondary text, visible borders and underlined links"
          checked={p.contrast}
          onChange={(contrast) => set({ contrast })}
        />
        <Toggle
          label="Reduce motion"
          sub="Turns off sliding sheets and animated effects"
          checked={p.reduceMotion}
          onChange={(reduceMotion) => set({ reduceMotion })}
        />
      </div>
    </Section>
  );
}
