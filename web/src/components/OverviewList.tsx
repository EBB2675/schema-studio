import { useEffect, useState } from "react";

type OverviewItem = { package: string; classes: string[] };
type OverviewResp = { branch: string; base: string; items: OverviewItem[] };

export default function OverviewList({
  branch,
  base = "nomad_simulations.schema_packages",
}: {
  branch: string;
  base?: string;
}) {
  const [data, setData] = useState<OverviewResp | null>(null);
  const [q, setQ] = useState("");

  useEffect(() => {
    const url = `/overview?branch=${encodeURIComponent(branch)}&base=${encodeURIComponent(base)}`;
    fetch(url).then(r => r.json()).then(setData).catch(() => setData(null));
  }, [branch, base]);

  if (!data) return <div className="p-2 text-sm">Loading…</div>;

  const items = data.items.filter(it =>
    !q ||
    it.package.toLowerCase().includes(q.toLowerCase()) ||
    it.classes.some(c => c.toLowerCase().includes(q.toLowerCase()))
  );

  return (
    <div className="flex flex-col gap-2 h-full">
      <div className="flex items-center gap-2">
        <input
          className="border rounded px-2 py-1"
          placeholder="Filter package or class…"
          value={q}
          onChange={e => setQ(e.target.value)}
        />
        <div className="text-xs opacity-70">
          {items.length} packages
        </div>
      </div>
      <div className="flex-1 border rounded p-3 overflow-auto">
        {items.map(it => (
          <details key={it.package} className="mb-2">
            <summary className="cursor-pointer font-medium">{it.package}</summary>
            <ul className="ml-4 list-disc">
              {it.classes.map(c => <li key={c} className="text-sm">{c}</li>)}
            </ul>
          </details>
        ))}
      </div>
    </div>
  );
}
