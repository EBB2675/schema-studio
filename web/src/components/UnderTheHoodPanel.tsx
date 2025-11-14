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
      <h2>Under the hood</h2>

      {!selected || selected.kind !== 'class' ? (
        <p>Select a section to see normalization and utility functions.</p>
      ) : (
        <>
          <h3>{selected.name}</h3>

          {loading && <p>Loading…</p>}

          {!loading && usage && usage.length === 0 && (
            <p>No normalization or utility functions indexed for this section.</p>
          )}

          {!loading && usage && usage.length > 0 && (
            <ul>
              {usage.map((u) => (
                <li key={u.qualname} style={{ marginBottom: '0.5rem' }}>
                  <strong>{kindLabel[u.kind] ?? u.kind}</strong>
                  <br />
                  <code>{u.short_name}</code>{' '}
                  <span style={{ opacity: 0.7 }}>({u.module})</span>
                  {u.doc && (
                    <div style={{ fontSize: '0.85rem', marginTop: '0.15rem' }}>
                      {u.doc}
                    </div>
                  )}
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
