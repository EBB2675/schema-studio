import React from 'react';
import ReactMarkdown from 'react-markdown';
import { useSelection } from '../store/selection';

export default function DocPanel() {
  const { selected } = useSelection();

  return (
    <aside
      className="doc-panel"
      style={{
        width: 360,
        borderLeft: '1px solid #e5e7eb',
        padding: 16,
        overflow: 'auto',
        height: '100vh',
        boxSizing: 'border-box',
      }}
    >
      {!selected ? (
        <div style={{ opacity: 0.6, fontSize: 13 }}>
          Select a class or quantity to see its docstring.
        </div>
      ) : (
        <>
          <div
            style={{
              fontSize: 11,
              textTransform: 'uppercase',
              letterSpacing: 0.5,
              opacity: 0.7,
              marginBottom: 6,
            }}
          >
            {selected.kind}
          </div>
          <h2 style={{ fontSize: 18, margin: '0 0 8px 0' }}>{selected.name}</h2>
          {(selected.path || selected.line) && (
            <div style={{ fontSize: 12, opacity: 0.7, marginBottom: 12 }}>
              {selected.path}
              {selected.line ? `:${selected.line}` : ''}
            </div>
          )}
          <div className="doc-markdown" style={{ fontSize: 14, lineHeight: 1.5 }}>
            <ReactMarkdown>{selected.doc || '_No docstring available._'}</ReactMarkdown>
          </div>
        </>
      )}
    </aside>
  );
}
