import React, { useEffect, useState } from 'react';
import { useSelection } from '../store/selection';

type UsageEntry = {
  kind: 'normalize_method' | 'normalize_function' | 'utility_function';
  qualname: string;
  module: string;
  short_name: string;
  doc?: string | null;
};

type Props = {
  apiBase: string;
};

const kindLabel: Record<string, string> = {
  normalize_method: 'Section.normalize()',
  normalize_function: 'Normalization helper',
  utility_function: 'Utility',
};

const UnderTheHoodPanel: React.FC<Props> = ({ apiBase }) => {
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
    fetch(`${apiBase}/usage?section_id=${encodeURIComponent(sectionId)}`)
      .then((res) => (res.ok ? res.json() : []))
      .then((data: UsageEntry[]) => {
        setUsage(data);
        setLoading(false);
      })
      .catch(() => {
        setUsage([]);
        setLoading(false);
      });
  }, [selected, apiBase]);

  return (
    <div className="panel under-the-hood-panel">
      <div className="uth-header">
        <div className="meta-label">Under the hood</div>
        <div className="hint">Raw schema structure</div>
      </div>

      {!selected || selected.kind !== 'class' ? (
        <div className="uth-empty">Select a section to see normalization and utility functions.</div>
      ) : (
        <>
          <h3 className="uth-title">{selected.name}</h3>

          {loading && <p className="uth-muted">Loading…</p>}

          {!loading && usage && usage.length === 0 && (
            <p className="uth-muted">No normalization or utility functions indexed for this section.</p>
          )}

          {!loading && usage && usage.length > 0 && (
            <ul className="uth-list">
              {usage.map((u) => (
                <li key={u.qualname} className="uth-item">
                  <div className="uth-kind">{kindLabel[u.kind] ?? u.kind}</div>
                  <div className="uth-identifier">
                    <code className="uth-name">{u.short_name}</code>
                    <span className="uth-module">{u.module}</span>
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
