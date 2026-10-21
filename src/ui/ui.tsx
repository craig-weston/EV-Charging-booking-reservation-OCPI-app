import { useEffect, useId, useRef, type ReactNode, type RefObject } from "react";
import { ICONS, type IconName } from "./icon-data";
import { statusView, type StatusTone } from "../../shared/booking/labels";
import type { BookingRow, Brand } from "../../shared/model";
import { initials } from "../app/format";

export function Icon({ name, size, className = "" }: { name: IconName; size?: "sm" | "lg"; className?: string }) {
  return (
    <svg className={`icon ${size ?? ""} ${className}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {ICONS[name].map(([tag, attr], i) => {
        const Tag = tag as "path";
        return <Tag key={i} {...(attr as Record<string, string>)} />;
      })}
    </svg>
  );
}

export function Plate({ plate, size }: { plate: string; size?: "sm" | "lg" }) {
  return (
    <span className={`plate ${size ?? ""}`} aria-label={`Number plate ${plate}`}>
      <span className="uk">UK</span>
      {plate}
    </span>
  );
}

export function StatusBadge({ booking }: { booking: Pick<BookingRow, "reservation_status" | "pending_action" | "session"> }) {
  const v = statusView(booking.reservation_status, { sessionStatus: booking.session?.status, pending: !!booking.pending_action });
  return <span className={`status ${v.tone}`}>{v.label}</span>;
}

export function toneOf(booking: Pick<BookingRow, "reservation_status" | "pending_action" | "session">): StatusTone {
  return statusView(booking.reservation_status, { sessionStatus: booking.session?.status, pending: !!booking.pending_action }).tone;
}

export function BrandMark({ brand, compact }: { brand: Brand; compact?: boolean }) {
  return (
    <div className="brandmark">
      {brand.logo_url ? <img src={brand.logo_url} alt={brand.name} /> : <span className="monogram" aria-hidden="true">{brand.name.trim()[0]?.toUpperCase() ?? "H"}</span>}
      {!brand.logo_url && !compact && <span className="name">{brand.name}</span>}
    </div>
  );
}

export function Avatar({ name }: { name: string }) {
  return <span className="avatar" aria-hidden="true">{initials(name)}</span>;
}

export function Spinner({ label }: { label?: string }) {
  return <span className="spinner" role="status" aria-label={label ?? "Loading"} />;
}

export function Empty({ icon, art, title, children, action }: { icon?: IconName; art?: ReactNode; title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="empty">
      {art ?? (icon && <Icon name={icon} size="lg" />)}
      <h3>{title}</h3>
      {children && <p>{children}</p>}
      {action}
    </div>
  );
}

export function Seg<T extends string>({ value, options, onChange, label, full }: {
  value: T; options: { value: T; label: ReactNode }[]; onChange(v: T): void; label: string; full?: boolean;
}) {
  return (
    <div className={`seg ${full ? "full" : ""}`} role="group" aria-label={label}>
      {options.map((o) => (
        <button key={o.value} type="button" aria-pressed={o.value === value} onClick={() => onChange(o.value)}>{o.label}</button>
      ))}
    </div>
  );
}

export function Switch({ checked, onChange, children }: { checked: boolean; onChange(v: boolean): void; children: ReactNode }) {
  return (
    <label className="switch">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span className="track" aria-hidden="true" />
      <span>{children}</span>
    </label>
  );
}

export function Field({ label, hint, error, children }: { label: string; hint?: ReactNode; error?: string | null; children: (id: string) => ReactNode }) {
  const id = useId();
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      {children(id)}
      {error ? <span className="error-text">{error}</span> : hint ? <span className="hint">{hint}</span> : null}
    </div>
  );
}

function useEscape(onClose: () => void) {
  useEffect(() => {
    const on = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", on);
    return () => window.removeEventListener("keydown", on);
  }, [onClose]);
}

function useFocusTrap(ref: RefObject<HTMLElement | null>) {
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    const el = ref.current;
    el?.focus();
    return () => prev?.focus?.();
  }, [ref]);
}

export function Drawer({ title, sub, onClose, children, foot, head }: { title: ReactNode; sub?: ReactNode; onClose(): void; children: ReactNode; foot?: ReactNode; head?: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useEscape(onClose);
  useFocusTrap(ref);
  return (
    <>
      <div className="scrim" onClick={onClose} />
      <aside className="drawer" role="dialog" aria-modal="true" aria-label={typeof title === "string" ? title : "Details"} ref={ref} tabIndex={-1}>
        <div className="drawer-head">
          <div className="grow">
            {head}
            <h2 style={{ fontSize: "var(--fs-xl)" }}>{title}</h2>
            {sub && <div className="muted small" style={{ marginTop: 3 }}>{sub}</div>}
          </div>
          <button className="btn ghost icon-only" onClick={onClose} aria-label="Close"><Icon name="x" /></button>
        </div>
        <div className="drawer-body">{children}</div>
        {foot && <div className="drawer-foot">{foot}</div>}
      </aside>
    </>
  );
}

export function Modal({ title, onClose, children, foot, wide }: { title: string; onClose(): void; children: ReactNode; foot?: ReactNode; wide?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useEscape(onClose);
  useFocusTrap(ref);
  return (
    <>
      <div className="scrim" onClick={onClose} />
      <div className={`modal ${wide ? "wide" : ""}`} role="dialog" aria-modal="true" aria-label={title} ref={ref} tabIndex={-1}>
        <div className="modal-head">
          <h2 className="grow" style={{ fontSize: "var(--fs-xl)" }}>{title}</h2>
          <button className="btn ghost icon-only" onClick={onClose} aria-label="Close"><Icon name="x" /></button>
        </div>
        <div className="modal-body">{children}</div>
        {foot && <div className="modal-foot">{foot}</div>}
      </div>
    </>
  );
}

export function Toasts({ toasts }: { toasts: { id: number; text: string; tone: "info" | "bad" }[] }) {
  return (
    <div className="toasts" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={`toast ${t.tone === "bad" ? "bad" : ""}`} role={t.tone === "bad" ? "alert" : "status"}>
          <Icon name={t.tone === "bad" ? "alert" : "circleCheck"} size="sm" />
          <span>{t.text}</span>
        </div>
      ))}
    </div>
  );
}

export function Json({ value }: { value: unknown }) {
  return <pre className="json">{JSON.stringify(value, null, 2)}</pre>;
}

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = document.createElement("textarea");
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    return ok;
  }
}
