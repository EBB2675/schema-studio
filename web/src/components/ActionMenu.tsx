import { useRef, type ReactNode } from 'react';

/** Native disclosure with ordinary buttons: supports keyboard focus and Escape. */
export default function ActionMenu({ label, children, compact = false }: { label: string; children: ReactNode; compact?: boolean }) {
  const ref = useRef<HTMLDetailsElement>(null);
  return <details ref={ref} className="action-menu" onBlur={event => {
    if (!event.currentTarget.contains(event.relatedTarget)) event.currentTarget.open = false;
  }} onKeyDown={event => {
    if (event.key === 'Escape') {
      event.stopPropagation();
      event.currentTarget.open = false;
      event.currentTarget.querySelector('summary')?.focus();
    }
  }}>
    <summary aria-label={label}>{compact ? '···' : label}</summary>
    <div className="action-menu-items" onClick={event => {
      const button = (event.target as HTMLElement).closest('button');
      if (button && !button.disabled && ref.current) {
        ref.current.open = false;
        ref.current.querySelector('summary')?.focus();
      }
    }}>{children}</div>
  </details>;
}
