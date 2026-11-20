import { useEffect, useState } from "react";

export type MobilePanel = "workspace" | "details" | "tools" | null;
const FOCUSABLE = 'button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), summary, [tabindex="0"]';

/** Mobile drawers share one modal layer; desktop panel sizes and collapse state stay independent. */
export function useMobilePanels(enabled: boolean) {
  const [isMobile, setMobile] = useState(() => enabled && typeof matchMedia === "function" && matchMedia("(max-width: 900px)").matches);
  const [panel, setPanel] = useState<MobilePanel>(null);
  useEffect(() => {
    if (!enabled || typeof matchMedia !== "function") return;
    const query = matchMedia("(max-width: 900px)");
    const update = () => { setMobile(query.matches); if (!query.matches) setPanel(null); };
    update(); query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, [enabled]);

  useEffect(() => {
    if (!isMobile || !panel) return;
    const previous = document.activeElement as HTMLElement | null;
    const dialog = document.querySelector<HTMLElement>(`[data-mobile-panel="${panel}"]`);
    if (!dialog) return;
    const items = () => [...dialog.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(el => el.getClientRects().length && !el.closest('[inert]'));
    const frame = requestAnimationFrame(() => (items()[0] ?? dialog).focus());
    const keydown = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); setPanel(null); }
      if (event.key !== "Tab") return;
      const focusable = items();
      const first = focusable[0]; const last = focusable.at(-1);
      if (!first) { event.preventDefault(); dialog.focus(); return; }
      if (!dialog.contains(document.activeElement) || (event.shiftKey && document.activeElement === first)) { event.preventDefault(); (event.shiftKey ? last : first)?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener("keydown", keydown);
    return () => {
      cancelAnimationFrame(frame); document.removeEventListener("keydown", keydown);
      if (previous?.isConnected) previous.focus();
    };
  }, [isMobile, panel]);
  return { isMobile, mobilePanel: panel, setMobilePanel: setPanel };
}
