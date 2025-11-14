import React from 'react';
import { useSelection } from '../store/selection';

const kindLabel: Record<string, string> = {
  normalize_method: 'Section.normalize()',
  normalize_function: 'Normalization helper',
  utility_function: 'Utility',
};

const UnderTheHoodPanel: React.FC = () => {
  const { selected, usage, loadingUsage } = useSelection();

  return (
    <div className="panel under-the-hood-panel">
      <h2>Under the hood</h2>

      {!selected || selected.kind !== 'class' ? (
        <p>Select a section to see normalization and utility functions.</p>
      ) : (
        <>
          <h3>{selected.name}</h3>

          {loadingUsage && <p>Loading…</p>}

          {!loadingUsage && usage && usage.length === 0 && (
            <p>No normalization or utility functions indexed for this section.</p>
          )}

          {!loadingUsage && usage && usage.length > 0 && (
            <ul>
              {usage.map((u) => (
                <li key={u.qualname} style={{ marginBottom: '0.5rem' }}>
                  <strong>{kindLabel[u.kind] ?? u.kind}</strong>
                  <br />
                  <code>{u.short_name}</code>{' '}
                  <span style={{ opacity: 0.7 }}>({u.module})</span>
                  {u.doc && (
                    <div
                      style={{
                        fontSize: '0.85rem',
                        marginTop: '0.15rem',
                      }}
                    >
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
