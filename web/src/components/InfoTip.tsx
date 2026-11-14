// A small "i" button that opens a popover with detail. Reusable for any term or step (e.g. a glossary later).
//
// Usage (do not place inside a <p>; it renders a <div>):
//   <InfoTip label="Why the 95th percentile?" title="95th percentile">
//     <p>Short explanation…</p>
//   </InfoTip>
// Props: label (accessible name, required), title? (popover heading), align? ('start' | 'end', default 'start').
// Accessible disclosure: a real button with aria-expanded/aria-controls; the popover follows it in reading
// order; Escape closes it and returns focus to the button; a click or tap outside closes it.
import { useEffect, useId, useRef, useState, type JSX, type ReactNode } from 'react';

export interface InfoTipProps {
  /** Accessible name of the button, e.g. "More about step 2: Sample". */
  label: string;
  /** Optional heading shown at the top of the popover. */
  title?: string;
  /** Which edge of the button the popover lines up with. */
  align?: 'start' | 'end';
  children: ReactNode;
}

export function InfoTip({ label, title, align = 'start', children }: InfoTipProps): JSX.Element {
  const [open, setOpen] = useState<boolean>(false);
  const id = useId();
  const wrap = useRef<HTMLDivElement>(null);
  const btn = useRef<HTMLButtonElement>(null);

  useEffect((): (() => void) | void => {
    if (!open) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return;
      setOpen(false);
      btn.current?.focus();
    };
    const onDown = (e: PointerEvent): void => {
      if (wrap.current && e.target instanceof Node && !wrap.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', onDown);
    return (): void => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('pointerdown', onDown);
    };
  }, [open]);

  return (
    <div className="infotip" ref={wrap}>
      <button
        ref={btn}
        type="button"
        className="infotip-btn"
        aria-label={label}
        aria-expanded={open}
        aria-controls={id}
        onClick={(): void => setOpen((o: boolean): boolean => !o)}
      >
        <span aria-hidden="true">i</span>
      </button>
      <div id={id} className={`infotip-pop infotip-${align}`} hidden={!open}>
        {title && <p className="infotip-title">{title}</p>}
        <div className="infotip-body">{children}</div>
      </div>
    </div>
  );
}
