import { useEffect, useMemo, useState } from "react";
import { DEFAULT_OVERVIEW_NAMESPACE } from "../constants/defaults";
import { apiFetch } from "../client";
import WorkbenchIcon from "./WorkbenchIcon";

type OverviewItem = { package: string; classes: string[] };
type OverviewResp = { branch: string; base: string; items: OverviewItem[] };

export default function OverviewGrid({
  branch,
  base = DEFAULT_OVERVIEW_NAMESPACE,
  onClassSelect,
  query,
  onQueryChange,
  layout = "grid",
  activePackage,
}: {
  branch: string;
  base?: string;
  onClassSelect?: (pkg: string, className: string) => void;
  // Passing the filter in keeps it when the caller leaves and comes back.
  query?: string;
  onQueryChange?: (query: string) => void;
  layout?: "grid" | "tree";
  activePackage?: string;
}) {
  const [data, setData] = useState<OverviewResp | null>(null);
  const [ownQuery, setOwnQuery] = useState("");
  const q = query ?? ownQuery;
  const setQ = onQueryChange ?? setOwnQuery;
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState<boolean>(false);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [searchCollapsed, setSearchCollapsed] = useState<{ query: string; packages: Set<string> }>({ query: "", packages: new Set() });

  useEffect(() => {
    const path = `/overview?branch=${encodeURIComponent(branch)}&base=${encodeURIComponent(base)}`;

    let cancelled = false;
    setLoading(true);
    setErr(null);
    apiFetch(path, {})
      .then(async (r) => {
        if (!r.ok) throw new Error((await r.text()) || `HTTP ${r.status}`);
        return r.json();
      })
      .then((json) => !cancelled && setData(json))
      .catch((e) => !cancelled && setErr(e.message || String(e)))
      .finally(() => !cancelled && setLoading(false));

    return () => {
      cancelled = true;
    };
  }, [branch, base]);

  const items = useMemo(() => {
    if (!data) return [];
    if (!q) return data.items;
    const qq = q.toLowerCase();
    return data.items.filter(
      (it) =>
        it.package.toLowerCase().includes(qq) ||
        it.classes.some((c) => c.toLowerCase().includes(qq))
    );
  }, [data, q]);

  if (loading) return <div className="p-2 text-sm">Loading…</div>;
  if (err) return <div className="p-2 text-sm" style={{ color: "var(--danger)" }}>{err}</div>;
  if (!data) return <div className="p-2 text-sm">No data.</div>;

  if (layout === "tree") return (
    <div className="package-tree">
      <input className="package-search" aria-label="Find package or class" placeholder="Find package or class…" value={q} onChange={e => setQ(e.target.value)} />
      <ul className="package-list">
        {items.map(it => {
          const searching = Boolean(q);
          const open = searching ? searchCollapsed.query !== q || !searchCollapsed.packages.has(it.package) : expanded.has(it.package);
          const classes = searching && !it.package.toLowerCase().includes(q.toLowerCase())
            ? it.classes.filter(c => c.toLowerCase().includes(q.toLowerCase())) : it.classes;
          return <li key={it.package}>
            <button type="button" className="package-toggle" aria-current={it.package === activePackage ? "true" : undefined} aria-expanded={open} onClick={() => {
              if (searching) {
                setSearchCollapsed(previous => {
                  const packages = new Set(previous.query === q ? previous.packages : []);
                  if (open) packages.add(it.package); else packages.delete(it.package);
                  return { query: q, packages };
                });
                return;
              }
              setExpanded(previous => {
                const next = new Set(previous);
                if (open) next.delete(it.package); else next.add(it.package);
                return next;
              });
            }}>
              <span aria-hidden="true">{open ? "▾" : "▸"}</span>
              <WorkbenchIcon name="folder" />
              <span className="package-name" title={it.package}>{it.package.split('.').pop()}</span>
              <span className="overview-count" aria-label={`${it.classes.length} classes`}>{it.classes.length}</span>
            </button>
            {open && <ul className="package-classes">{classes.map(c => <li key={c}>
              <button type="button" title={c} onClick={() => onClassSelect?.(it.package, c)}>{c}</button>
            </li>)}</ul>}
          </li>;
        })}
        {!items.length && <li className="package-empty">No packages or classes match.</li>}
      </ul>
    </div>
  );

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 12,
        height: "100%",
        minHeight: 0,
        overflow: "hidden",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
        <input
          className="overview-search"
          placeholder="Filter package or class…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        <div className="overview-meta">
          {items.length} packages • branch: {data.branch}
        </div>
      </div>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fill, minmax(min(320px, 100%), 1fr))",
          gap: 12,
          alignContent: "start",
          overflowY: "auto",
          paddingBottom: 8,
          flex: 1,
          minHeight: 0,
        }}
      >
        {items.map((it) => (
          <div
            key={it.package}
            className="overview-card"
          >
            <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
              <div
                style={{
                  fontWeight: 600,
                  fontSize: 13,
                  wordBreak: "break-word",
                }}
                title={it.package}
              >
                {it.package}
              </div>
              <div className="overview-count" title="Class count">
                {it.classes.length}
              </div>
            </div>

            <div
              style={{
                display: "flex",
                flexWrap: "wrap",
                gap: 6,
                marginTop: 10,
                maxHeight: 220,
                overflow: "auto",
              }}
            >
              {it.classes.map((c) => (
                <button
                  key={`${it.package}.${c}`}
                  type="button"
                  onClick={() => onClassSelect?.(it.package, c)}
                  className={`overview-chip${onClassSelect ? " is-clickable" : ""}`}
                  title={c}
                >
                  {c}
                </button>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
