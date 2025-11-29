import { useState, type ReactNode } from "react";

interface CollapsibleSectionProps {
  title: string;
  hint?: string;
  children: ReactNode;
  defaultOpen?: boolean;
  className?: string;
}

export default function CollapsibleSection({
  title,
  hint,
  children,
  defaultOpen = false,
  className = "",
}: CollapsibleSectionProps) {
  const [open, setOpen] = useState(defaultOpen);

  return (
    <div className={`section collapsible ${className}`.trim()}>
      <button
        type="button"
        className="collapsible-header"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <div className="section-title">
          <span>{title}</span>
          {hint ? <span className="hint">{hint}</span> : null}
        </div>
        <span className={`chevron ${open ? "open" : ""}`} aria-hidden>
          ▾
        </span>
      </button>

      <div className="collapsible-body" style={{ display: open ? "block" : "none" }}>
        {children}
      </div>
    </div>
  );
}
