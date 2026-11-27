import { useState } from "react";
import { useApi } from "../../lib/api";
import { useAuth } from "../../lib/auth";
import { features, type FeatureKey } from "../../lib/features";
import type { Dashboard, WorkspaceResponse } from "../../lib/types";
import { Empty, Page, Row, Section } from "../../components/kit";
import { I, type IconName } from "../../components/icons";
import "../../styles/owner.css";
import { useT } from "../../lib/i18n";

/** Advanced tools behind feature flags; a locked one opens its "Soon" preview. */
export const LOCKED: { key: FeatureKey; to: string; title: string; sub: string; icon: IconName; bg: string }[] = [
  {
    key: "receipts",
    to: "/more/receipts",
    title: "Receipts & agreements",
    sub: "PDF rent receipts and rental agreements",
    icon: "receipt",
    bg: "var(--teal)",
  },
  {
    key: "meterReadings",
    to: "/more/meters",
    title: "Meter readings",
    sub: "Snap the meter, get the bill",
    icon: "gauge",
    bg: "var(--yellow)",
  },
  {
    key: "automations",
    to: "/more/automations",
    title: "Automations",
    sub: "Reading → bill → receipt → reminder",
    icon: "bolt",
    bg: "var(--purple)",
  },
  {
    key: "reports",
    to: "/more/reports",
    title: "Reports & insights",
    sub: "Income, expenses, profit, occupancy",
    icon: "chart",
    bg: "var(--pink)",
  },
];

interface HubItem {
  to: string;
  title: string;
  sub: string;
  icon: IconName;
  bg: string;
  /** Extra words people search for ("bill", "pdf", "caretaker"…). */
  words: string;
  value?: string;
  badge?: string;
  locked?: boolean;
}

/**
 * More is a utility hub, not a dumping ground: everything grouped by the job it does (money, property, people,
 * automation) and searchable, so a weekly task is two taps away.
 */
