import { useEffect, useState } from "react";
import { DEFAULT_OVERVIEW_NAMESPACE } from "../constants/defaults";

type OverviewItem = { package: string; classes: string[] };
type OverviewResp = { branch: string; base: string; items: OverviewItem[] };

export default function OverviewList({
  apiBase,
  branch,
  base = DEFAULT_OVERVIEW_NAMESPACE,
}: {
  apiBase: string;
  branch: string;
  base?: string;
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
    setData(null);

    fetch(url, { method: "GET" })
      .then(async (r) => {
        if (!r.ok) {
          const text = await r.text().catch(() => "");
          throw new Error(text || `HTTP ${r.status}`);
        }
        return r.json();
      })
      .then((json) => {
        if (!cancelled) setData(json);
      })
      .catch((e: unknown) => {
        if (!cancelled) {
          const msg = e instanceof Error ? e.message : String(e);
          setErr(msg);
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [apiBase, branch, base]);

  if (loading) return <div className="p-2 text-sm">Loading…</div>;
  if (err) return <div className="p-2 text-sm" style={{ color: "#b91c1c" }}>{err}</div>;
  if (!data) return <div className="p-2 text-sm">No data.</div>;

  const items = data.items.filter(
    (it) =>
      !q ||
      it.package.toLowerCase().includes(q.toLowerCase()) ||
      it.classes.some((c) => c.toLowerCase().includes(q.toLowerCase()))
  );

  return (
    <div className="flex flex-col gap-2 h-full">
      <div className="flex items-center gap-2">
        <input
          className="border rounded px-2 py-1"
          placeholder="Filter package or class…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        <div className="text-xs opacity-70">
          {items.length} packages
        </div>
      </div>
      <div className="flex-1 border rounded p-3 overflow-auto">
        {items.map((it) => (
          <details key={it.package} className="mb-2">
            <summary className="cursor-pointer font-medium">{it.package}</summary>
            <ul className="ml-4 list-disc">
              {it.classes.map((c) => (
                <li key={`${it.package}.${c}`} className="text-sm">{c}</li>
              ))}
            </ul>
          </details>
        ))}
      </div>
    </div>
  );
}
