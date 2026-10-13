import React, { useEffect, useState } from 'react';
import { useSelection } from '../store/selection';
import { apiFetch } from '../client';

type UsageEntry = {
  kind: 'normalize_method' | 'normalize_function' | 'utility_function';
  qualname: string;
  module: string;
  short_name: string;
  doc?: string | null;
};

type Props = {
  apiBase: string;
  token?: string;
  // Dev Mode: the branch the graph is drawn from, so usage comes from the same code.
  branch?: string;
  // Public methods of the selected class; those not in the usage index are listed as plain methods.
  methods?: string[];
};

const kindLabel: Record<string, string> = {
  normalize_method: 'Section.normalize()',
  normalize_function: 'Normalization helper',
  utility_function: 'Utility',
  method: 'Method',
};

const UnderTheHoodPanel: React.FC<Props> = ({ apiBase, token, branch, methods = [] }) => {
  const { selected } = useSelection();
  const [usage, setUsage] = useState<UsageEntry[] | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    // reset when nothing or a quantity is selected
    if (!selected || selected.kind !== 'class') {
      setUsage(null);
      setLoading(false);
      return;
    }

    const sectionId = selected.id; // fully-qualified id from backend

    setLoading(true);
    const branchParam = branch ? `&branch=${encodeURIComponent(branch)}` : '';
    apiFetch(`/usage?section_id=${encodeURIComponent(sectionId)}${branchParam}`, {}, { baseURL: apiBase, token: token ?? '' })
      .then((res) => (res.ok ? res.json() : []))
      .then((data: UsageEntry[] | { usage?: UsageEntry[] }) => {
        const payload = Array.isArray(data) ? data : data?.usage;
        setUsage(payload ?? []);
        setLoading(false);
      })
      .catch(() => {
        setUsage([]);
        setLoading(false);
      });
  }, [selected, apiBase, token, branch]);

  const indexed = new Set((usage ?? []).map((u) => u.short_name));
  const entries = [
    ...(usage ?? []).map((u) => ({ key: u.qualname, kind: u.kind as string, name: u.short_name, module: u.module, doc: u.doc })),
    ...methods.filter((m) => !indexed.has(m)).map((m) => ({ key: `method:${m}`, kind: 'method', name: m, module: undefined, doc: undefined })),
  ];

  return (
    <div className="under-the-hood-panel">
      {!selected || selected.kind !== 'class' ? (
        <div className="uth-empty">Select a section to see its methods, normalization and utility functions.</div>
      ) : (
        <>
          <h3 className="uth-title">{selected.name}</h3>

          {loading && <p className="uth-muted">Loading…</p>}

          {!loading && usage && entries.length === 0 && (
            <p className="uth-muted">No methods, normalization or utility functions for this section.</p>
          )}

          {!loading && usage && entries.length > 0 && (
            <ul className="uth-list">
              {entries.map((u) => (
                <li key={u.key} className="uth-item">
                  <div className="uth-kind">{kindLabel[u.kind] ?? u.kind}</div>
                  <div className="uth-identifier">
                    <code className="uth-name">{u.name}</code>
                    {u.module && <span className="uth-module">{u.module}</span>}
                  </div>
                  {u.doc && <div className="uth-doc">{u.doc}</div>}
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  );
};

export default UnderTheHoodPanel;
