import { useEffect, useMemo, useState } from "react";

type OverviewItem = { package: string; classes: string[] };
type OverviewResp = { branch: string; base: string; items: OverviewItem[] };

const DEFAULT_OVERVIEW_BASE =
  import.meta.env.VITE_DEFAULT_NAMESPACE ??
  "nomad_simulations.schema_packages,nomad_measurements";

export default function OverviewGrid({
  apiBase,
  branch,
  base = DEFAULT_OVERVIEW_BASE,
  token,
  onClassSelect,
}: {
  apiBase: string;
  branch: string;
  base?: string;
  token?: string;
  onClassSelect?: (pkg: string, className: string) => void;
}) {
  const [data, setData] = useState<OverviewResp | null>(null);
  const [q, setQ] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState<boolean>(false);

  useEffect(() => {
    const url =
      `${apiBase.replace(/\/$/, "")}` +
      `/overview?branch=${encodeURIComponent(branch)}&base=${encodeURIComponent(base)}`;

    let cancelled = false;
    setLoading(true);
    setErr(null);
    const headers: HeadersInit = token ? { Authorization: `Bearer ${token}` } : {};
    fetch(url, { headers })
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
  }, [apiBase, branch, base, token]);

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
  if (err) return <div className="p-2 text-sm" style={{ color: "#b91c1c" }}>{err}</div>;
  if (!data) return <div className="p-2 text-sm">No data.</div>;

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

      {/* responsive grid */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fill, minmax(320px, 1fr))",
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

            {/* class chips */}
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
