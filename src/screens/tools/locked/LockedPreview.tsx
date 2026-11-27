import type { ReactNode } from "react";
import { features, type FeatureKey } from "../../../lib/features";
import { Page, Section } from "../../../components/kit";
import { I, Icon, type IconName } from "../../../components/icons";
import "../../../styles/owner.css";
import { useT } from "../../../lib/i18n";

/**
 * A locked feature: real preview with sample data, what it will do, and a disabled action.
 * Flip the flag in `lib/features.ts` once the feature is built.
 */
export function LockedPreview({
  flag,
  title,
  icon,
  tone,
  summary,
  points,
  action,
  children,
}: {
  flag: FeatureKey;
  title: string;
  icon: IconName;
  tone: string;
  summary: string;
  points: string[];
  action: string;
  children: ReactNode;
}) {
  const t = useT();
  const on = features[flag];
  return (
    <Page title={title} back="/more" tabs={false}>
      <Section>
        <div className="hero lock-hero" style={{ "--tone": tone } as React.CSSProperties}>
          <div className="between" style={{ alignItems: "flex-start" }}>
            <span className="lk-ic">
              <Icon name={icon} />
            </span>
            {!on && (
              <span className="lock-badge">
                <I.lock /> {t("Coming soon")}
              </span>
            )}
          </div>
          <p className="t-body mt12" style={{ margin: "12px 0 0" }}>
            {summary}
          </p>
        </div>
      </Section>

      <Section title="Preview" footer="Sample data. Your real data appears here once this feature is switched on.">
        <div className="locked" aria-label={t("{title} preview with sample data", { title })}>
          <div className="preview" aria-hidden="true">
            {children}
          </div>
        </div>
      </Section>

      <Section title="What it will do">
        <div className="card tight">
          <ul className="bullets">
            {points.map((p) => (
              <li key={p}>
                <I.checkCircle /> {p}
              </li>
            ))}
          </ul>
        </div>
      </Section>

      <Section>
        <button className="btn" disabled aria-disabled="true">
          <I.lock /> {action}
        </button>
        <div className="t-foot c2 center-text mt8">
          {t("Part of a later update. Nothing to install, it switches on here.")}
        </div>
      </Section>
    </Page>
  );
}
