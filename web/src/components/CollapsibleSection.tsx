import { useMemo, useState, type ReactNode } from "react";

interface CollapsibleSectionProps {
  title: string;
  hint?: string;
  children: ReactNode;
  defaultOpen?: boolean;
  className?: string;
  open?: boolean;
  onToggle?: (open: boolean) => void;
  id?: string;
}

export default function CollapsibleSection({
  title,
  hint,
  children,
  defaultOpen = false,
  className = "",
  open: controlledOpen,
  onToggle,
  id,
}: CollapsibleSectionProps) {
  const [uncontrolledOpen, setUncontrolledOpen] = useState(defaultOpen);

  const open = useMemo(() => {
    if (typeof controlledOpen === "boolean") return controlledOpen;
    return uncontrolledOpen;
  }, [controlledOpen, uncontrolledOpen]);

  const bodyId = id ? `${id}-body` : undefined;

  const toggle = () => {
    const next = !open;
    if (typeof controlledOpen !== "boolean") {
      setUncontrolledOpen(next);
    }
    onToggle?.(next);
  };

  return (
    <div className={`section collapsible ${className}`.trim()} id={id}>
      <button
        type="button"
        className="collapsible-header"
        onClick={toggle}
        aria-expanded={open}
        aria-controls={bodyId}
      >
        <div className="section-title">
          <span>{title}</span>
          {hint ? <span className="hint">{hint}</span> : null}
        </div>
        <span className={`chevron ${open ? "open" : ""}`} aria-hidden>
          ▾
        </span>
      </button>

      <div className="collapsible-body" id={bodyId} style={{ display: open ? "block" : "none" }}>
        {children}
      </div>
    </div>
  );
}
