import React, { useEffect, useState } from "react";
import { listBranches, getDiff, DiffResponse } from "./api";

export default function BranchDiffBar({ onDiff }: { onDiff: (d: DiffResponse) => void }) {
  const [branches, setBranches] = useState<string[]>([]);
  const [base, setBase] = useState("");
  const [head, setHead] = useState("");
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => { listBranches().then(setBranches).catch(e => setErr(String(e))); }, []);

  const run = async () => {
    if (!base || !head) return;
    setLoading(true); setErr(null);
    try {
      const d = await getDiff(base, head);
      onDiff(d);
    } catch (e:any) {
      setErr(String(e));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={{ display: "flex", gap: 8, alignItems: "center", padding: 8 }}>
      <b>Compare</b>
      <label>Base</label>
      <select value={base} onChange={e=>setBase(e.target.value)}>
        <option value="">—</option>
        {branches.map(b => <option key={b} value={b}>{b}</option>)}
      </select>
      <label>Head</label>
      <select value={head} onChange={e=>setHead(e.target.value)}>
        <option value="">—</option>
        {branches.map(b => <option key={b} value={b}>{b}</option>)}
      </select>
      <button onClick={run} disabled={!base || !head || loading}>
        {loading ? "Comparing…" : "Compare"}
      </button>
      {err && <span style={{ color: "crimson" }}>{err}</span>}
    </div>
  );
}
