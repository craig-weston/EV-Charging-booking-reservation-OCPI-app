// One-tap rows: a title and a one-line summary up front, the detail opens underneath. Pages keep
// their essentials in view and put everything else here, so nothing competes for attention.
import { useEffect, type ReactNode } from "react";
import { Icon } from "../ui/ui";
import type { IconName } from "../ui/icon-data";

export type MoreTone = "bad" | "warn" | "ok";

export function MoreList({ label, className, children }: { label: string; className?: string; children: ReactNode }) {
  return <section className={`panel more-list ${className ?? ""}`} aria-label={label}>{children}</section>;
}

/** `flush` lets a table or list run edge to edge instead of sitting under the title. */
export function MoreRow({ icon, title, summary, tone, id, open, flush, className, onToggle, children }: {
  icon: IconName; title: string; summary: ReactNode; tone?: MoreTone; id?: string; open?: boolean; flush?: boolean; className?: string;
  onToggle?(open: boolean): void; children: ReactNode;
}) {
  return (
    <details className={`more-row ${className ?? ""}`} id={id} open={open} onToggle={onToggle ? (e) => onToggle((e.currentTarget as HTMLDetailsElement).open) : undefined}>
      <summary>
        <span className={`more-icon ${tone ?? ""}`}><Icon name={icon} size="sm" /></span>
        <span className="grow"><b>{title}</b><span className={`more-sum ${tone ?? ""}`}>{summary}</span></span>
        <span className="more-chev" aria-hidden="true"><Icon name="chevronDown" size="sm" /></span>
      </summary>
      <div className={`more-body ${flush ? "flush" : ""}`}>{children}</div>
    </details>
  );
}

/** Printing a page prints every row open, then puts them back as they were. */
export function usePrintOpensRows() {
  useEffect(() => {
    let opened: HTMLDetailsElement[] = [];
    const before = () => {
      opened = [...document.querySelectorAll<HTMLDetailsElement>("details.more-row:not([open])")];
      for (const d of opened) d.open = true;
    };
    const after = () => { for (const d of opened) d.open = false; opened = []; };
    window.addEventListener("beforeprint", before);
    window.addEventListener("afterprint", after);
    return () => { window.removeEventListener("beforeprint", before); window.removeEventListener("afterprint", after); };
  }, []);
}