export default function More() {
  const t = useT();
  const { me } = useAuth();
  const ws = useApi<WorkspaceResponse>("/api/workspace");
  const dash = useApi<Dashboard>("/api/dashboard");
  const [q, setQ] = useState("");
  const name = me?.profile?.fullName || me?.user.email || "You";
  const units = (ws.data?.properties ?? []).reduce((s, p) => s + p.units.length, 0);
  const pending = dash.data?.pendingExpenseCount ?? 0;
  const anyLocked = LOCKED.some((f) => !features[f.key]);
  const tool = (k: FeatureKey) => {
    const f = LOCKED.find((x) => x.key === k)!;
    return { to: f.to, title: f.title, sub: f.sub, icon: f.icon, bg: f.bg, locked: !features[k] };
  };

  const groups: { title: string; items: HubItem[] }[] = [
    {
      title: "Money",
      items: [
        {
          to: "/more/expenses",
          title: "Expenses",
          sub: "Repairs, utilities and staff entries",
          icon: "wallet",
          bg: "var(--indigo)",
          words: "cost spend bill repair approve",
          badge: pending ? `${pending} to approve` : undefined,
        },
        {
          to: "/more/recurring",
          title: "Recurring expenses",
          sub: "Society maintenance, tax and regular bills",
          icon: "calendar",
          bg: "var(--orange)",
          words: "repeat monthly yearly maintenance society tax internet subscription",
        },
        { ...tool("receipts"), words: "pdf receipt agreement lease document share" },
        {
          to: "/more/statements",
          title: "Rent statements",
          sub: "Monthly, yearly and FY statements for HRA",
          icon: "receipt",
          bg: "var(--teal)",
          words: "hra pan tax statement financial year annual",
        },
        { ...tool("reports"), words: "income profit tax financial year csv export occupancy late" },
      ],
    },
    {
      title: "Property",
      items: [
        {
          to: "/more/properties",
          title: "Properties & units",
          sub: "Rent, due day and utility rates",
          icon: "building",
          bg: "var(--accent)",
          words: "flat unit house building rent address rate",
          value: ws.data ? `${ws.data.properties.length} · ${units} units` : undefined,
        },
        { ...tool("meterReadings"), words: "electricity water meter reading bill photo" },
        {
          to: "/more/qr",
          title: "Smart QR codes",
          sub: "Print a code for each unit: pay, report, read meters",
          icon: "qr",
          bg: "var(--indigo)",
          words: "qr code scan poster sticker print door",
        },
      ],
    },
    {
      title: "People",
      items: [
        {
          to: "/more/invites",
          title: "Invites & people",
          sub: "Tenants and staff join with a link and PIN",
          icon: "userPlus",
          bg: "var(--green)",
          words: "invite tenant staff caretaker join link pin qr whatsapp",
        },
      ],
    },
    {
      title: "Automation",
      items: [{ ...tool("automations"), words: "reminder whatsapp auto workflow schedule" }],
    },
    {
      title: "App",
      items: [
        {
          to: "/notifications",
          title: "Notifications",
          sub: "Payments, requests, leases and alerts",
          icon: "inbox",
          bg: "var(--red)",
          words: "alert inbox push bell notification",
        },
        {
          to: "/more/backup",
          title: "Export & backup",
          sub: "CSV exports and a full workspace backup",
          icon: "share",
          bg: "var(--green)",
          words: "export csv backup download json data",
        },
        {
          to: "/settings",
          title: "Settings",
          sub: "Profile, UPI ID, appearance, install",
          icon: "gear",
          bg: "var(--label-2)",
          words: "upi profile dark lite theme install password sign out",
        },
      ],
    },
  ];

  const s = q.trim().toLowerCase();
  const matches = s
    ? groups.flatMap((g) => g.items).filter((i) => [i.title, i.sub, i.words].some((x) => x.toLowerCase().includes(s)))
    : [];

  const line = (i: HubItem) => (
    <Row
      key={i.to}
      icon={i.icon}
      iconBg={i.bg}
      title={i.title}
      sub={i.sub}
      value={i.value}
      end={
        i.badge ? (
          <span className="pill purple">{i.badge}</span>
        ) : i.locked ? (
          <span className="lock-badge">
            <I.lock /> {t("Soon")}
          </span>
        ) : undefined
      }
      chevron
      to={i.to}
    />
  );

  return (
    <Page title="More">
      <div className="hub-search">
        <label className="search">
          <I.search />
          <input
            type="search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={t("Search tools, e.g. receipt, meter, invite")}
            aria-label={t("Search tools and settings")}
          />
        </label>
      </div>

      {s ? (
        matches.length ? (
          <Section title="Results">
            <div className="list icons">{matches.map(line)}</div>
          </Section>
        ) : (
          <Empty icon="search" title="No matches" text={t("Nothing in More matches “{q}”.", { q })} />
        )
      ) : (
        <>
          <Section>
            <div className="list">
              <Row
                avatar={name}
                title={<span className="t-headline">{name}</span>}
                sub={
                  me?.profile?.upiId
                    ? t("UPI {upiId}", { upiId: me.profile.upiId })
                    : t("Add your UPI ID so tenants can pay")
                }
                chevron
                to="/settings"
              />
            </div>
          </Section>
          {groups.map((g) => (
            <Section
              key={g.title}
              title={g.title}
              footer={
                g.title === "Automation"
                  ? anyLocked
                    ? t("Tools marked Soon are on the way. Preview them now; they switch on in a later update.")
                    : t(
                        "Receipts go out when you confirm a payment, meter bills join the rent, and reminders line up on their own.",
                      )
                  : undefined
              }
            >
              <div className="list icons">{g.items.map(line)}</div>
            </Section>
          ))}
          <div className="center-text t-foot c2" style={{ padding: "0 0 12px" }}>
            {t("pOS · v")}
            {__APP_VERSION__}
          </div>
        </>
      )}
    </Page>
  );
}
