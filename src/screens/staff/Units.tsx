import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useApi } from "../../lib/api";
import { features } from "../../lib/features";
import { telLink } from "../../lib/links";
import type { WorkspaceResponse } from "../../lib/types";
import { Avatar, Empty, ErrorState, NavButton, Page, Section, Skeleton } from "../../components/kit";
import { I } from "../../components/icons";
import "../../styles/ops.css";
import { useT } from "../../lib/i18n";

export default function Units() {
  const tx = useT();
  const { data, error, loading, reload } = useApi<WorkspaceResponse>("/api/workspace");
  const [q, setQ] = useState("");
  const nav = useNavigate();

  const props = useMemo(() => {
    const s = q.trim().toLowerCase();
    return (data?.properties ?? [])
      .map((p) => ({
        ...p,
        units: p.units.filter(
          (u) => !s || [u.label, u.type, u.tenancy?.tenantName ?? "", p.name].some((x) => x.toLowerCase().includes(s)),
        ),
      }))
      .filter((p) => p.units.length);
  }, [data, q]);

  const all = (data?.properties ?? []).flatMap((p) => p.units);
  const occupied = all.filter((u) => u.tenancy).length;

  return (
    <Page
      title="Units"
      eyebrow={data ? tx("{occupied} of {n} occupied", { occupied, n: all.length }) : undefined}
      right={<NavButton icon="gear" label="Settings" onClick={() => nav("/settings")} />}
    >
      {all.length > 4 && (
        <div className="pad mb16">
          <label className="search">
            <I.search />
            <input
              type="search"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder={tx("Search units or tenants")}
              aria-label={tx("Search units or tenants")}
            />
          </label>
        </div>
      )}
      {loading ? (
        <Section>
          <Skeleton rows={5} />
        </Section>
      ) : error || !data ? (
        <ErrorState error={error ?? { message: "Couldn't load units." }} retry={reload} />
      ) : !data.properties.length ? (
        <Empty
          icon="building"
          title="No properties yet"
          text="When the owner adds properties and units, they'll appear here."
        />
      ) : !props.length ? (
        <Empty icon="search" title="No matches" text={tx("Nothing matches “{q}”.", { q })} />
      ) : (
        props.map((p) => (
          <Section key={p.id} title={p.name} footer={p.address || undefined}>
            <div className="list">
              {p.units.map((u) => {
                const t = u.tenancy;
                const main = (
                  <>
                    {t ? (
                      <Avatar name={t.tenantName} />
                    ) : (
                      <span
                        className="icon-sq"
                        style={{
                          background: "var(--fill)",
                          color: "var(--label-2)",
                          width: 40,
                          height: 40,
                          borderRadius: 20,
                        }}
                      >
                        <I.key />
                      </span>
                    )}
                    <span className="grow">
                      <span className="title" style={{ display: "block" }}>
                        {u.label}
                      </span>
                      <span className="sub" style={{ display: "block" }}>
                        {u.type}
                        {t ? ` · ${t.tenantName}` : ""}
                      </span>
                    </span>
                  </>
                );
                return (
                  <div className="row" key={u.id} style={{ padding: 0 }}>
                    {t ? (
                      <button
                        type="button"
                        className="row"
                        style={{ flex: 1, minWidth: 0 }}
                        onClick={() => nav(`/tenants/${t.tenantId}`)}
                        aria-label={`${u.label}, ${t.tenantName}`}
                      >
                        {main}
                      </button>
                    ) : (
                      <div className="row" style={{ flex: 1, minWidth: 0 }}>
                        {main}
                        <span className="pill gray">{tx("Vacant")}</span>
                      </div>
                    )}
                    <span className="unit-actions">
                      {features.meterReadings && t && (
                        <button
                          type="button"
                          className="circle-btn plain"
                          aria-label={tx("Scan meter for {label}", { label: u.label })}
                          onClick={() => nav(`/meters?unit=${u.id}`)}
                        >
                          <I.camera />
                        </button>
                      )}
                      <button
                        type="button"
                        className="circle-btn plain"
                        aria-label={tx("Log expense for {label}", { label: u.label })}
                        onClick={() => nav(`/expenses?new=1&property=${p.id}&note=${encodeURIComponent(u.label)}`)}
                      >
                        <I.wallet />
                      </button>
                      {t?.tenantPhone && (
                        <a
                          className="circle-btn plain"
                          href={telLink(t.tenantPhone)}
                          aria-label={tx("Call {tenantName}", { tenantName: t.tenantName })}
                        >
                          <I.phone />
                        </a>
                      )}
                    </span>
                  </div>
                );
              })}
            </div>
          </Section>
        ))
      )}
    </Page>
  );
}
